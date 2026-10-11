// SPDX-License-Identifier: AGPL-3.0-only
/**
 * MCP Batch Coordinator (issue #989 follow-up)
 *
 * Server-side worker that reconciles a session's *desired* MCP state with
 * its *current* MCP state. Replaces the previous client-side for-loop
 * which paused when iOS suspended the PWA tab. By living in the server,
 * the loop completes regardless of client foreground state.
 *
 * Reconciliation is declarative (state-based, not operation-based):
 *   pending = { name | desired[name] !== current[name] }
 *
 * This means a counter-batch (e.g. user enables all, then mid-batch disables
 * all) naturally drops items whose new desired matches their current state —
 * no double-toggling. Same pattern as Kubernetes reconciliation.
 */

import type {
  McpBatchOutcome,
  McpBatchSnapshot,
  McpToggleResponse,
} from "@hapi/protocol/types";

/** Minimum delay between successive toggle RPCs to avoid stdin pressure. */
export const MCP_BATCH_TOGGLE_DELAY_MS = 500;

/** Maximum failures per server before we give up on it. */
const MAX_FAILURES_PER_SERVER = 3;

/**
 * Inputs the coordinator needs from the host environment. Kept as an
 * interface so the coordinator is unit-testable without a real SyncEngine.
 */
export interface McpBatchCoordinatorDeps {
  /**
   * Returns a Map<serverName, isEnabled> reflecting the current MCP state
   * for the project the session lives in. Names not in the map are
   * "unknown" — the coordinator does NOT toggle them.
   */
  getCurrentState: (sessionId: string) => Map<string, boolean>;

  /** Dispatch a single MCP toggle. Returns the upstream toggle response. */
  toggle: (
    sessionId: string,
    serverName: string,
    enabled: boolean
  ) => Promise<McpToggleResponse>;

  /**
   * Emit a snapshot to whatever pub-sub channel the host wants to forward
   * it to (SSE, listeners, etc). The coordinator does not own broadcast.
   */
  publish: (snapshot: McpBatchSnapshot) => void;

  /** Wall-clock now() — overridable for tests. */
  now?: () => number;

  /** Sleep — overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

interface InternalState {
  desired: Map<string, boolean>;
  done: Map<string, McpBatchOutcome>;
  optimistic: Map<string, boolean>;
  failures: Map<string, number>;
  processing: string | null;
  startedAt: number;
  workerActive: boolean;
}

export class McpBatchCoordinator {
  private readonly states = new Map<string, InternalState>();
  private readonly deps: Required<McpBatchCoordinatorDeps>;

  constructor(deps: McpBatchCoordinatorDeps) {
    this.deps = {
      getCurrentState: deps.getCurrentState,
      toggle: deps.toggle,
      publish: deps.publish,
      now: deps.now ?? (() => Date.now()),
      sleep: deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms))),
    };
  }

  /** Return the current snapshot for a session, or null if no batch ever started. */
  getSnapshot(sessionId: string): McpBatchSnapshot | null {
    const state = this.states.get(sessionId);
    if (!state) return null;
    return this.snapshot(sessionId, state);
  }

