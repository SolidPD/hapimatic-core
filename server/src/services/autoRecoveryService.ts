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
 * #3612 adds a second path for a usage-window lock (the 5-hour or weekly cap):
 * on the `rateLimited` rising edge (#3618's published seam, wired in
 * `index.ts`) it schedules ONE nudge at the reset time instead of the ladder,
 * and suppresses the ladder for that session while the nudge is armed. With no
 * usable reset time it schedules nothing and the ladder runs as before.
 *
 * Event-driven (subscribe + setTimeout), NOT poll-based — structurally similar
 * to StallWatchdogService minus the poll loop. All per-session state is
 * in-memory and resets on restart (acceptable per the epic).
 */

import type { SyncEngine, Session, SyncEvent } from "../sync/syncEngine";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { ErrorLogger } from "../logging/errorLogger";
import {
  apiErrorNotification,
  usageWindowNudgeNotification,
} from "../notifications/producerNotifications";
import { sessionModelFamily } from "../accounts/accountHeadroom";
import type { AutoRecoveryConfig } from "../config/autoRecoveryConfig";
import { readAutoRecoverPreferences } from "../web/routes/preferences";
import { PROGRAMMATIC_SENT_FROM } from "../sync/sentFrom";
import { isLocalMode } from "./autoSwitchOnRateLimit";
import {
  canonicalizeErrorType,
  isRecoverByDefaultClass,
  isTerminalClass,
} from "@hapi/protocol/apiErrorClasses";
import {
  findUsageRowHardLock,
  type AccountUsage,
  type HardLockWindow,
} from "@hapi/protocol";

const ROLLING_HOUR_MS = 3_600_000;

/** #3612: the API class a usage-window 429 is normalized to. */
const USAGE_WINDOW_CLASS = "rate_limit_error";
const FIVE_HOUR_MS = 5 * ROLLING_HOUR_MS;
const WEEK_MS = 7 * 24 * ROLLING_HOUR_MS;
/**
 * #3612 R5: the longest a reset can be away, per window. A reset beyond its
 * window's length is a bad value, so the ladder handles the lock. The session's
 * own reset gets the 5-hour bound because `rateLimited` does not say which
 * window it belongs to. Since #6065 the CLI value is Claude Code's structured
 * reset when the record carries one, else a date-aware text parse, so the bound
 * now only declines a weekly reset more than 5 hours out. Such a reset gets a
 * nudge only when the account snapshot holds that lock.
 */
const WINDOW_LENGTH_MS: Record<HardLockWindow | "session", number> = {
  five_hour: FIVE_HOUR_MS,
  seven_day: WEEK_MS,
  weekly_scoped: WEEK_MS,
  session: FIVE_HOUR_MS,
};

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
  // #6065 (D7): the user drives a local-mode session from its terminal; any
  // message would switch it to remote and abort that terminal session.
  skipLocalMode: "auto-recovery-skip-local-mode",
  // #3612: the usage-window reset nudge. Skips that share a cause with the
  // ladder (remote owner, no session, preference, class opt-out) reuse the
  // ladder's categories with `context.trigger: "usage-window"`.
  usageWindowScheduled: "auto-recovery-usage-window-scheduled",
  usageWindowRescheduled: "auto-recovery-usage-window-rescheduled",
  usageWindowDispatched: "auto-recovery-usage-window-dispatched",
  usageWindowSkip: "auto-recovery-usage-window-skip",
  usageWindowEnded: "auto-recovery-usage-window-ended",
  usageWindowFallback: "auto-recovery-usage-window-fallback",
  ladderSuppressed: "auto-recovery-ladder-suppressed-usage-window",
  ladderReplayed: "auto-recovery-ladder-replayed-usage-window",
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
  /**
   * #3612: the usage-window reset nudge. Its own field, never `pendingTimer`:
   * the ladder clears `pendingTimer` before it schedules, so sharing it would
   * let each path cancel the other. Cleared by `clearTimers`, not by
   * `clearPending`. While it is set, the ladder is suppressed for the session.
   */
  usageWindowTimer: ReturnType<typeof setTimeout> | null;
  /** #3612: the reset time the armed nudge is for (dedup key with the session). */
  usageWindowResetAt: number | null;
  /** #3612: the account the armed nudge's session is bound to (stagger index). */
  usageWindowAccount: string | null;
  /** #3612 R5: the nudge already moved once to a later reset; it will not again. */
  usageWindowRescheduled: boolean;
  /**
   * #3612 W13: the exhausted event the ladder skipped because a nudge was armed,
   * with the seq watermark of the FIRST skip. Suppression is a deferral, never a
   * drop: if the nudge ends without sending its prompt (cancelled, skipped,
   * session gone), this replays into the ladder so it runs exactly as it would
   * have without the nudge — later. Dropped when the nudge sends its prompt.
   * Not cleared by `clearUsageWindow` (re-arming must keep it).
   */
  deferredLadder: {
    errorType: string;
    errorSeq: number;
    namespace: string | undefined;
  } | null;
}

