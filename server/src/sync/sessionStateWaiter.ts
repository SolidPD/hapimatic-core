// SPDX-License-Identifier: AGPL-3.0-only
import type { Session, SyncEvent } from "@hapi/protocol/types";
import type { SyncEventListener } from "./eventPublisher";

/**
 * Issue #3816: the wait-until-state primitive.
 *
 * `waitForSessionState` blocks a caller until a target session reaches a named
 * state, or until a timeout expires. It backs
 * `GET /api/sessions/:id/wait-until/:state` (decision 3816-D1 = A), so an
 * orchestrator can stop polling a peer on a cadence.
 *
 * Design (pattern: `queueDrainObserver.ts`):
 *   - Subscribe FIRST, then evaluate the current snapshot (level trigger), so a
 *     target already in the state matches and a transition between the read and
 *     the subscribe cannot be lost (the #3235 wedge class).
 *   - Each event for the target is a wake-up only: the state is re-read with
 *     `engine.getSession`, never from `event.data`, because `session-updated`
 *     payloads are partial deltas.
 *   - `idle` must hold continuously for `IDLE_SETTLE_MS` before it matches.
 *     Right after a caller sends work the target still reads `!thinking` until
 *     its CLI reports the new turn, so a pure level check would match too early.
 *     A caller that has just sent work waits `busy` first, then `idle`.
 *   - `completed` keys on the CLI's archived lifecycle (or the session going
 *     away), never on `active:false`: inactivity expiry and reactivation flip
 *     `active` on a live session.
 *   - Every exit (match, timeout, abort) unsubscribes exactly once and clears
 *     both timers.
 *
 * Same-node only: the route answers 409 `federation_unsupported` for a session
 * another node owns, so the caller falls back to polling.
 */

/** The states a caller can wait for (the `:state` path segment). */
export const WAIT_STATES = [
  "idle",
  "busy",
  "blocked",
  "rate-limited",
  "completed",
  "errored",
] as const;

export type WaitState = (typeof WAIT_STATES)[number];

/**
 * The target's current state as the waiter sees it. `inactive` is a known
 * session that is neither running nor archived (e.g. disconnected); `unknown`
 * is a session the waiter never resolved.
 */
export type DerivedSessionState = WaitState | "inactive" | "unknown";

/** How long `idle` must hold before it matches. Above the 2 s keepAlive tick. */
export const IDLE_SETTLE_MS = 3_000;

/**
 * The longest a single wait may block. Below every transport bound on the path:
 * Bun's `idleTimeout` (at least 30 s, `web/server.ts`), the `hapi api` client,
 * and a `hapi_call` dispatch, which carries no caller abort signal.
 */
export const WAIT_MAX_TIMEOUT_MS = 25_000;

/** The `SyncEngine` slice the waiter needs (keeps it testable with a fake). */
export interface SessionStateWaiterEngine {
  subscribe(listener: SyncEventListener): () => void;
  getSession(sessionId: string): Session | undefined;
  listQueuedMessages(sessionId: string, namespace: string): unknown[];
}

export interface WaitForSessionStateOptions {
  sessionId: string;
  namespace: string;
  state: WaitState;
  /** Clamped to `[0, WAIT_MAX_TIMEOUT_MS]`; absent or not finite means the max. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam; defaults to `IDLE_SETTLE_MS`. */
  settleMs?: number;
}

export interface WaitForSessionStateResult {
  /** `aborted` only when the caller's signal fired (the caller has gone). */
  result: "matched" | "timeout" | "aborted";
  state: DerivedSessionState;
  sessionId: string;
}

export function isWaitState(value: string): value is WaitState {
  return (WAIT_STATES as readonly string[]).includes(value);
}

/** Clamp a requested timeout into `[0, WAIT_MAX_TIMEOUT_MS]`. */
export function clampWaitTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return WAIT_MAX_TIMEOUT_MS;
  }
  return Math.min(WAIT_MAX_TIMEOUT_MS, Math.max(0, Math.floor(timeoutMs)));
}

/** An archive reason that means the session ended in failure, not normally. */
function isErrorArchiveReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return (
    reason === "Session crashed" || reason.startsWith("Local launch failed")
  );
}

function hasPendingRequests(session: Session): boolean {
  const requests = session.agentState?.requests;
  return !!requests && Object.keys(requests).length > 0;
}

