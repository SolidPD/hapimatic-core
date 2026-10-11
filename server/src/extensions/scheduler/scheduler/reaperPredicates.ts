// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared scheduled-session reaper predicates (epic #2698, issue #2701).
 *
 * These are the ONE definition of "which sessions the scheduler may touch" and
 * "which of those are safe to archive right now". Every reaper layer — L1
 * completion reap (#2701), L2 idle reap (#2702), L4 cap-pressure reap (#2703) —
 * MUST consume these helpers and never re-express the conditions inline, so the
 * layers cannot disagree about safe-to-reap (epic coordination F4/F6).
 *
 * Callers resolve the session via `syncEngine.getSession(id)`, never from a
 * `session-updated` event payload: those payloads are partial (#2702 review
 * finding 2702-3), so a field read off `event.data` may simply be absent.
 */

import type { Session } from "@hapi/protocol/types";

/**
 * True when the session was spawned by the scheduler as an ordinary
 * (non-heartbeat) scheduled run. Heartbeat spawns are tagged `"heartbeat"`
 * (`taskExecutor.ts` `updateSessionSource`) and user/PM sessions carry no
 * source, so both are excluded by construction. This is the safety-critical
 * "never touch interactive or PM sessions" invariant (epic F6).
 */
export function isSchedulerScopedSession(
  session: Session | undefined
): boolean {
  return session?.metadata?.source === "scheduler";
}

/**
 * True when archiving the session now cannot cut off in-flight work: it is
 * live, not mid-turn, not blocked on a TUI prompt, and not rate-limited. A
 * blocked or rate-limited session presents as a frozen `thinking`, so all four
 * conditions are required (epic F4, #2702 review finding 2702-4).
 */
export function isSafeToReap(session: Session | undefined): boolean {
  return (
    !!session &&
    session.active &&
    !session.thinking &&
    session.blockedOnTuiPrompt == null &&
    session.rateLimited == null
  );
}