/** #3612: where a usage-window reset time came from. */
interface ResolvedReset {
  resetAt: number;
  source: "account" | "session";
  window: HardLockWindow | "session";
}

/**
 * #3612: what the usage-window nudge needs beyond the ladder's dependencies.
 * Optional so every existing construction is unchanged; without `usageService`
 * the nudge falls back to the session's own parsed reset time.
 */
export interface AutoRecoveryUsageWindowDeps {
  /** The shared usage cache. Read with `getLatest()` only, never a refresh. */
  usageService?: { getLatest(): AccountUsage[] | null } | null;
  /** Test seam — clock. Defaults to Date.now. */
  now?: () => number;
  /** Test seam — the [0, 1) source for the jitter. Defaults to Math.random. */
  random?: () => number;
  /**
   * Test-only observer, fired with the delay the nudge asked `setTimeout` for
   * and the reset time it targets — the same contract as `onCooldownScheduled`.
   * Never set in production. Side-effect-free and must not throw.
   */
  onUsageWindowNudgeScheduled?: (
    sessionId: string,
    delayMs: number,
    resetAt: number
  ) => void;
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
    ) => void,
    /** #3612: usage-window nudge dependencies (optional, last). */
    private readonly usageWindow: AutoRecoveryUsageWindowDeps = {}
  ) {}

  private now(): number {
    return this.usageWindow.now?.() ?? Date.now();
  }

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

  private async handleApiError(
    event: ApiErrorEvent,
    /** #3612 W13: a replayed deferred event keeps its original seq watermark (R3). */
    errorSeqOverride?: number
  ): Promise<void> {
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

    // #3612 Task 2b(a): a usage-window nudge is armed for this session, so the
    // reset time owns its recovery — the ladder would retry a locked account at
    // 60 s / 5 min / 15 min and give up long before the reset. Only an ARMED
    // nudge suppresses: a lock with no usable reset time arms nothing, and the
    // ladder runs as before (R5). The event is DEFERRED, not dropped (W13): if
    // the nudge ends without sending its prompt, it replays into the ladder.
    const armed = this.states.get(sessionId);
    if (armed?.usageWindowTimer) {
      armed.deferredLadder ??= {
        errorType: data.errorType,
        errorSeq: this.syncEngine.getMaxSeq(sessionId),
        namespace: event.namespace,
      };
      this.errorLogger.info(
        "recovery ladder suppressed: usage-window nudge armed",
        {
          category: RECOVERY_LOG.ladderSuppressed,
          sessionId,
          context: { at: "schedule", errorType: data.errorType },
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
    state.errorSeq = errorSeqOverride ?? this.syncEngine.getMaxSeq(sessionId);

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
    // #3612 W13: the rung carries its own class (a later deferral keeps it) and
    // whether it is a replay (a replayed rung only re-prompts a live session).
    const rung = {
      errorType: data.errorType,
      replayed: errorSeqOverride !== undefined,
    };
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      void this.dispatchRecoveryPrompt(
        sessionId,
        errorSeq ?? 0,
        namespace,
        rung
      );
    }, cooldown);
  }

  // ---------- R1/R3/R7/R9: recovery prompt dispatch ----------

  private async dispatchRecoveryPrompt(
    sessionId: string,
    errorSeq: number,
    namespace: string | undefined,
    /** #3612 W13: the rung's class, and whether it replays a deferred event. */
    rung: { errorType: string; replayed: boolean }
  ): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;

    // #3612 Task 2b(b): the rising edge can land AFTER the exhausted event (the
    // keepAlive carrying the latch can lose the race to the error report), so a
    // rung scheduled before the nudge was armed is caught here. The first rung
    // is 60 s, which is always later than the latch. A rung is NOT cancelled on
    // the rising edge itself: if #3618 switches the account, the cleared edge
    // disarms the nudge and this rung becomes the post-switch re-prompt #3618
    // R7 relies on. If the rung fires while the nudge is still armed, it is
    // deferred like a schedule-time skip (W13), so a later cancel replays it.
    if (state.usageWindowTimer) {
      state.deferredLadder ??= {
        errorType: rung.errorType,
        errorSeq,
        namespace,
      };
      this.errorLogger.info(
        "recovery ladder suppressed: usage-window nudge armed",
        {
          category: RECOVERY_LOG.ladderSuppressed,
          sessionId,
          context: { at: "dispatch" },
        }
      );
      return;
    }

    // #3612 W13: a replayed rung can come hours after its error. It re-prompts
    // only a session that is running again — after a #3618 switch the restart
    // is long done — and never one that has since ended (D2: no respawn, and no
    // false "recovered" for a session that is gone).
    if (rung.replayed && !this.syncEngine.getSession(sessionId)?.active) {
      this.errorLogger.info(
        "recovery skipped: replayed rung for a session that is not active",
        {
          category: RECOVERY_LOG.usageWindowSkip,
          sessionId,
          context: { reason: "replay-inactive" },
        }
      );
      state.lastExhaustionAt = null;
      state.errorSeq = null;
      return;
    }

    // #6065 (D7): never prompt a local-mode session. A message makes the local
    // launcher switch to remote mode and abort the user's terminal session.
    // Read at dispatch time, because the mode can change during the cooldown.
    const current = this.syncEngine.getSession(sessionId);
    if (current && isLocalMode(current)) {
      this.errorLogger.info("recovery skipped: session is in local mode", {
        category: RECOVERY_LOG.skipLocalMode,
        sessionId,
        context: { at: "dispatch" },
      });
      this.abortPendingRecovery(state);
      return;
    }

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
      this.abortPendingRecovery(state);
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

  // ---------- #3612: usage-window reset nudge ----------

  /**
   * #3612: the `rateLimited` rising-edge observer (#3618's published seam,
   * wired in `index.ts`). Never throws — the seam is synchronous and the policy
   * reads the preference file, so errors are contained here.
   */
  onUsageWindowRisingEdge(sessionId: string, session?: Session): void {
    void this.scheduleUsageWindowNudge(sessionId, session).catch(err => {
      this.errorLogger.error(err instanceof Error ? err.message : String(err), {
        category: RECOVERY_LOG.usageWindowSkip,
        sessionId,
        context: { reason: "error" },
      });
    });
  }

  /**
   * #3612: schedule ONE nudge at the session's usage-window reset time, plus
   * the account stagger and jitter (R1, R6). Schedules nothing — so the ladder
   * keeps the lock — when the reset time is missing or out of range (R5).
   */
  async scheduleUsageWindowNudge(
    sessionId: string,
    session?: Session
  ): Promise<void> {
    // R7: only the owning node acts. The seam fires before any switch policy,
    // so this is not inherited from it.
    if (this.registry && this.registry.findNodeForSession(sessionId) !== null) {
      this.errorLogger.info("recovery skipped: session is remote-owned", {
        category: RECOVERY_LOG.skipRemote,
        sessionId,
        context: { trigger: "usage-window" },
      });
      return;
    }
    const current = session ?? this.syncEngine.getSession(sessionId);
    if (!current) {
      this.errorLogger.info("recovery skipped: session not found", {
        category: RECOVERY_LOG.skipNoSession,
        sessionId,
        context: { trigger: "usage-window" },
      });
      return;
    }
    // #6065 (D7): never arm a nudge for a local-mode session. Arming tells the
    // user "Auto-resume in …", which a terminal-driven session must not be
    // promised; the fire-time check catches a switch to local mode later.
    if (isLocalMode(current)) {
      this.errorLogger.info("usage-window nudge not scheduled: local mode", {
        category: RECOVERY_LOG.usageWindowSkip,
        sessionId,
        context: { reason: "local-mode" },
      });
      return;
    }
    if (!(await this.usageWindowAllowed(sessionId, current))) return;

    const now = this.now();
    const reset = this.resolveReset(current, now);
    if (!reset) {
      this.errorLogger.info(
        "usage-window nudge not scheduled: no usable reset time — ladder keeps the lock",
        {
          category: RECOVERY_LOG.usageWindowFallback,
          sessionId,
          context: { sessionResetAt: current.rateLimited?.resetAt ?? null },
        }
      );
      return;
    }

    const state = this.getOrCreateState(sessionId);
    // Dedup: a repeated rising edge for the same reset while the nudge is armed
    // is a no-op. A clear → re-arm cycle (a keepAlive gap nulls `rateLimited`,
    // the next keepAlive restores it) cancels on the clear and re-arms here; its
    // notification coalesces on the reset time.
    if (state.usageWindowTimer && state.usageWindowResetAt === reset.resetAt) {
      this.errorLogger.info("usage-window nudge already scheduled", {
        category: RECOVERY_LOG.usageWindowSkip,
        sessionId,
        context: { reason: "dedup", resetAt: reset.resetAt },
      });
      return;
    }
    this.clearUsageWindow(state);
    this.armUsageWindow(sessionId, current, state, reset, now, false);
  }

  /**
   * #3612: cancel the nudge — the latch cleared (recovered, switched, or ended).
   * Any ladder work the nudge deferred replays now (W13): after a #3618 switch
   * that is the re-prompt R7 relies on, and after a user's own message the
   * ladder's dispatch-time check aborts it.
   */
  cancelUsageWindowNudge(sessionId: string): void {
    const state = this.states.get(sessionId);
    if (!state?.usageWindowTimer) return;
    this.clearUsageWindow(state);
    this.errorLogger.info("usage-window nudge cancelled: rate limit cleared", {
      category: RECOVERY_LOG.usageWindowSkip,
      sessionId,
      context: { reason: "cleared" },
    });
    this.replayDeferredLadder(sessionId, state, "cancelled");
  }

  /**
   * #3612 W13: hand a deferred exhausted event back to the ladder, keeping its
   * original seq watermark. The nudge is disarmed first, so the ladder is not
   * suppressed again; its own gates and caps apply as usual.
   */
  private replayDeferredLadder(
    sessionId: string,
    state: SessionRecoveryState,
    reason: string
  ): void {
    const deferred = state.deferredLadder;
    if (!deferred) return;
    state.deferredLadder = null;
    this.errorLogger.info("recovery ladder resumed: usage-window nudge ended", {
      category: RECOVERY_LOG.ladderReplayed,
      sessionId,
      context: { reason, errorSeq: deferred.errorSeq },
    });
    void this.handleApiError(
      {
        type: "api-error",
        sessionId,
        namespace: deferred.namespace,
        data: { phase: "exhausted", errorType: deferred.errorType },
      } as ApiErrorEvent,
      deferred.errorSeq
    );
  }

  /**
   * #3612 R4: the ladder's own three gates, read FRESH — the per-class opt-out
   * for `rate_limit_error` is an absolute veto, then the master toggle and the
   * per-session override.
   */
  private async usageWindowAllowed(
    sessionId: string,
    session: Session
  ): Promise<boolean> {
    const pref = await readAutoRecoverPreferences(this.settingsFile);
    if (pref.classOverrides?.[USAGE_WINDOW_CLASS] === false) {
      this.errorLogger.info(
        `recovery skipped: class "${USAGE_WINDOW_CLASS}" opted out`,
        {
          category: RECOVERY_LOG.skipClassOptOut,
          sessionId,
          context: { trigger: "usage-window", class: USAGE_WINDOW_CLASS },
        }
      );
      return false;
    }
    if (!this.shouldRecover(session, pref.enabled)) {
      this.errorLogger.info("recovery skipped: disabled by preference", {
        category: RECOVERY_LOG.skipDisabled,
        sessionId,
        context: {
          trigger: "usage-window",
          globalEnabled: pref.enabled,
          sessionOverride: session.autoRecoverFromApiError ?? null,
        },
      });
      return false;
    }
    return true;
  }

  /**
   * #3612 R2/R5: the reset time to wait for. The account's own lock from the
   * cached usage snapshot comes first — the same `findUsageRowHardLock` the
   * spawn refusal uses, including the session model's weekly window — because
   * it knows which window is locked. The session value (structured or
   * date-aware since #6065) is the fallback. A reset closer than `resetNudgeMinLeadMs` or beyond its
   * window's length is not usable.
   */
  private resolveReset(session: Session, now: number): ResolvedReset | null {
    const account = this.accountReset(session, now);
    if (account) return account;
    const resetAt = session.rateLimited?.resetAt;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) return null;
    return this.inRange(resetAt, "session", now)
      ? { resetAt, source: "session", window: "session" }
      : null;
  }

  /** #3612: the session's bound account's lock, from the cached snapshot. */
  private accountReset(session: Session, now: number): ResolvedReset | null {
    const accountUuid = session.metadata?.accountUuid;
    if (!accountUuid) return null;
    let rows: AccountUsage[] | null = null;
    try {
      rows = this.usageWindow.usageService?.getLatest() ?? null;
    } catch {
      return null; // an unreadable cache is no data — fall back
    }
    const row = rows?.find(r => r.accountUuid === accountUuid);
    const lock = findUsageRowHardLock(row, {
      modelFamily: sessionModelFamily(session),
      now,
    });
    if (!lock) return null;
    const resetAt = Date.parse(lock.resetsAt);
    return this.inRange(resetAt, lock.window, now)
      ? { resetAt, source: "account", window: lock.window }
      : null;
  }

  private inRange(
    resetAt: number,
    window: ResolvedReset["window"],
    now: number
  ): boolean {
    const lead = resetAt - now;
    return (
      lead >= this.config.resetNudgeMinLeadMs &&
      lead <= WINDOW_LENGTH_MS[window]
    );
  }

  /**
   * #3612 R6: arm the nudge. Sessions on one account share its reset time, so
   * the k-th armed session on that account waits k account-stagger steps
   * longer; the random jitter spreads accounts that reset together.
   */
  private armUsageWindow(
    sessionId: string,
    session: Session,
    state: SessionRecoveryState,
    reset: ResolvedReset,
    now: number,
    rescheduled: boolean
  ): void {
    const accountUuid = session.metadata?.accountUuid ?? null;
    let index = 0;
    if (accountUuid) {
      for (const [id, other] of this.states) {
        if (
          id !== sessionId &&
          other.usageWindowTimer &&
          other.usageWindowAccount === accountUuid
        ) {
          index++;
        }
      }
    }
    const random = this.usageWindow.random?.() ?? Math.random();
    const delayMs = Math.max(
      0,
      Math.round(
        reset.resetAt -
          now +
          index * this.config.resetNudgeAccountStaggerMs +
          random * this.config.resetNudgeJitterMs
      )
    );

    state.usageWindowResetAt = reset.resetAt;
    state.usageWindowAccount = accountUuid;
    state.usageWindowRescheduled = rescheduled;
    // One live timer per session, whatever the caller did first.
    if (state.usageWindowTimer) clearTimeout(state.usageWindowTimer);
    state.usageWindowTimer = setTimeout(() => {
      state.usageWindowTimer = null;
      void this.fireUsageWindowNudge(sessionId).catch(err => {
        this.errorLogger.error(
          err instanceof Error ? err.message : String(err),
          { category: "auto-recovery-dispatch-failed", sessionId }
        );
      });
    }, delayMs);

    this.usageWindow.onUsageWindowNudgeScheduled?.(
      sessionId,
      delayMs,
      reset.resetAt
    );
    this.errorLogger.info(
      `usage-window nudge ${rescheduled ? "rescheduled" : "scheduled"} in ${delayMs}ms`,
      {
        category: rescheduled
          ? RECOVERY_LOG.usageWindowRescheduled
          : RECOVERY_LOG.usageWindowScheduled,
        sessionId,
        context: {
          resetAt: reset.resetAt,
          source: reset.source,
          window: reset.window,
          delayMs,
          accountIndex: index,
        },
      }
    );
    // Finding D (#4936 → here): a capped session tells the user when it will
    // resume, instead of waiting silently.
    this.syncEngine.notifyUser(
      usageWindowNudgeNotification({
        sessionId,
        phase: "usage-window-scheduled",
        resumesAt: now + delayMs,
        resetAt: reset.resetAt,
        delayMs,
        window: reset.window,
      })
    );
  }

  /**
   * #3612: the reset time arrived. Resume the session only when it is still
   * running, still latched, idle, and allowed; move once to a later reset when
   * the account is still locked (R5); never respawn a stopped session (D2).
   * Every exit that does not send the prompt replays any deferred ladder work
   * (W13); only a sent prompt drops it. The stopped-session branch is a guard:
   * a session that ends normally clears its latch first, which cancels here.
   */
  private async fireUsageWindowNudge(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    const resetAt = state.usageWindowResetAt;
    const rescheduled = state.usageWindowRescheduled;
    const skip = (reason: string): void => {
      this.clearUsageWindow(state);
      this.errorLogger.info(`usage-window nudge skipped: ${reason}`, {
        category: RECOVERY_LOG.usageWindowSkip,
        sessionId,
        context: { reason, resetAt },
      });
      this.replayDeferredLadder(sessionId, state, reason);
    };

    const session = this.syncEngine.getSession(sessionId);
    if (!session) return skip("no-session");
    if (!session.active) {
      // D2: `sendMessage` resumes a live turn and cannot revive a dead child.
      // Record it and tell the user; respawning is left to them.
      this.clearUsageWindow(state);
      this.errorLogger.info(
        "usage-window reset reached but the session is not active — not respawned",
        {
          category: RECOVERY_LOG.usageWindowEnded,
          sessionId,
          context: { resetAt },
        }
      );
      this.syncEngine.notifyUser(
        usageWindowNudgeNotification({
          sessionId,
          phase: "usage-window-ended",
          resumesAt: resetAt ?? this.now(),
          resetAt: resetAt ?? undefined,
        })
      );
      this.replayDeferredLadder(sessionId, state, "ended");
      return;
    }
    // The latch cleared without an observed edge (normally `cancel` ran).
    if (!session.rateLimited) return skip("cleared");
    if (!(await this.usageWindowAllowed(sessionId, session))) {
      this.clearUsageWindow(state);
      // The replay runs the deferred event's OWN class gates: a rate_limit_error
      // stays quiet; a deferred overloaded_error rung may still run.
      this.replayDeferredLadder(sessionId, state, "disallowed");
      return;
    }
    // #6065 (D7): the user drives a local-mode session; a nudge would switch it
    // to remote and abort their terminal session. The replayed ladder rung is
    // skipped at its own dispatch for the same reason.
    if (isLocalMode(session)) return skip("local-mode");
    // A turn is running, so the session is already working again.
    if (session.thinking) return skip("busy");

    const now = this.now();
    if (!rescheduled) {
      const later = this.accountReset(session, now);
      if (later) {
        this.armUsageWindow(sessionId, session, state, later, now, true);
        return;
      }
    }

    this.clearUsageWindow(state);
    try {
      // Direct engine call with a programmatic sender, like the ladder, so the
      // nudge is never mistaken for user input.
      await this.syncEngine.sendMessage(sessionId, {
        text: this.config.resetNudgePrompt,
        sentFrom: "auto-recovery",
      });
    } catch (err) {
      this.errorLogger.error(err instanceof Error ? err.message : String(err), {
        category: "auto-recovery-dispatch-failed",
        sessionId,
        context: { trigger: "usage-window" },
      });
      // The prompt never landed, so the ladder takes the lock back.
      this.replayDeferredLadder(sessionId, state, "dispatch-failed");
      return;
    }
    // The nudge was the recovery; the ladder work it deferred is no longer owed.
    state.deferredLadder = null;
    // One nudge only. If the account is still locked, the new 429's exhausted
    // event finds no armed nudge and the ladder takes over as the backstop.
    this.errorLogger.info("usage-window nudge dispatched", {
      category: RECOVERY_LOG.usageWindowDispatched,
      sessionId,
      context: { resetAt },
    });
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
      this.abortPendingRecovery(state);
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
        usageWindowTimer: null,
        usageWindowResetAt: null,
        usageWindowAccount: null,
        usageWindowRescheduled: false,
        deferredLadder: null,
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
    this.clearUsageWindow(state);
    state.deferredLadder = null; // stop() / abandon: nothing is owed any more
  }

  /** #3612: disarm the usage-window nudge and forget what it was for. */
  private clearUsageWindow(state: SessionRecoveryState): void {
    if (state.usageWindowTimer) clearTimeout(state.usageWindowTimer);
    state.usageWindowTimer = null;
    state.usageWindowResetAt = null;
    state.usageWindowAccount = null;
    state.usageWindowRescheduled = false;
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
   * Abort a pending recovery: cancel the dispatch timer and reset the
   * exhaustion tracking, but keep the attempt history for rolling-hour
   * accounting.
   */
  private abortPendingRecovery(state: SessionRecoveryState): void {
    this.clearPending(state);
    state.lastExhaustionAt = null;
    state.errorSeq = null;
  }

  /**
   * Broadcast a `give-up` / `recovered` phase using B's nested LC-1 shape with a
   * synthesized `errorType`. Routed through the public handleRealtimeEvent so
   * the Toast pipeline surfaces it exactly like B's own api-error events.
   *
   * Issue #4914: also raise the user notification — `give-up` at `error` (never
   * coalesced, mirrored to error_logs as `notification:api-error`), `recovered`
   * at `info`. `notifyUser` resolves the namespace from the session when the
   * triggering event carried none.
   */
  private broadcastPhase(
    sessionId: string,
    namespace: string | undefined,
    phase: "give-up" | "recovered"
  ): void {
    // TODO(#4912): legacy api-error SyncEvent, kept for one release so a
    // pre-#4915 web client still toasts. Remove its SSE/web delivery once Sub C
    // (#4915) has shipped for a release. Server consumers: this service's own
    // handleEvent (ignores these phases) + sessionStateWaiter (give-up is an
    // error edge) — keep the internal event or migrate them first.
    this.syncEngine.handleRealtimeEvent({
      type: "api-error",
      sessionId,
      namespace,
      data: { phase, errorType: "overloaded_error" },
    });
    this.syncEngine.notifyUser({
      ...apiErrorNotification({
        sessionId,
        phase,
        errorType: "overloaded_error",
      }),
      namespace: namespace ?? null,
    });
  }
}
