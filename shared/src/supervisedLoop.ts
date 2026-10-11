// SPDX-License-Identifier: AGPL-3.0-only
import {
  JOB_KIND_IN_PROCESS_LOOP,
  type JobFailureEvent,
  type JobHealthStatus,
  type JobRegistry,
} from "./jobRegistry";

/**
 * Supervised loop primitive — a self-healing, self-reporting wrapper around an
 * in-process scheduled loop (issue #1963, epic #1960, Sub-Issue C).
 *
 * Replaces the hand-rolled `private timer + scheduleNext() + runX()` pattern
 * repeated across ~10 server/daemon services. It provides, in ONE place, the
 * three guarantees that pattern kept getting wrong:
 *
 *  1. **Auto-restart-on-throw (R1).** The next tick is re-armed in a `finally`,
 *     so a throw inside the tick — OR inside the tick's own error handler — can
 *     never strand the loop. This is the exact Bug-2 (#1962) failure mode: the
 *     UsageSampler rescheduled AFTER its try/catch, so a throw in the catch
 *     handler silently killed the loop (~12h frozen). `HealthAggregator` already
 *     did it right (reschedule in `.finally()`); this primitive canonicalizes
 *     that shape.
 *  2. **Stall watchdog (R2).** A second timer detects a loop that stopped
 *     ticking (a hung tick whose `await` never resolves — the only failure the
 *     `finally`-reschedule can't catch), flips the registry `status` to
 *     `"stalled"`, and emits a structured failure event. It restarts the loop
 *     only when no tick is in flight (a lost timer) or the in-flight tick has
 *     run past the hang ceiling (`hangFactor × max(cadence, check period)`), and
 *     then at most once per ceiling window — so a slow-but-finite tick never
 *     gets a second tick started or queued behind it (#4060). Trade-off: a
 *     genuinely hung loop is restarted after ~6× its cadence by default
 *     (previously ~3×); stall DETECTION time is unchanged.
 *  3. **Registry + heartbeat (R3).** Registers a `{name, node, kind, intervalMs,
 *     lastTickAt, status, lastError}` row and updates `lastTickAt` each tick —
 *     the telemetry Sub-Issue D (#1964) reads.
 *
 * Scheduling is drift-free `setTimeout`-reschedule (R5): the next tick is armed
 * `intervalMs` AFTER the previous one completes, so ticks never overlap and
 * graceful shutdown (`stop()`) is clean. This preserves the existing services'
 * `setTimeout`-not-`setInterval` semantics. For lifecycle-coupled timers that
 * should NOT carry a boot-start watchdog (e.g. the SSE heartbeat, the SyncEngine
 * timers), do NOT wrap them — register-only via {@link JobRegistry} directly.
 *
 * PURE of fs/env/exec: the clock (`now`) and the timer functions are injectable
 * so the primitive is hermetically testable with fake timers, and so the module
 * can live in `shared/` alongside the contract it produces.
 */
