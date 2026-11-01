// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The RateLimitDetector wiring shared by the transcript launchers: pty, tmux
 * and local (#6065). Like the #1101 `mcpToggleService` factories, one factory
 * is the symmetry contract. Every transcript launcher reports a usage-window
 * cap the same way, and the wiring is unit-tested here once instead of per
 * launcher. The SDK launcher keeps its own two-callback block: its `thinking`
 * is stream-derived, so it never needs the spend-limit thinking clear (and
 * #4569 owns that site).
 */

import { RateLimitDetector } from "../utils/rateLimitDetector";

/** The session surface the detector drives (AgentSessionBase satisfies it). */
export interface RateLimitSessionSink {
  setRateLimited(
    state: { resetText: string; resetAt: number | null; since: number } | null
  ): void;
  onThinkingChange(thinking: boolean): void;
}

export function createSessionRateLimitDetector(
  session: RateLimitSessionSink,
  opts: {
    /** Test seam: the clock that stamps `since`. Defaults to Date.now. */
    now?: () => number;
  } = {}
): RateLimitDetector {
  const now = opts.now ?? Date.now;
  return new RateLimitDetector(
    // Issue #1647: the rising edge flips the session into the rate-limited
    // state, which also clears `thinking`: a rate-limited turn fires no Stop
    // hook under the transcript launchers, so the #1611 latch would stick.
    (_sessionId, info) => {
      session.setRateLimited({
        resetText: info.resetText,
        resetAt: info.resetAt,
        since: now(),
      });
    },
    // Issue #3235: clear the chip on the FALLING edge (genuine forward
    // progress). onThinkingChange no longer clears `rateLimited`; each
    // launcher's teardown clears it separately.
    () => session.setRateLimited(null),
    // Issue #4936: an API spend cap / user-set spend limit never latches the
    // chip (it is not a usage window), so clear `thinking` at that turn
    // boundary: TurnEndDetector skips synthetic records and no Stop hook fires
    // on an API-error turn under the transcript launchers.
    () => session.onThinkingChange(false)
  );
}
