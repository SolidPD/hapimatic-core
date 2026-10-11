// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ContextWatermarkService — the monitor half of the context-watermark successor
 * handoff (issue #2158, epic rp1-home#1319). A structural clone of
 * `StallWatchdogService`: a `SupervisedLoop` poller that watches orchestrator
 * (`pm`-role) sessions and ARMS one for handoff the moment its context usage
 * crosses the watermark.
 *
 * 🔴 The service NEVER spawns or kills anything. It only ARMS. Firing belongs to
 * the finalize-seam step (`successorHandoffStep.ts`), which is structurally
 * incapable of running mid-turn. Keeping detection (this file) and action (the
 * step) in separate modules is exactly what makes both testable and what prevents
 * a monitor from ever firing mid-transaction (R2).
 *
 * 🔴 DEFAULT DISABLED (R5): `start()` no-ops when `!config.enabled`, and this
 * feature terminates sessions, so it stays off until explicitly enabled.
 */

import type { Session } from "@hapi/protocol";
import type { WatermarkState, WatermarkDeferReason } from "@hapi/protocol";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { WatermarkStore } from "../store/watermarkStore";
import type { ContextWatermarkConfig } from "../config/contextWatermarkConfig";

export interface ContextWatermarkServiceDeps {
  /** Node-local session source (`syncEngine.getSessions`). */
  getSessions: () => Session[];
  /** Restart-surviving persistence for the `handing_off` hold + `suppressed` flag. */
  watermarkStore: WatermarkStore;
  config: ContextWatermarkConfig;
  errorLogger?: ErrorLogger | null;
  now?: () => number;
  jobRegistry?: JobRegistry | null;
  node?: string;
}

export class ContextWatermarkService {
  private readonly config: ContextWatermarkConfig;
  private readonly getSessions: () => Session[];
  private readonly watermarkStore: WatermarkStore;
  private readonly errorLogger: ErrorLogger | null;
  private readonly now: () => number;
  private readonly loop: SupervisedLoop;

  /** In-memory source of truth for the observable state machine. */
  private readonly states = new Map<string, WatermarkState>();
  /** Sessions already alerted at the generation cap (avoid per-poll log spam). */
  private readonly genCapAlerted = new Set<string>();
  private running = false;
  private lastPollAt: number | null = null;

  constructor(deps: ContextWatermarkServiceDeps) {
    this.config = deps.config;
    this.getSessions = deps.getSessions;
    this.watermarkStore = deps.watermarkStore;
    this.errorLogger = deps.errorLogger ?? null;
    this.now = deps.now ?? Date.now;
    this.loop = new SupervisedLoop({
      name: "context-watermark",
      node: deps.node ?? "standalone",
      intervalMs: this.config.pollIntervalMs,
      getIntervalMs: () => this.config.pollIntervalMs,
      immediate: false,
      registry: deps.jobRegistry ?? undefined,
      tick: () => this.runPollTick(),
    });
  }

  start(): void {
    if (!this.config.enabled) {
      this.errorLogger?.info(
        "[ContextWatermark] disabled in config, not starting",
        { category: "context-watermark" }
      );
      return;
    }
    this.hydrateFromStore();
    this.running = true;
    this.errorLogger?.info(
      `[ContextWatermark] started (watermark ${this.config.watermarkPercent}%, ` +
        `poll ${this.config.pollIntervalMs / 1000}s, roles=${this.config.roles.join(",")})`,
      { category: "context-watermark" }
    );
    this.loop.start();
  }

  stop(): void {
    this.running = false;
    this.loop.stop();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Runtime enable/disable (R2, #2587). Flips the in-memory `config.enabled` and
   * reconciles the poll loop so `isEnabled()` and `GET /api/watermark` reflect the
   * new value WITHOUT a process restart — the #2486 divergence class the admin
   * toggle exists to avoid (a settings-only write would leave `isEnabled()` a
   * construction-time snapshot until reboot). Idempotent: a no-op when the value
   * is unchanged. Persistence is the ROUTE's job (keeps this service I/O-free per
   * its dep-injected design); the caller passes the env-aware
   * `saveContextWatermarkConfig` result so the `HAPI_CONTEXT_WATERMARK_ENABLED`
   * kill-switch keeps winning at runtime. `stop()` retains `this.states` (a live
   * `handing_off` hold gates a turn-lifecycle, index.ts) — a disabled service may
   * still expose stale armed entries, which the UI annotates as inactive.
   */
  setEnabled(enabled: boolean): void {
    if (this.config.enabled === enabled) return;
    // Set the flag FIRST — start() early-returns while !config.enabled.
    this.config.enabled = enabled;
    if (enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  /**
   * Runtime watermark-threshold update (#2587 follow-up — user-editable percent).
   * Mutates the in-memory threshold so the NEXT poll arms at the new value with no
   * process restart (`poll()` reads `this.config.watermarkPercent` live each tick).
   * Persistence is the ROUTE's job (keeps this service I/O-free); the caller passes
   * a validated `0 < percent <= 100` (the route's zod schema + the config loader's
   * `> 0` clamp own validation).
   */
  setWatermarkPercent(percent: number): void {
    this.config.watermarkPercent = percent;
  }

  isRunning(): boolean {
    return this.running;
  }

  getConfig(): ContextWatermarkConfig {
    return { ...this.config };
  }

  // ---------- State accessors (route + step facing) ----------

  getState(sessionId: string): WatermarkState | undefined {
    const s = this.states.get(sessionId);
    return s ? { ...s } : undefined;
  }

  getStates(): WatermarkState[] {
    return [...this.states.values()].map(s => ({ ...s }));
  }

  /** The queue-drain HOLD predicate: true while a session's pipeline is in flight. */
  isHeld(sessionId: string): boolean {
    return this.states.get(sessionId)?.handoffState === "handing_off";
  }

  // ---------- Step-facing mutators ----------

  /** Enter the persisted `handing_off` hold (pauses queue drain for this session). */
  beginHandoff(sessionId: string): void {
    const s = this.ensureState(sessionId);
    s.handoffState = "handing_off";
    s.deferredReason = null;
    this.safePersistHandoff(sessionId, "handing_off");
  }

  completeHandoff(sessionId: string): void {
    const s = this.ensureState(sessionId);
    s.handoffState = "complete";
    s.armed = false;
    s.armedAtMs = null;
    this.safePersistHandoff(sessionId, "complete");
  }

  /**
   * Fail-safe exit (R7): the predecessor stays alive. The state returns toward
   * `failed`; the next poll re-arms it if it is still over the watermark and not
   * suppressed (there is no cooldown — the pipeline's own guards bound retries).
   */
  failHandoff(sessionId: string): void {
    const s = this.ensureState(sessionId);
    s.handoffState = "failed";
    s.armed = false;
    s.armedAtMs = null;
    this.safePersistHandoff(sessionId, "failed");
  }

  setDeferredReason(
    sessionId: string,
    reason: WatermarkDeferReason | null
  ): void {
    const s = this.ensureState(sessionId);
    s.deferredReason = reason;
    // Transient — deferral is re-evaluated every finalize, never persisted.
  }

  /**
   * Record the generation a freshly-spawned successor inherits (predecessor + 1),
   * both in memory and durably — so when the successor later crosses the
   * watermark the anti-chain cap sees its true generation.
   */
  recordSuccessorGeneration(successorId: string, generation: number): void {
    const s = this.ensureState(successorId);
    s.generation = generation;
    this.safePersistFull(successorId);
  }

  // ---------- Route-facing override (R5 observability) ----------

  /**
   * Manual disarm with persisted suppression + hysteresis: the poll will NOT
   * re-arm until context usage falls back below the watermark (or an explicit
   * {@link rearm}). Without the flag the 30s poll would re-arm a still-over
   * session within one interval — a decorative disarm.
   */
  disarm(sessionId: string): WatermarkState {
    const s = this.ensureState(sessionId);
    s.suppressed = true;
    s.armed = false;
    s.armedAtMs = null;
    s.deferredReason = null;
    if (s.handoffState === "armed") s.handoffState = "idle";
    this.safePersistFull(sessionId);
    return { ...s };
  }

  rearm(sessionId: string): WatermarkState {
    const s = this.ensureState(sessionId);
    s.suppressed = false;
    this.safePersistFull(sessionId);
    return { ...s };
  }

  // ---------- Poll loop ----------

  /** Public so tests can drive one poll deterministically. */
  async runPollTick(): Promise<void> {
    try {
      this.poll();
    } catch (error) {
      this.errorLogger?.error("[ContextWatermark] poll error", {
        category: "context-watermark",
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error; // let SupervisedLoop record lastError + re-arm via finally
    }
  }

  poll(): void {
    if (!this.config.enabled) return;
    const now = this.now();
    this.lastPollAt = now;

    for (const session of this.getSessions()) {
      if (!session.active) continue;
      const role = session.metadata?.sessionRole;
      if (!role || !this.config.roles.includes(role)) continue;

      const pct = contextPct(session);
      if (pct == null) continue;

      const state = this.ensureState(session.id);
      state.contextPercentage = pct;

      // Never disturb a session whose pipeline is in flight.
      if (state.handoffState === "handing_off") continue;

      // Hysteresis: a suppressed session clears its suppression only once it has
      // fallen back below the watermark.
      if (state.suppressed && pct < this.config.watermarkPercent) {
        state.suppressed = false;
        this.safePersistSuppressed(session.id, false);
      }

      // Fell back below the watermark before firing → auto-disarm (not suppressed).
      if (state.armed && pct < this.config.watermarkPercent) {
        state.armed = false;
        state.armedAtMs = null;
        state.deferredReason = null;
        state.handoffState = "idle";
        continue;
      }

      // Arm condition — cross the watermark, not already armed, not suppressed.
      if (
        pct >= this.config.watermarkPercent &&
        !state.armed &&
        !state.suppressed
      ) {
        const age = now - (session.createdAt ?? now);
        if (age < this.config.minSessionAgeMs) continue; // anti-chain: too young
        if (state.generation >= this.config.maxHandoffGeneration) {
          this.alertGenerationCap(session.id, state.generation);
          continue; // anti-chain: at the generation cap, alert instead of arming
        }
        // Arm exactly once — "mark before side effects" (mirrors the stall
        // watchdog's downgradeNotified guard) so the breadcrumb fires once.
        state.armed = true;
        state.armedAtMs = now;
        state.handoffState = "armed";
        state.deferredReason = null;
        this.genCapAlerted.delete(session.id);
        this.errorLogger?.warn(
          `[ContextWatermark] armed session ${session.id.slice(0, 8)} at ${pct}% ` +
            `(watermark ${this.config.watermarkPercent}%, generation ${state.generation})`,
          { category: "context-watermark", sessionId: session.id }
        );
      }
    }
  }

  // ---------- Internal ----------

  private ensureState(sessionId: string): WatermarkState {
    const existing = this.states.get(sessionId);
    if (existing) return existing;
    // Seed from persistence if a durable row exists (suppression / generation
    // survive restart; a re-hydrated `handing_off` is reconciled at boot).
    let suppressed = false;
    let generation = 0;
    try {
      const persisted = this.watermarkStore.get(sessionId);
      if (persisted) {
        suppressed = persisted.suppressed;
        generation = persisted.generation;
      }
    } catch (error) {
      this.logPersistError("get", sessionId, error);
    }
    const fresh: WatermarkState = {
      sessionId,
      armed: false,
      armedAtMs: null,
      contextPercentage: 0,
      deferredReason: null,
      handoffState: "idle",
      generation,
      suppressed,
    };
    this.states.set(sessionId, fresh);
    return fresh;
  }

  /**
   * Boot reconciliation: seed suppression + generation from the store, and
   * RECOVER any interrupted handoff — a persisted `handing_off` means the process
   * died mid-pipeline. The predecessor is still alive (the reap is the pipeline's
   * last step), so release the hold (reset to `idle`) and let the next poll re-arm
   * it; leaving it `handing_off` would strand the queue-drain hold forever.
   */
  private hydrateFromStore(): void {
    let rows;
    try {
      rows = this.watermarkStore.all();
    } catch (error) {
      this.logPersistError("all", "*", error);
      return;
    }
    for (const row of rows) {
      const interrupted = row.handoffState === "handing_off";
      const state: WatermarkState = {
        sessionId: row.sessionId,
        armed: false,
        armedAtMs: null,
        contextPercentage: 0,
        deferredReason: null,
        handoffState: interrupted ? "idle" : row.handoffState,
        generation: row.generation,
        suppressed: row.suppressed,
      };
      this.states.set(row.sessionId, state);
      if (interrupted) {
        this.safePersistHandoff(row.sessionId, "idle");
        this.errorLogger?.warn(
          `[ContextWatermark] recovered interrupted handoff for session ` +
            `${row.sessionId.slice(0, 8)} (hold released; predecessor left alive)`,
          { category: "context-watermark", sessionId: row.sessionId }
        );
      }
    }
  }

  private alertGenerationCap(sessionId: string, generation: number): void {
    if (this.genCapAlerted.has(sessionId)) return;
    this.genCapAlerted.add(sessionId);
    this.errorLogger?.warn(
      `[ContextWatermark] session ${sessionId.slice(0, 8)} at generation ` +
        `${generation} (cap ${this.config.maxHandoffGeneration}) — NOT arming; ` +
        `a handoff chain has reached its limit and needs manual attention`,
      { category: "context-watermark", sessionId }
    );
  }

  // ---------- Fail-open persistence wrappers ----------

  private safePersistHandoff(
    sessionId: string,
    handoffState: WatermarkState["handoffState"]
  ): void {
    try {
      this.watermarkStore.setHandoffState(sessionId, handoffState);
    } catch (error) {
      this.logPersistError("setHandoffState", sessionId, error);
    }
  }

  private safePersistSuppressed(sessionId: string, suppressed: boolean): void {
    try {
      this.watermarkStore.setSuppressed(sessionId, suppressed);
    } catch (error) {
      this.logPersistError("setSuppressed", sessionId, error);
    }
  }

  private safePersistFull(sessionId: string): void {
    const s = this.states.get(sessionId);
    if (!s) return;
    try {
      this.watermarkStore.upsert({
        sessionId,
        handoffState: s.handoffState,
        suppressed: s.suppressed,
        generation: s.generation,
      });
    } catch (error) {
      this.logPersistError("upsert", sessionId, error);
    }
  }

  private logPersistError(op: string, sessionId: string, error: unknown): void {
    // Fail-open: a persistence hiccup must never break arming/handoff bookkeeping.
    this.errorLogger?.warn(`[ContextWatermark] persistence ${op} failed`, {
      category: "context-watermark",
      sessionId,
      context: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * The watermark signal (0–100). Prefer the precomputed `contextPercentage` the
 * CLI already rides on `handleSessionAlive`; derive from used/window only if it
 * is absent. Returns `null` when neither is available.
 */
export function contextPct(session: Session): number | null {
  if (typeof session.contextPercentage === "number") {
    return session.contextPercentage;
  }
  if (
    typeof session.contextUsedTokens === "number" &&
    typeof session.contextWindowTokens === "number" &&
    session.contextWindowTokens > 0
  ) {
    return (session.contextUsedTokens / session.contextWindowTokens) * 100;
  }
  return null;
}