export interface SupervisedLoopOptions {
  /** Stable job name (registry key, e.g. `"usage-sampler"`). */
  name: string;
  /** Federation nodeId this loop runs on. */
  node: string;
  /** Nominal cadence in milliseconds (delay between a tick completing and the next starting). */
  intervalMs: number;
  /**
   * Optional DYNAMIC interval: when provided, the delay before the next tick
   * is `getIntervalMs()` (re-read each reschedule) instead of the fixed
   * `intervalMs`. For backoff/adaptive loops (HeartbeatService's
   * sessionManager interval, TokenRefreshService's soonest-expiry delay).
   * `intervalMs` stays the nominal cadence reported to the registry and the
   * watchdog's lower bound.
   */
  getIntervalMs?: () => number;
  /** The work to run each tick. May be sync or async; may throw — the loop survives. */
  tick: () => void | Promise<void>;
  /** Registry to register/update into. Omit to run without telemetry (rare). */
  registry?: JobRegistry;
  /** Injectable clock (defaults to `Date.now`). Tests pass a controllable clock. */
  now?: () => number;
  /** Injectable `setTimeout` (defaults to global). Tests pass a fake-timer shim. */
  setTimeoutFn?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  /** Injectable `clearTimeout` (defaults to global). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  /**
   * Stall threshold multiplier: the watchdog flags a stall when no tick has
   * completed within `stallFactor × intervalMs`. Must be ≥ 2 (a normal cycle's
   * gap between tick-ends can reach ~1×intervalMs; 3 leaves headroom).
   * Default 3.
   */
  stallFactor?: number;
  /**
   * Hang-ceiling multiplier (#4060): while a tick is in flight the watchdog
   * restarts the loop only once that tick has run longer than
   * `hangFactor × max(intervalMs, current delay, watchdog check period)`, and
   * then at most once per such window. The stall flag and event still fire at
   * the `stallFactor` threshold. Default `2 × stallFactor`; clamped to
   * `> stallFactor`.
   */
  hangFactor?: number;
  /**
   * Consecutive-caught-throw threshold: after this many ticks throw in a row
   * (with no intervening success) the loop flips status to `"dead"` and emits a
   * JobFailureEvent once, making a crash loop visible in the System Jobs portal
   * (issue #2035). Any successful tick resets the counter. Clamped to ≥ 2 so a
   * single isolated throw is always tolerated. Default 3.
   */
  failureThreshold?: number;
  /** Structured failure-event sink (R6). Routed by the server to `ErrorLogger`. */
  onEvent?: (event: JobFailureEvent) => void;
  /**
   * When `false`, `start()` registers the job as `"stopped"` and does NOT arm —
   * mirrors the config-gated services that log "disabled, not starting". This
   * keeps a disabled loop VISIBLE in the registry (Sub-D can show "disabled").
   * Default `true`.
   */
  enabled?: boolean;
  /**
   * When `true`, the first tick runs immediately on `start()` (no cold-start
   * gap — matches UsageSampler #1909 and HealthAggregator). When `false`, the
   * first tick waits one `intervalMs` (matches Heartbeat/Scheduler/Watchdog).
   * Default `false`.
   */
  immediate?: boolean;
}

export class SupervisedLoop {
  private readonly name: string;
  private readonly node: string;
  private readonly intervalMs: number;
  private readonly tickFn: () => void | Promise<void>;
  private readonly registry: JobRegistry | null;
  private readonly now: () => number;
  private readonly setTimeoutFn: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (
    handle: ReturnType<typeof setTimeout>
  ) => void;
  private readonly stallFactor: number;
  private readonly hangFactor: number;
  private readonly failureThreshold: number;
  private readonly onEvent: ((event: JobFailureEvent) => void) | null;
  private readonly enabled: boolean;
  private readonly immediate: boolean;
  private readonly getIntervalMs: (() => number) | null;

  private tickTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /**
   * Bumped on every `stop()` and every watchdog restart. An in-flight tick
   * captures the generation at its start and only re-arms the next tick if the
   * generation still matches — so a hung tick that the watchdog already
   * superseded cannot resurrect a second concurrent loop.
   */
  private generation = 0;
  private status: JobHealthStatus = "stopped";
  private lastError: string | null = null;
  private lastTickEndAt: number | null = null;
  private startedAt = 0;
  private lastDelayMs = 0;
  private consecutiveThrows = 0;
  private tickSeq = 0;
  /**
   * Ticks currently in flight (token → start time). A map, not one field,
   * because `triggerNow()` can overlap a scheduled tick. Cleared on a watchdog
   * restart (the superseded tick is abandoned) and on `stop()`.
   */
  private readonly inFlight = new Map<number, number>();

