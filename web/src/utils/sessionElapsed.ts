// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Display-time elapsed-thinking math shared by the session-row timer
 * (SessionTimer), the project-header sum (ProjectTimer), and the sessions
 * toolbar total (CumulativeTimer).
 *
 * Issue #2505 introduced the leaf-level live tick (server-finalized total +
 * in-flight segment); this module extracts that formula so the project and
 * cumulative aggregates roll the in-flight segments up with identical
 * semantics. Display-only theater throughout — the optimistic segment is
 * never written back to serverAccumulatedMs or the #1892 turn ledger; when a
 * turn finalizes the server folds the segment in, the live term drops to 0,
 * and every display snaps to the authoritative total (a small backward
 * correction is expected, not a bug).
 */

/** Minimal structural shape all session types satisfy (SessionSummary etc.). */
export interface ElapsedSessionLike {
  serverAccumulatedMs?: number;
  thinking?: boolean;
  thinkingStartedAt?: number;
  isWaitingForUserQuestion?: boolean;
}

/**
 * Total ms to display for one session: the server-finalized total plus, while
 * a live segment is ticking, the elapsed segment clamped ≥ 0 so
 * client-behind-server clock skew never ticks the display negative (#2505 R5).
 */
export function elapsedWithLiveSegment(
  serverAccumulatedMs: number | undefined,
  ticking: boolean,
  thinkingStartedAt: number | undefined,
  nowMs: number
): number {
  const base = serverAccumulatedMs ?? 0;
  if (!ticking || thinkingStartedAt == null) return base;
  return base + Math.max(0, nowMs - thinkingStartedAt);
}

/**
 * Whether a session has a live in-flight thinking segment. Mirrors the
 * session row's `effectiveThinking` gate (SessionItem): a session parked on
 * an AskUserQuestion prompt is not live, so the aggregate sums stay in
 * lockstep with the per-row display they roll up.
 */
export function hasLiveSegment(s: ElapsedSessionLike): boolean {
  return (
    !!s.thinking && !s.isWaitingForUserQuestion && s.thinkingStartedAt != null
  );
}

/** Display total for one session, applying the live-segment gate. */
export function sessionDisplayElapsedMs(
  s: ElapsedSessionLike,
  nowMs: number
): number {
  return elapsedWithLiveSegment(
    s.serverAccumulatedMs,
    hasLiveSegment(s),
    s.thinkingStartedAt,
    nowMs
  );
}

/** Sum of display totals across sessions (project / cumulative rollups). */
export function sumDisplayElapsedMs(
  sessions: readonly ElapsedSessionLike[],
  nowMs: number
): number {
  return sessions.reduce(
    (sum, s) => sum + sessionDisplayElapsedMs(s, nowMs),
    0
  );
}

/** True when any session in the set has a live segment (gates the 1/s tick). */
export function anyLiveSegment(
  sessions: readonly ElapsedSessionLike[]
): boolean {
  return sessions.some(hasLiveSegment);
}
