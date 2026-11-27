// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The context-reset gate as pure functions (issue #6559, Task 8; R4, R5, R6,
 * R11, R13).
 *
 * `checkArm` answers an arm (armed, or a refusal reason; nothing is left
 * pending after a refusal). `decideFire` answers a pending request at fire
 * time: reset now, defer and look again, or deliver the text without a reset.
 * The service gathers the facts; these functions only decide, so every reason is
 * one row of a truth table (`policy.test.ts`).
 *
 * Not reasons, on purpose: a queued message (the queue-drain hold covers that
 * race) and an active file claim (claims survive a reset and the preamble lists
 * them, ruling Q4a).
 */

import {
  LOCK_HELD_HARD_TRIGGERS,
  RESUME_MAX_CHARS,
  carriesApprovalToken,
  stageFieldsProblem,
  type ContextResetArmRefusal,
  type ContextResetArmRequest,
  type ContextResetDeferReason,
  type ContextResetServerNoResetReason,
  type ContextResetTrigger,
} from "@hapi/protocol";
import {
  sessionBusyReason,
  type SessionBusySignal,
} from "@hapi/protocol/sessionBusy";

/**
 * How long past its deadline a request keeps deferring while the session is
 * rate limited: a message sent into a rate-limited session waits there anyway.
 */
export const RATE_LIMIT_GRACE_MS = 60 * 60_000;

export interface ArmFacts {
  /** The switch, read fresh. */
  enabled: boolean;
  sessionActive: boolean;
  /** The session's open turn, or null when none is open. */
  openTurnSeq: number | null;
  /** `metadata.launcherKind`; only `sdk` has an actuator. */
  launcherKind: string | undefined;
  /** The session already has an `armed` or `firing` request. */
  hasPendingRequest: boolean;
  /** An unanswered approval challenge (`hasPendingChallenge`). */
  challengePending: boolean;
  /**
   * The busy signal. Its `thinking` is ignored here: the arming call runs inside
   * the session's own open turn.
   */
  busy: SessionBusySignal;
  /** In-session timers the wrapper saw (the arm's `wrapperFacts.sessionTimers`). */
  sessionTimers: number;
  /** A watermark handoff is armed or in flight. */
  handoffActive: boolean;
  request: ContextResetArmRequest;
}

export type ArmDecision =
  | { armed: true }
  | { armed: false; reason: ContextResetArmRefusal };

function refuse(reason: ContextResetArmRefusal): ArmDecision {
  return { armed: false, reason };
}

/** Answer an arm. The first matching reason wins; `disabled` beats every other. */
export function checkArm(facts: ArmFacts): ArmDecision {
  const { request } = facts;
  if (!facts.enabled) return refuse("disabled");
  if (!facts.sessionActive) return refuse("session_inactive");
  if (facts.openTurnSeq === null) return refuse("no_open_turn");
  if (facts.launcherKind !== "sdk") return refuse("launcher_unsupported");
  const stage = stageFieldsProblem(request);
  if (stage) return refuse(stage);
  // The free text the server renders into the message must not carry a token
  // prefix (R9). The stage fields are checked by their shapes above.
  const freeText = [request.resume, request.checkpointPath, request.fromStage];
  if (freeText.some(t => typeof t === "string" && carriesApprovalToken(t))) {
    return refuse("token_in_resume");
  }
  if (request.resume.length > RESUME_MAX_CHARS)
    return refuse("resume_too_long");
  if (facts.hasPendingRequest) return refuse("already_pending");
  if (facts.challengePending) return refuse("challenge_pending");
  const busy = sessionBusyReason({ ...facts.busy, thinking: false });
  if (busy !== null) return refuse("background_work");
  if (facts.sessionTimers > 0) return refuse("session_timers");
  if (facts.handoffActive) return refuse("handoff_active");
  return { armed: true };
}