  constructor(opts: SupervisedLoopOptions) {
    this.name = opts.name;
    this.node = opts.node;
    this.intervalMs = opts.intervalMs;
    this.tickFn = opts.tick;
    this.registry = opts.registry ?? null;
    this.now = opts.now ?? Date.now;
    this.setTimeoutFn =
      opts.setTimeoutFn ??
      ((h, ms): ReturnType<typeof setTimeout> => setTimeout(h, ms));
    this.clearTimeoutFn =
      opts.clearTimeoutFn ?? ((handle): void => clearTimeout(handle));
    this.stallFactor = Math.max(2, opts.stallFactor ?? 3);
    this.hangFactor = Math.max(
      this.stallFactor + 1,
      opts.hangFactor ?? 2 * this.stallFactor
    );
    this.failureThreshold = Math.max(2, opts.failureThreshold ?? 3);
    this.onEvent = opts.onEvent ?? null;
    this.enabled = opts.enabled ?? true;
    this.immediate = opts.immediate ?? false;
    this.getIntervalMs = opts.getIntervalMs ?? null;
    this.lastDelayMs = this.intervalMs;
  }

  /**
   * Start the loop. Idempotent. When disabled, registers a `"stopped"` row and
   * returns (the loop stays visible but inert).
   */
  start(): void {
    if (!this.enabled) {
      this.status = "stopped";
      this.registerRow();
      return;
    }
    if (this.running) return;
    this.running = true;
    this.status = "ok";
    this.lastError = null;
    this.consecutiveThrows = 0;
    this.lastTickEndAt = null;
    this.startedAt = this.now();
    this.registerRow();
    this.armWatchdog();
    if (this.immediate) {
      void this.runTick();
    } else {
      this.scheduleNext();
    }
  }