  /**
   * Merge a partial desired state into the session's batch and (re)start
   * the worker if there is now work to do. Returns the snapshot after the
   * merge — the worker may pick up additional iterations asynchronously.
   */
  setDesired(
    sessionId: string,
    partialDesired: Record<string, boolean>
  ): McpBatchSnapshot {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        desired: new Map(),
        done: new Map(),
        optimistic: new Map(),
        failures: new Map(),
        processing: null,
        startedAt: this.deps.now(),
        workerActive: false,
      };
      this.states.set(sessionId, state);
    }

    let dirty = false;
    for (const [name, enabled] of Object.entries(partialDesired)) {
      const prior = state.desired.get(name);
      if (prior !== enabled) {
        state.desired.set(name, enabled);
        // Clear prior history for this name — the user has explicitly
        // re-stated their wish, so the slate is clean.
        state.done.delete(name);
        state.failures.delete(name);
        dirty = true;
      }
    }
    if (dirty) {
      state.startedAt = this.deps.now();
    }

    const snap = this.snapshot(sessionId, state);
    this.deps.publish(snap);

    // Kick the worker if it's not already running.
    if (
      !state.workerActive &&
      this.computePending(sessionId, state).length > 0
    ) {
      this.runWorker(sessionId, state);
    }

    return snap;
  }

  /**
   * Compute pending = { name | current[name] !== desired[name] }, accounting
   * for our optimistic overlay (toggles we've already issued whose effect
   * may not yet be reflected in mcpStatus).
   */
  private computePending(
    sessionId: string,
    state: InternalState
  ): { name: string; enabled: boolean }[] {
    const baseCurrent = this.deps.getCurrentState(sessionId);
    const result: { name: string; enabled: boolean }[] = [];
    for (const [name, want] of state.desired) {
      const current = state.optimistic.has(name)
        ? state.optimistic.get(name)!
        : baseCurrent.get(name);
      // Skip names not present in current state (unknown / removed servers).
      if (current === undefined) continue;
      if (current === want) continue;
      // Skip names that have failed too many times — surface the error and stop.
      if ((state.failures.get(name) ?? 0) >= MAX_FAILURES_PER_SERVER) continue;
      result.push({ name, enabled: want });
    }
    // Stable ordering — alphabetical so a long batch is predictable.
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
  }

  private snapshot(sessionId: string, state: InternalState): McpBatchSnapshot {
    const desired: Record<string, boolean> = {};
    for (const [k, v] of state.desired) desired[k] = v;

    const done: Record<string, McpBatchOutcome> = {};
    for (const [k, v] of state.done) done[k] = v;

    const pending = this.computePending(sessionId, state).map(p => p.name);

    const total =
      Object.keys(done).length + pending.length + (state.processing ? 1 : 0);
    const remaining = pending.length + (state.processing ? 1 : 0);

    return {
      sessionId,
      desired,
      done,
      pending,
      processing: state.processing,
      total,
      remaining,
      startedAt: state.startedAt,
      isActive: state.workerActive,
    };
  }

  /**
   * Record a failed toggle attempt. Increments the per-server failure
   * counter and returns either:
   *   • a transient failure outcome (count below threshold), or
   *   • the abandoned outcome (count at/above MAX_FAILURES_PER_SERVER).
   *
   * Both call sites in runWorker — the toggle-returned-ok-false path and
   * the toggle-threw path — share this helper so the threshold check lives
   * in exactly one place. The abandoned outcome IS the last outcome the
   * UI sees for the server until the user re-issues setDesired (which
   * clears state.failures and the abandoned outcome together).
   */
  private recordFailure(
    state: InternalState,
    name: string,
    error: string,
    code: string
  ): McpBatchOutcome {
    const newFailures = (state.failures.get(name) ?? 0) + 1;
    state.failures.set(name, newFailures);

    if (newFailures >= MAX_FAILURES_PER_SERVER) {
      return {
        ok: false,
        abandoned: true,
        error,
        code: "max_retries_exceeded",
        attempts: newFailures,
      };
    }
    return { ok: false, error, code };
  }

  private async runWorker(
    sessionId: string,
    state: InternalState
  ): Promise<void> {
    state.workerActive = true;
    this.deps.publish(this.snapshot(sessionId, state));

    try {
      while (true) {
        const pending = this.computePending(sessionId, state);
        if (pending.length === 0) break;

        const next = pending[0];
        state.processing = next.name;
        this.deps.publish(this.snapshot(sessionId, state));

        let outcome: McpBatchOutcome;
        try {
          const result = await this.deps.toggle(
            sessionId,
            next.name,
            next.enabled
          );
          if (result.ok) {
            outcome = { ok: true };
            // Optimistic overlay so the next iteration doesn't re-pick this
            // server before mcpStatus refreshes.
            state.optimistic.set(next.name, next.enabled);
          } else {
            outcome = this.recordFailure(
              state,
              next.name,
              result.error,
              result.code
            );
          }
        } catch (err) {
          outcome = this.recordFailure(
            state,
            next.name,
            err instanceof Error ? err.message : String(err),
            "transport_failed"
          );
        }

        state.done.set(next.name, outcome);
        state.processing = null;
        this.deps.publish(this.snapshot(sessionId, state));

        // If the desired state changed mid-iteration the next computePending
        // call will reflect it — no special handling needed.

        // Inter-iteration delay only if there's more work to do.
        const stillPending = this.computePending(sessionId, state);
        if (stillPending.length > 0) {
          await this.deps.sleep(MCP_BATCH_TOGGLE_DELAY_MS);
        }
      }
    } finally {
      state.workerActive = false;
      state.processing = null;
      this.deps.publish(this.snapshot(sessionId, state));
    }
  }

  /** Forget a session's batch state (e.g. on session removal). */
  clear(sessionId: string): void {
    this.states.delete(sessionId);
  }
}