/**
 * Derive one state label from a snapshot. Precedence: an ended session first,
 * then the conditions that stop a turn (rate limit, a pending approval), then
 * running vs idle.
 */
export function deriveSessionState(
  session: Session,
  queuedCount: number
): DerivedSessionState {
  if (session.metadata?.lifecycleState === "archived") {
    return isErrorArchiveReason(session.metadata.archiveReason)
      ? "errored"
      : "completed";
  }
  if (session.rateLimited != null) return "rate-limited";
  if (hasPendingRequests(session) || session.blockedOnTuiPrompt != null) {
    return "blocked";
  }
  if (!session.active) return "inactive";
  // Queued work that has not been dispatched yet means the session is not
  // idle: the drain observer is about to start a turn.
  if (session.thinking || queuedCount > 0) return "busy";
  return "idle";
}

/** An edge-only error signal for this session (not replayed from before the wait). */
function isErrorEdge(event: SyncEvent): boolean {
  switch (event.type) {
    case "api-error":
      return event.data.phase === "exhausted" || event.data.phase === "give-up";
    case "session-restart-failed":
    case "spawn-failed":
      return true;
    default:
      return false;
  }
}

function eventSessionId(event: SyncEvent): string | undefined {
  return "sessionId" in event && typeof event.sessionId === "string"
    ? event.sessionId
    : undefined;
}

export function waitForSessionState(
  engine: SessionStateWaiterEngine,
  options: WaitForSessionStateOptions
): Promise<WaitForSessionStateResult> {
  const { sessionId, namespace, state: target, signal } = options;
  const timeoutMs = clampWaitTimeout(options.timeoutMs);
  const settleMs = options.settleMs ?? IDLE_SETTLE_MS;

  return new Promise(resolve => {
    let done = false;
    let seen = false;
    let removed = false;
    let unsubscribe: (() => void) | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    let settle: ReturnType<typeof setTimeout> | null = null;

    const snapshot = (): Session | undefined => {
      if (removed) return undefined;
      const session = engine.getSession(sessionId);
      // A session in another namespace is not this caller's to observe.
      if (session && session.namespace !== namespace) return undefined;
      if (session) seen = true;
      return session;
    };

    const current = (): DerivedSessionState => {
      const session = snapshot();
      if (!session) return seen ? "completed" : "unknown";
      return deriveSessionState(
        session,
        engine.listQueuedMessages(sessionId, namespace).length
      );
    };

    const onAbort = () => finish("aborted");

    function finish(
      result: WaitForSessionStateResult["result"],
      state?: DerivedSessionState
    ): void {
      if (done) return;
      done = true;
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (deadline) clearTimeout(deadline);
      if (settle) clearTimeout(settle);
      deadline = null;
      settle = null;
      signal?.removeEventListener("abort", onAbort);
      resolve({ result, state: state ?? current(), sessionId });
    }

    const evaluate = (): void => {
      if (done) return;
      const state = current();
      if (target === "idle") {
        if (state !== "idle") {
          // The hold broke (e.g. a just-sent message started a turn).
          if (settle) clearTimeout(settle);
          settle = null;
          return;
        }
        // Idle: start the settle window once and let it run while idle holds.
        if (!settle) {
          settle = setTimeout(() => {
            settle = null;
            if (current() === "idle") finish("matched", "idle");
          }, settleMs);
        }
        return;
      }
      if (state === target) finish("matched", state);
    };

    if (signal?.aborted) {
      // Never subscribed, so there is nothing to unsubscribe.
      done = true;
      resolve({ result: "aborted", state: current(), sessionId });
      return;
    }

    // Subscribe FIRST, then read the snapshot (level trigger).
    unsubscribe = engine.subscribe(event => {
      // Filter by session before any other work: one O(1) check per event.
      if (done || eventSessionId(event) !== sessionId) return;
      if (event.type === "session-removed") {
        removed = true;
        if (target === "completed") finish("matched", "completed");
        else evaluate();
        return;
      }
      if (isErrorEdge(event)) {
        if (target === "errored") finish("matched", "errored");
        else evaluate();
        return;
      }
      if (
        event.type === "session-updated" ||
        event.type === "session-added" ||
        event.type === "queue-changed"
      ) {
        evaluate();
      }
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    deadline = setTimeout(() => finish("timeout"), timeoutMs);

    evaluate();
  });
}
