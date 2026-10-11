// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Auto-Recovery Service (#1234, Epic #1231 Sub-Issue C)
 *
 * Subscribes to `api-error` SyncEvents and, on terminal exhaustion of any
 * recover-by-default API-error class (catch-all, #2487 Sub-Issue D — was
 * `overloaded_error`-only), injects a recovery prompt into the affected session
 * after a policy-governed cooldown. This is the HIGHEST-RISK piece of the epic —
 * it actively writes prompts into running Claude Code sessions — so the policy
 * is deliberately conservative:
 *
 *   - Cooldown ladder (60s → 5min → 15min) then give-up (R2)
 *   - Max 3 attempts per session per rolling hour (R2)
 *   - Abort if the user has sent any message since the error (R3)
 *   - Give-up after 2 consecutive attempts that produced api-error again (R4)
 *   - Per-class policy (#2487 D): recover every classified transient class by
 *     default; a per-class opt-out is an absolute veto; notify-only-by-default
 *     for deterministic classes (auth / invalid-request / billing), force-
 *     enableable — replaces the `overloaded_error`-only allow-list (R2/R5)
 *   - Global toggle (read FRESH per decision) + per-session override (R6)
 *   - Federation: only the OWNING node recovers a given session (R8)
 *
 * Event-driven (subscribe + setTimeout), NOT poll-based — structurally similar
 * to StallWatchdogService minus the poll loop. All per-session state is
 * in-memory and resets on restart (acceptable per the epic).
 */

import type { SyncEngine, Session, SyncEvent } from "../sync/syncEngine";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { ErrorLogger } from "../logging/errorLogger";
import type { AutoRecoveryConfig } from "../config/autoRecoveryConfig";
import { readAutoRecoverPreferences } from "../web/routes/preferences";
import { PROGRAMMATIC_SENT_FROM } from "../sync/sentFrom";
import {
  canonicalizeErrorType,
  isRecoverByDefaultClass,
  isTerminalClass,
} from "@hapi/protocol/apiErrorClasses";

const ROLLING_HOUR_MS = 3_600_000;

/**
 * #2485 (Sub-Issue B): the durable `auto-recovery-*` category family for the
 * error_logs accounting rows emitted at each recovery-lifecycle decision point.
 * Each lifecycle point gets a DISTINCT category so the per-category ErrorLogger
 * rate-limit (#1141, default 10/60s) bounds a storm per-point and keeps the
 * points independently queryable via `GET /api/error-logs?category=...` and
 * `hapi api error-logs --category ...`.
 *
 * `auto-recovery-dispatch-failed` (dispatch error) is retained UNCHANGED at its
 * call site — it is already queried/known and MUST NOT be renamed.
 *
 * #2487 (Sub-Issue D) reconciliation of B's skip vocabulary under catch-all:
 *   - `auto-recovery-skip-nonoverload` (B's R5 allow-list skip) is RETIRED — D
 *     removes the `overloaded_error`-only allow-list, so that call site is gone.
 *     Its single skip cause is REPLACED by two class-granular causes below:
 *       · `auto-recovery-skip-class-optout` — the class was explicitly opted out
 *         (an absolute veto, even over a per-session `autoRecoverFromApiError`).
 *       · `auto-recovery-notify-only` — a notify-only-by-default class (auth /
 *         invalid-request / billing) that was NOT force-enabled: resolved but
 *         NOT dispatched (the notification is the existing exhausted-event toast).
 *   - `auto-recovery-skip-disabled` (B's two-cause `{globalEnabled,
 *     sessionOverride}` row) is PRESERVED VERBATIM — the master/session gate is
 *     unchanged; D's class opt-out is a distinct third cause.
 * The full set (this map + `auto-recovery-dispatch-failed`) is the durable
 * accounting deliverable published verbatim in the closing summary.
 *
 * #4936 adds `auto-recovery-terminal`: a TERMINAL class (`spend_limit_error` —
 * an API spend cap or a user-set spend limit) was received. Nothing is ever
 * scheduled for it, whatever the preferences say, and any outstanding recovery
 * for the session is abandoned. The durable stop notice is written by
 * `SpendLimitNoticeObserver`, not here.
 */
const RECOVERY_LOG = {
  trigger: "auto-recovery-trigger",
  scheduled: "auto-recovery-scheduled",
  dispatched: "auto-recovery-dispatched",
  recovered: "auto-recovery-outcome-recovered",
  again: "auto-recovery-outcome-again",
  giveup: "auto-recovery-giveup",
  skipDisabled: "auto-recovery-skip-disabled",
  skipClassOptOut: "auto-recovery-skip-class-optout",
  notifyOnly: "auto-recovery-notify-only",
  terminal: "auto-recovery-terminal",
  skipRemote: "auto-recovery-skip-remote",
  skipNoSession: "auto-recovery-skip-no-session",
  skipUserActivity: "auto-recovery-skip-user-activity",
} as const;

type ApiErrorEvent = Extract<SyncEvent, { type: "api-error" }>;
type MessageReceivedEvent = Extract<SyncEvent, { type: "message-received" }>;

/** One recovery attempt within a session's rolling-hour window. */
interface RecoveryAttempt {
  /** Timestamp the recovery prompt was dispatched (Date.now()). */
  at: number;
  /**
   * "pending"          — prompt dispatched, awaiting the success window
   * "recovered"        — success window elapsed with no new exhausted event
   * "api-error-again"  — a new exhausted event latched while this was pending
   */
  result: "pending" | "recovered" | "api-error-again";
}

/** Per-session in-memory recovery state. Lost on restart (acceptable per epic). */
interface SessionRecoveryState {
  attempts: RecoveryAttempt[];
  /**
   * Message store `seq` watermark captured at the LATEST exhausted-event time.
   * R3 aborts recovery if any message with `seq > errorSeq` is real user input.
   * This is a small per-session monotonic int — NEVER a Date.now() value.
   */
  errorSeq: number | null;
  lastExhaustionAt: number | null;
  /** Set while a recovery prompt is outstanding (drives latch-first R9). */
  lastRecoveryPromptAt: number | null;
  /** Cooldown timer awaiting dispatch. */
  pendingTimer: ReturnType<typeof setTimeout> | null;
  /** R9 success-window timer awaiting the "recovered" verdict. */
  successTimer: ReturnType<typeof setTimeout> | null;
}

export class AutoRecoveryService {
  private readonly states = new Map<string, SessionRecoveryState>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly syncEngine: SyncEngine,
    private readonly registry: NodeRegistry | null,
    private readonly config: AutoRecoveryConfig,
    private readonly errorLogger: ErrorLogger,
    /** Settings file path for FRESH readAutoRecoverPreference() reads (R6/LC-3). */
    private readonly settingsFile: string,
    /**
     * Test-only observer (#2375), fired with the rung the cooldown ladder
     * selected and the cooldown it scheduled. NEVER set in production —
     * `index.ts` omits it, and it is optional + last so every production call
     * site is byte-identical.
     *
     * It exists so tests can assert ladder advancement against a value the
     * service deterministically computes, rather than against an elapsed
     * wall-clock delta: on a loaded 4-core host the dispatch pipeline adds more
     * jitter than the inter-rung margin, which inverted the old comparison.
     *
     * @internal Contract: side-effect-free and must not throw.
     */
    private readonly onCooldownScheduled?: (
      sessionId: string,
      attemptIndex: number,
      cooldownMs: number
    ) => void
  ) {}

  start(): void {
    if (this.unsubscribe) return; // already started
    this.unsubscribe = this.syncEngine.subscribe(event =>
      this.handleEvent(event)
    );
    console.log(
      `[AutoRecovery] Starting — ladder ${JSON.stringify(
        this.config.cooldownLadderMs
      )}, max ${this.config.maxAttemptsPerHour}/hour, ` +
        `success window ${this.config.successWindowMs / 1000}s`
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const state of this.states.values()) {
      this.clearTimers(state);
    }
    this.states.clear();
    console.log("[AutoRecovery] Stopped");
  }

  // ---------- Event dispatch ----------

  private handleEvent(event: SyncEvent): void {
    if (event.type === "api-error") {
      // async policy flow — errors are contained inside handleApiError so a
      // throw never escapes into the EventPublisher fan-out.
      void this.handleApiError(event);
    } else if (event.type === "message-received") {
      this.handleMessageReceived(event);
    }
  }

  // ---------- R1/R5: subscription guard + policy decision ----------

  private async handleApiError(event: ApiErrorEvent): Promise<void> {
    // Defensive runtime narrowing (LC-1): B's payload nests {phase, errorType}
    // under `data`. The discriminated union gives static safety, but guard at
    // runtime against schema drift between B's merge and C's consumption.
    const data = event.data as
      | { phase?: unknown; errorType?: unknown }
      | undefined;
    if (
      !data ||
      typeof data.phase !== "string" ||
      typeof data.errorType !== "string"
    ) {
      return;
    }

    // Only act on terminal exhaustion. This ALSO ignores C's own `give-up`/
    // `recovered` broadcasts (phase !== "exhausted") — no self-trigger loop.
    if (data.phase !== "exhausted") return;

    // R1 (#2485): durably record EVERY received exhaustion BEFORE any skip
    // decision, so a received-but-then-skipped incident class (a notify-only
    // class, or one the user opted out under #2487 D's catch-all) is still
    // observable as "seen".
    this.errorLogger.info(
      `api-error exhaustion received: type="${data.errorType}"`,
      {
        category: RECOVERY_LOG.trigger,
        sessionId: event.sessionId,
        context: { errorType: data.errorType },
      }
    );

    // #2487 D: the `overloaded_error`-only allow-list that used to sit HERE
    // (before the ownership / session / preference reads) is REMOVED. Per-class
    // resolution now happens AFTER those three reads — a non-owning node must
    // never resolve a class or emit a notification for a session it does not own
    // (gate-placement ruling). Only the cheap `phase !== "exhausted"` early-out
    // above still precedes them.
    const sessionId = event.sessionId;

    // R8 federation: only the OWNING node recovers. findNodeForSession returns
    // null for LOCAL sessions. Defense-in-depth (bridged remote events never
    // reach EventPublisher subscribers) — keep it anyway.
    if (this.registry && this.registry.findNodeForSession(sessionId) !== null) {
      // R5 (#2485): the owning node handles this session — record the skip.
      this.errorLogger.info("recovery skipped: session is remote-owned", {
        category: RECOVERY_LOG.skipRemote,
        sessionId,
      });
      return; // remote-owned; that node handles it
    }

    // Local session lookup. Keep AFTER the ownership check: this miss protects
    // the cached-but-OFFLINE-owner edge where findNodeForSession returns null.
    const session = this.syncEngine.getSession(sessionId);
    if (!session) {
      // R5 (#2485): no local session record — record the skip.
      this.errorLogger.info("recovery skipped: session not found", {
        category: RECOVERY_LOG.skipNoSession,
        sessionId,
      });
      return;
    }

    // The incoming error type is canonicalized so a per-class opt-out (keyed by
    // canonical class) still resolves for a legacy RAW value already in flight
    // from before #2487 D Task 2's cutover — alias tolerance (R8).
    const canonicalClass =
      canonicalizeErrorType(data.errorType) ?? data.errorType;

    // #4936: a TERMINAL class (an API spend cap / a user-set spend limit) is
    // never recovered — no retry can succeed before the date the API reports.
    // Placement is load-bearing: AFTER the ownership + session checks above (a
    // non-owning node never acts) and BEFORE every preference read below, so
    // neither the master toggle, the per-session override, nor a stored
    // `classOverrides[...] === true` (salvaged per field, not bound to the class
    // list) can force-enable it. Any outstanding recovery is abandoned so its
    // success timer cannot later broadcast a false "recovered".
    if (isTerminalClass(canonicalClass)) {
      const outstanding = this.states.get(sessionId);
      if (outstanding) this.abandonOutstandingRecovery(sessionId, outstanding);
      this.errorLogger.info(
        `recovery skipped: class "${canonicalClass}" is terminal`,
        {
          category: RECOVERY_LOG.terminal,
          sessionId,
          context: { errorType: data.errorType, class: canonicalClass },
        }
      );
      return;
    }

    // #2487 D per-class resolution. The FULL preference is read FRESH (LC-3,
    // never cached).
    const pref = await readAutoRecoverPreferences(this.settingsFile);
    const classOverride = pref.classOverrides?.[canonicalClass]; // bool | undef

    // (1) A per-class opt-out is an ABSOLUTE veto — it wins over the per-session
    // tri-state `session.autoRecoverFromApiError === true`, because that
    // tri-state predates class granularity and "any explicit OFF wins" is the
    // conservative direction for a service that injects prompts into live
    // sessions. Checked BEFORE shouldRecover so the class OFF cannot be
    // overridden by a session ON.
    if (classOverride === false) {
      this.errorLogger.info(
        `recovery skipped: class "${canonicalClass}" opted out`,
        {
          category: RECOVERY_LOG.skipClassOptOut,
          sessionId,
          context: { errorType: data.errorType, class: canonicalClass },
        }
      );
      return;
    }

    // (2) Master toggle + per-session tri-state (R6, unchanged). `pref.enabled`
    // is the fresh global master. Log BOTH inputs so a per-session opt-out
    // (override === false) is distinguishable from the global toggle being off.
    if (!this.shouldRecover(session, pref.enabled)) {
      this.errorLogger.info("recovery skipped: disabled by preference", {
        category: RECOVERY_LOG.skipDisabled,
        sessionId,
        context: {
          globalEnabled: pref.enabled,
          sessionOverride: session.autoRecoverFromApiError ?? null,
        },
      });
      return;
    }

    // (3) Notify-only default / force-enable (ruling D2 / R6). A deterministic
    // class (auth / invalid-request / billing) does NOT auto-inject a prompt
    // UNLESS the user force-enabled it (`classOverride === true`) — a resume
    // prompt cannot fix a dead token / a spent credit / a request that will fail
    // identically. "Notify" is the toast that ALREADY fires for every classified
    // class on this same `exhausted` event (ApiErrorToastListener): NO new
    // phase, NO new broadcast, NO SyncEvent schema change. An UNRECOGNIZED class
    // is recover-by-default (the widest catch-all).
    const forceEnabled = classOverride === true;
    if (!isRecoverByDefaultClass(canonicalClass) && !forceEnabled) {
      // #4936 in-path fix: a notify-only exhaustion arriving while an earlier
      // recovery prompt is outstanding used to leave that prompt's success
      // timer live, which later broadcast a false "Resumed after API overload".
      const outstanding = this.states.get(sessionId);
      if (outstanding) this.abandonOutstandingRecovery(sessionId, outstanding);
      this.errorLogger.info(
        `recovery skipped: class "${canonicalClass}" is notify-only`,
        {
          category: RECOVERY_LOG.notifyOnly,
          sessionId,
          context: { errorType: data.errorType, class: canonicalClass },
        }
      );
      return;
    }

    const state = this.getOrCreateState(sessionId);
    const now = Date.now();

    // R9 latch-first: a new exhausted event while a prompt is outstanding
    // IMMEDIATELY marks the latest pending attempt "api-error-again" — this is
    // what makes R4 reachable during sustained overload.
    if (state.lastRecoveryPromptAt !== null) {
      for (let i = state.attempts.length - 1; i >= 0; i--) {
        if (state.attempts[i].result === "pending") {
          state.attempts[i].result = "api-error-again";
          // R4 (#2485): a pending attempt just latched api-error-again.
          this.errorLogger.info("recovery outcome: api-error-again (latched)", {
            category: RECOVERY_LOG.again,
            sessionId,
            context: { attemptIndex: i },
          });
          break;
        }
      }
      state.lastRecoveryPromptAt = null;
      if (state.successTimer) {
        clearTimeout(state.successTimer);
        state.successTimer = null;
      }
    }

    // Record exhaustion + capture the seq watermark (R3). getMaxSeq is a small
    // per-session monotonic int — NOT a timestamp.
    state.lastExhaustionAt = now;
    state.errorSeq = this.syncEngine.getMaxSeq(sessionId);

    // Prune BEFORE the caps so both are "per rolling hour", not lifetime.
    state.attempts = state.attempts.filter(a => a.at > now - ROLLING_HOUR_MS);

    // R4 persistent-overload: the last `requestAbortGuard` attempts all latched
    // api-error-again → give up for the rest of the rolling hour.
    const guard = this.config.requestAbortGuard;
    const recent = state.attempts.slice(-guard);
    if (
      recent.length >= guard &&
      recent.every(a => a.result === "api-error-again")
    ) {
      // R4 (#2485): persistent overload — the last `guard` attempts all latched
      // api-error-again. Record the give-up cause before broadcasting.
      this.errorLogger.info("recovery gave up: persistent overload", {
        category: RECOVERY_LOG.giveup,
        sessionId,
        context: { reason: "persistent-overload", guard },
      });
      this.broadcastPhase(sessionId, event.namespace, "give-up");
      this.clearPending(state);
      return;
    }

    // R2 rolling-hour cap.
    if (state.attempts.length >= this.config.maxAttemptsPerHour) {
      // R4 (#2485): max attempts reached for the rolling hour. Record the cause.
      this.errorLogger.info("recovery gave up: max attempts per hour", {
        category: RECOVERY_LOG.giveup,
        sessionId,
        context: {
          reason: "max-attempts",
          cap: this.config.maxAttemptsPerHour,
        },
      });
      this.broadcastPhase(sessionId, event.namespace, "give-up");
      this.clearPending(state);
      return;
    }

    // R2 cooldown ladder — index by prior attempt count, clamp to last rung.
    const ladder = this.config.cooldownLadderMs;
    const idx = Math.min(state.attempts.length, ladder.length - 1);
    const cooldown = ladder[idx] ?? ladder[ladder.length - 1] ?? 0;

    // #2375 test seam — report which rung was selected and what cooldown it
    // scheduled. Unset in production, so this is a no-op there.
    this.onCooldownScheduled?.(sessionId, idx, cooldown);

    // R2 (#2485): durably record the scheduled cooldown rung.
    this.errorLogger.info(
      `recovery scheduled: rung ${idx}, cooldown ${cooldown}ms`,
      {
        category: RECOVERY_LOG.scheduled,
        sessionId,
        context: {
          rung: idx,
          cooldownMs: cooldown,
          attempts: state.attempts.length,
        },
      }
    );

    // Schedule the dispatch. Pass the seq watermark (never a timestamp).
    this.clearPending(state);
    const errorSeq = state.errorSeq;
    const namespace = event.namespace;
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      void this.dispatchRecoveryPrompt(sessionId, errorSeq ?? 0, namespace);
    }, cooldown);
  }

  // ---------- R1/R3/R7/R9: recovery prompt dispatch ----------

  private async dispatchRecoveryPrompt(
    sessionId: string,
    errorSeq: number,
    namespace: string | undefined
  ): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;

    // R3 authoritative re-check at dispatch time: abort if the user has spoken
    // since the exhausted event. This is the load-bearing safety guard.
    const messages = this.syncEngine.getMessagesAfter(sessionId, {
      afterSeq: errorSeq,
      limit: 200,
    });
    if (messages.some(m => this.isUserInput(m.content))) {
      // R5 (#2485): the user took control since the exhausted event — record
      // the skip (the abort is now durably accounted, not silent). This is the
      // AUTHORITATIVE dispatch-time re-check; the handleMessageReceived fast
      // path may pre-empt it during cooldown without reaching here.
      this.errorLogger.info(
        "recovery skipped: user activity since exhaustion",
        { category: RECOVERY_LOG.skipUserActivity, sessionId }
      );
      // Abort, reset the exhaustion tracking but keep the attempt history for
      // rolling-hour accounting.
      this.clearPending(state);
      state.lastExhaustionAt = null;
      state.errorSeq = null;
      return;
    }

    // R7: default prompt only (no per-session prompt override — no producer).
    const promptText = this.config.defaultPrompt;

    try {
      // Direct engine call is load-bearing: the HTTP messages route hardcodes
      // sentFrom "webapp", which would make recovery prompts indistinguishable
      // from user input and break R3.
      await this.syncEngine.sendMessage(sessionId, {
        text: promptText,
        sentFrom: "auto-recovery",
      });
    } catch (err) {
      this.errorLogger.error(err instanceof Error ? err.message : String(err), {
        category: "auto-recovery-dispatch-failed",
        sessionId,
      });
      return; // no attempt recorded — the prompt never landed
    }

    const now = Date.now();
    const attempt: RecoveryAttempt = { at: now, result: "pending" };
    // R3 (#2485): record the successful dispatch. Emitted STRICTLY BEFORE the
    // push so `state.attempts.length + 1` is this attempt's number; after the
    // push the attempt is already counted and `+ 1` would over-count by one.
    this.errorLogger.info("recovery prompt dispatched", {
      category: RECOVERY_LOG.dispatched,
      sessionId,
      context: { attempt: state.attempts.length + 1 },
    });
    state.attempts.push(attempt);
    state.lastRecoveryPromptAt = now;

    // R9 success timer: if still "pending" after the success window (no new
    // exhausted event latched it), mark "recovered" and broadcast. Never bulk-
    // resets attempts — history ages out only via rolling-hour pruning.
    if (state.successTimer) clearTimeout(state.successTimer);
    state.successTimer = setTimeout(() => {
      state.successTimer = null;
      if (attempt.result !== "pending") return; // latched api-error-again
      attempt.result = "recovered";
      // R4 (#2485): success window elapsed with no new exhaustion — record the
      // recovered verdict. This callback is the ONLY place the verdict is known;
      // a restart inside the success window loses it (in-memory by epic design).
      this.errorLogger.info("recovery outcome: recovered", {
        category: RECOVERY_LOG.recovered,
        sessionId,
        context: { attempt: state.attempts.length },
      });
      state.lastRecoveryPromptAt = null;
      this.broadcastPhase(sessionId, namespace, "recovered");
    }, this.config.successWindowMs);
  }

  // ---------- R3: live user-input tracking ----------

  private handleMessageReceived(event: MessageReceivedEvent): void {
    const sessionId = event.sessionId;
    const state = this.states.get(sessionId);
    // Only relevant while a recovery is scheduled and we have a watermark.
    if (
      !state ||
      state.lastExhaustionAt === null ||
      state.errorSeq === null ||
      !state.pendingTimer
    ) {
      return;
    }

    const seq =
      typeof event.message.seq === "number" ? event.message.seq : null;
    if (seq === null || seq <= state.errorSeq) return; // watermark respected

    // The SyncEvent-layer content may be opaque; when role/meta are visible this
    // is an optimization over the authoritative dispatch-time re-check.
    if (this.isUserInput(event.message.content)) {
      // User took control before cooldown elapsed — cancel the pending recovery.
      this.clearPending(state);
      state.lastExhaustionAt = null;
      state.errorSeq = null;
    }
  }

  // ---------- Helpers ----------

  /**
   * R3 user-input predicate: a real user message is `content.role === "user"`
   * with a `content.meta.sentFrom` that is NOT a programmatic sender. The role
   * clause excludes assistant/transcript messages; the sentFrom clause (checked
   * against PROGRAMMATIC_SENT_FROM) excludes ALL server-side programmatic
   * senders — our own auto-recovery prompt AND the stall-watchdog nudge /
   * heartbeat (#2205), which now stamp distinct `watchdog` / `heartbeat` values
   * instead of masquerading as `webapp`.
   *
   * Fail-safe direction preserved: an unknown or absent `sentFrom` is treated as
   * real user input, so a genuine `webapp` / `telegram-bot` message during a
   * recovery cooldown STILL aborts the recovery (R4). The predicate only RELAXES
   * for explicitly-programmatic values.
   */
  private isUserInput(content: unknown): boolean {
    if (!content || typeof content !== "object") return false;
    const c = content as {
      role?: unknown;
      meta?: { sentFrom?: unknown } | null;
    };
    if (c.role !== "user") return false;
    const sentFrom = c.meta?.sentFrom;
    // #2205: a programmatic sender (auto-recovery / watchdog / heartbeat) is NOT
    // user input. Unknown/absent sentFrom falls through to `true` (fail-safe).
    if (typeof sentFrom === "string" && PROGRAMMATIC_SENT_FROM.has(sentFrom)) {
      return false;
    }
    return true;
  }

  /** R6 decision: per-session tri-state override wins over the global toggle. */
  private shouldRecover(session: Session, globalEnabled: boolean): boolean {
    const override = session.autoRecoverFromApiError; // boolean | null | undefined
    if (override === true) return true;
    if (override === false) return false;
    return globalEnabled; // null / undefined → follow global
  }

  private getOrCreateState(sessionId: string): SessionRecoveryState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        attempts: [],
        errorSeq: null,
        lastExhaustionAt: null,
        lastRecoveryPromptAt: null,
        pendingTimer: null,
        successTimer: null,
      };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private clearTimers(state: SessionRecoveryState): void {
    if (state.pendingTimer) clearTimeout(state.pendingTimer);
    if (state.successTimer) clearTimeout(state.successTimer);
    state.pendingTimer = null;
    state.successTimer = null;
  }

  /**
   * #4936: abandon any recovery in flight for this session — latch the pending
   * attempt `api-error-again` (truthful: it did not recover), cancel BOTH the
   * cooldown and the success timer (`clearPending` alone leaves the success
   * timer, which would later broadcast a false "recovered"), and drop the
   * exhaustion watermarks. Attempt history is kept for rolling-hour accounting.
   */
  private abandonOutstandingRecovery(
    sessionId: string,
    state: SessionRecoveryState
  ): void {
    if (state.lastRecoveryPromptAt !== null) {
      for (let i = state.attempts.length - 1; i >= 0; i--) {
        if (state.attempts[i].result === "pending") {
          state.attempts[i].result = "api-error-again";
          this.errorLogger.info("recovery outcome: api-error-again (latched)", {
            category: RECOVERY_LOG.again,
            sessionId,
            context: { attemptIndex: i },
          });
          break;
        }
      }
    }
    this.clearTimers(state);
    state.lastRecoveryPromptAt = null;
    state.lastExhaustionAt = null;
    state.errorSeq = null;
  }

  /** Cancel a scheduled-but-not-yet-fired dispatch timer. */
  private clearPending(state: SessionRecoveryState): void {
    if (state.pendingTimer) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
  }

  /**
   * Broadcast a `give-up` / `recovered` phase using B's nested LC-1 shape with a
   * synthesized `errorType`. Routed through the public handleRealtimeEvent so
   * the Toast pipeline surfaces it exactly like B's own api-error events.
   */
  private broadcastPhase(
    sessionId: string,
    namespace: string | undefined,
    phase: "give-up" | "recovered"
  ): void {
    this.syncEngine.handleRealtimeEvent({
      type: "api-error",
      sessionId,
      namespace,
      data: { phase, errorType: "overloaded_error" },
    });
  }
}
