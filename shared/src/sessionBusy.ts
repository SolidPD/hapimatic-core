// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #4679: the ONE "is this session busy?" predicate for token rotation.
 *
 * Rotating an account's OAuth token revokes the access token a running `claude`
 * process holds, so every in-flight request on it fails. Two guards must agree
 * on when a session is busy, or the daemon can rotate under a session that the
 * server then refuses to restart (the #4679 incident shape):
 *
 *   - the daemon's rotation defer (`getLiveAccountKeys` → the idle-refresh
 *     backstop and `tick()` in `cli/src/accounts/tokenRefreshService.ts`), and
 *   - the server's token-refresh restart guard
 *     (`server/src/sync/accountRestart.ts` `tokenRefreshRestart`).
 *
 * `thinking` alone is not enough: it is false once a turn ends, while background
 * agents (#4383) and background shells (#4388) launched by that turn are still
 * running on the same token.
 *
 * The parameter is structural so it accepts a full `Session` (server, and the
 * daemon's parse of `/cli/sessions`) and a federation `SessionSummary`, whose
 * `backgroundAgents` is the counts-only projection. An absent or null
 * `backgroundAgents` (an older CLI, or nothing tracked) reads as not busy on
 * that axis, which is the pre-#4679 behaviour.
 */

/** The fields the busy predicate reads; satisfied by `Session` and `SessionSummary`. */
export type SessionBusySignal = {
  thinking?: boolean;
  backgroundAgents?: {
    running?: number;
    shells?: { running?: number } | null;
  } | null;
};

/** Which axis made a session busy, for log lines and the server's deferral reason. */
export type SessionBusyReason =
  | "mid-inference"
  | "background agents running"
  | "background shells running";

/**
 * Returns the first axis on which `s` is busy, or `null` when it is idle.
 * Order: inference first (the most common), then agents, then shells.
 */
export function sessionBusyReason(
  s: SessionBusySignal
): SessionBusyReason | null {
  if (s.thinking === true) return "mid-inference";
  if ((s.backgroundAgents?.running ?? 0) > 0) {
    return "background agents running";
  }
  if ((s.backgroundAgents?.shells?.running ?? 0) > 0) {
    return "background shells running";
  }
  return null;
}

/** True when rotating the session's account token now would cut off live work. */
export function isSessionBusyForRotation(s: SessionBusySignal): boolean {
  return sessionBusyReason(s) !== null;
}