export interface FireFacts {
  /** The switch, read fresh. */
  enabled: boolean;
  now: number;
  trigger: ContextResetTrigger;
  /** False once another turn ran or the session respawned. */
  resetAllowed: boolean;
  deadlineAtMs: number;
  sessionActive: boolean;
  /** A session-alive has arrived since the hub booted. */
  aliveSinceBoot: boolean;
  launcherKind: string | undefined;
  busy: SessionBusySignal;
  permissionPending: boolean;
  tuiBlocked: boolean;
  rateLimited: boolean;
  /** The watermark handoff holds the session. */
  handoffHeld: boolean;
  /** `settleMs` has passed since the arming turn's clean finalize. */
  settled: boolean;
  challengePending: boolean;
  /**
   * The lock labels the session added and has not removed: `none`, `held`, or
   * `unknown` when the read is missing, stale or unresolved.
   */
  lock: "none" | "held" | "unknown";
}

export type FireDecision =
  | { action: "reset" }
  | { action: "defer"; reason: ContextResetDeferReason }
  | { action: "no_reset"; reason: ContextResetServerNoResetReason };

function noReset(reason: ContextResetServerNoResetReason): FireDecision {
  return { action: "no_reset", reason };
}

function deferral(facts: FireFacts): ContextResetDeferReason | null {
  if (!facts.sessionActive) return "session_inactive";
  if (!facts.aliveSinceBoot) return "no_alive_since_boot";
  const busy = sessionBusyReason(facts.busy);
  if (busy === "mid-inference") return "thinking";
  if (busy !== null) return "background_work";
  if (facts.permissionPending) return "permission_pending";
  if (facts.tuiBlocked) return "tui_blocked";
  if (facts.rateLimited) return "rate_limited";
  if (facts.handoffHeld) return "handoff_held";
  if (!facts.settled) return "settling";
  if (facts.lock === "unknown") return "lock_unknown";
  return null;
}

/**
 * Answer a pending request. A hard condition delivers the text without a reset
 * at once; otherwise a safe point that does not hold defers until the deadline.
 * Past the deadline: a rate-limited session keeps deferring for up to
 * `RATE_LIMIT_GRACE_MS`, an inactive one keeps deferring (the service ends it
 * `expired` and sends nothing), and anything else is delivered without a reset.
 */
export function decideFire(facts: FireFacts): FireDecision {
  if (!facts.enabled) return noReset("disabled");
  if (!facts.resetAllowed) return noReset("reset_not_allowed");
  if (facts.challengePending) return noReset("challenge_pending");
  if (facts.launcherKind !== "sdk") return noReset("launcher_unsupported");
  // Ruling Q5a: a held lock is a hard reason only for the listed triggers; for
  // any other trigger the reset fires and the preamble names the lock.
  if (
    facts.lock === "held" &&
    LOCK_HELD_HARD_TRIGGERS.includes(facts.trigger)
  ) {
    return noReset("lock_held");
  }
  const reason = deferral(facts);
  if (reason === null) return { action: "reset" };
  if (facts.now < facts.deadlineAtMs) return { action: "defer", reason };
  if (reason === "session_inactive") return { action: "defer", reason };
  if (
    reason === "rate_limited" &&
    facts.now < facts.deadlineAtMs + RATE_LIMIT_GRACE_MS
  ) {
    return { action: "defer", reason };
  }
  return noReset("deadline_passed");
}

/**
 * The challenge test. A challenge is pending when a challenge file of the
 * session's worktree has a nonce different from its key's grant nonce (or has
 * no grant). A global-scope challenge counts only when its record carries this
 * session's id or tag. A minted grant alone blocks nothing: the grant is a file
 * bound to the worktree state, and the closer consumes it in whichever
 * conversation starts the close. Not covered: a global-scope challenge whose
 * record carries no session id.
 */
export function hasPendingChallenge(input: {
  challenges: readonly { key: string; nonce: string | null }[];
  grantNonceByKey: ReadonlyMap<string, string>;
  globalChallengeSessionIds: readonly (string | null)[];
  /** The session's id and tag. */
  sessionIds: readonly string[];
}): boolean {
  for (const c of input.challenges) {
    const granted = input.grantNonceByKey.get(c.key);
    if (c.nonce === null || granted !== c.nonce) return true;
  }
  return input.globalChallengeSessionIds.some(
    id => id !== null && input.sessionIds.includes(id)
  );
}