  /** Stop the loop. Idempotent. Clears both timers and marks the row `"stopped"`. */
  stop(): void {
    this.running = false;
    this.generation++; // invalidate any in-flight tick's reschedule
    this.inFlight.clear();
    if (this.tickTimer !== null) {
      this.clearTimeoutFn(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.watchdogTimer !== null) {
      this.clearTimeoutFn(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.status = "stopped";
    this.safeUpdate({ status: "stopped", lastError: this.lastError });
  }

  /** Fire one out-of-cycle tick now (parity with HeartbeatService.triggerNow). */
  async triggerNow(): Promise<void> {
    if (!this.running) return;
    if (this.tickTimer !== null) {
      this.clearTimeoutFn(this.tickTimer);
      this.tickTimer = null;
    }
    await this.runTick();
  }

  /** Current registry-row snapshot (for tests / direct inspection). */
  getStatus(): JobHealthStatus {
    return this.status;
  }

  private registerRow(): void {
    if (!this.registry) return;
    try {
      this.registry.register({
        name: this.name,
        node: this.node,
        kind: JOB_KIND_IN_PROCESS_LOOP,
        intervalMs: this.intervalMs,
        lastTickAt: this.lastTickEndAt,
        status: this.status,
        lastError: this.lastError,
      });
    } catch {
      // Registry must never crash the loop.
    }
  }

  private safeUpdate(patch: {
    lastTickAt?: number | null;
    status?: JobHealthStatus;
    lastError?: string | null;
  }): void {
    if (!this.registry) return;
    try {
      this.registry.update(this.name, patch);
    } catch {
      // Registry must never crash the loop.
    }
  }

  private safeEvent(event: JobFailureEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch {
        // Event sink must never crash the loop.
      }
      return;
    }
    // Fall back to the registry-level sink (wired once in index.ts).
    this.registry?.emitEvent(event);
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const gen = this.generation;
    const delay = this.getIntervalMs
      ? Math.max(1, this.getIntervalMs())
      : this.intervalMs;
    this.lastDelayMs = delay;
    this.tickTimer = this.setTimeoutFn(() => {
      this.tickTimer = null;
      // A stop() or watchdog restart between arming and firing invalidates this tick.
      if (!this.running || gen !== this.generation) return;
      void this.runTick();
    }, delay);
  }

  private async runTick(): Promise<void> {
    if (!this.running) return;
    const gen = this.generation;
    const token = ++this.tickSeq;
    this.inFlight.set(token, this.now());
    try {
      await this.tickFn();
      // A successful tick clears any prior error, resets the crash-loop
      // counter, and recovers a stalled/dead status.
      this.lastError = null;
      this.consecutiveThrows = 0;
      this.status = "ok";
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.consecutiveThrows++;
      if (this.consecutiveThrows >= this.failureThreshold) {
        // #2035: perpetual-throw masking. Flip to "dead" and emit ONCE on the
        // transition into "dead" (mirrors the watchdog's ok->stalled guard).
        // The loop keeps ticking via the finally re-arm, so a later success
        // auto-recovers it to "ok".
        const wasDead = this.status === "dead";
        this.status = "dead";
        if (!wasDead) {
          this.safeEvent({
            name: this.name,
            node: this.node,
            status: "dead",
            error: this.lastError,
            at: this.now(),
          });
        }
      } else {
        // Below threshold — single-throw tolerance preserved (self-heal).
        this.status = "ok";
      }
    } finally {
      this.inFlight.delete(token);
      this.lastTickEndAt = this.now();
      // Update telemetry in its OWN try (inside safeUpdate) so a registry throw
      // cannot reach the reschedule line below.
      this.safeUpdate({
        lastTickAt: this.lastTickEndAt,
        status: this.status,
        lastError: this.lastError,
      });
      // R1: re-arm unconditionally on the live generation — survives ANY throw
      // above (including in the catch handler) because it is in `finally`.
      if (this.running && gen === this.generation) {
        this.scheduleNext();
      }
    }
  }

  private armWatchdog(): void {
    if (!this.running) return;
    // Check at least once per interval (bounded so a tiny interval doesn't spin).
    const checkEvery = Math.max(1000, this.intervalMs);
    this.watchdogTimer = this.setTimeoutFn(() => {
      this.watchdogTimer = null;
      if (!this.running) return;
      try {
        const baseline = this.lastTickEndAt ?? this.startedAt;
        const sinceTick = this.now() - baseline;
        // For dynamic intervals the threshold tracks the current cadence
        // (lastDelayMs), never below the nominal intervalMs.
        const thresholdMs =
          this.stallFactor * Math.max(this.intervalMs, this.lastDelayMs);
        if (sinceTick > thresholdMs) {
          // Stall detected: a tick has not completed within the threshold —
          // almost always a hung tick whose `await` never resolved.
          const wasOk = this.status !== "stalled";
          this.lastError = `no tick completed in ${sinceTick}ms (> ${thresholdMs}ms)`;
          this.status = "stalled";
          this.safeUpdate({ status: "stalled", lastError: this.lastError });
          // Emit the failure event only on the ok -> stalled transition (no spam).
          if (wasOk) {
            this.safeEvent({
              name: this.name,
              node: this.node,
              status: "stalled",
              error: this.lastError,
              at: this.now(),
            });
          }
          // Restart (#4060): only when nothing is in flight (a lost timer —
          // restart now) or the oldest in-flight tick has outlived the hang
          // ceiling. Never on every check: that stacked a fresh tick behind a
          // slow one each time. The ceiling includes the check period because
          // the watchdog cannot observe anything finer than that.
          let oldestStart = Number.POSITIVE_INFINITY;
          for (const startedAt of this.inFlight.values()) {
            oldestStart = Math.min(oldestStart, startedAt);
          }
          const hangMs =
            this.hangFactor *
            Math.max(this.intervalMs, this.lastDelayMs, checkEvery);
          if (this.inFlight.size === 0 || this.now() - oldestStart > hangMs) {
            // Abandon the superseded tick(s): the next restart needs a full
            // ceiling window measured from the NEW tick's start. Bump
            // generation so the hung tick's finally cannot re-arm, clear the
            // (possibly stuck) tick timer, and start a fresh tick.
            this.inFlight.clear();
            this.generation++;
            if (this.tickTimer !== null) {
              this.clearTimeoutFn(this.tickTimer);
              this.tickTimer = null;
            }
            void this.runTick();
          }
        }
      } finally {
        // The watchdog must re-arm regardless of any throw above.
        this.armWatchdog();
      }
    }, checkEvery);
  }
}
