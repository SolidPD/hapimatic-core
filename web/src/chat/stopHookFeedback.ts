// SPDX-License-Identifier: AGPL-3.0-only
import type { AgentTextBlock } from "./types";

// #3778: the literal prefix Claude Code emits at the start of a Stop-hook feedback
// record (verbatim from `getStopHookMessage`; empirically confirmed in the prod DB as
// `"Stop hook feedback:\n…"`). Used only as the FALLBACK signal for the ~218 legacy
// records that predate the #2162 `isMeta` flag — the flag is the primary signal.
export const STOP_HOOK_FEEDBACK_PREFIX = "Stop hook feedback:";

// #3778 (R5): the dimmed banner rendered between the two responses in place of the
// hook part's prose.
export const STOP_HOOK_BANNER_LABEL =
  "Stop hook fired — Claude continued below";

// #3778 (R5, Task 5): the small inline badge attributing the response that FOLLOWS the
// hook boundary to the Stop hook firing.
export const AFTER_HOOK_BADGE_LABEL = "Continued after Stop hook";

/**
 * #3778: the ONE shared predicate for "this agent-text block is a Stop-hook feedback
 * record" — the reducer (segment-boundary reset) and the render layer (per-part banner)
 * MUST use the same test so flag-carrying records (SDK via #2162, PTY/tmux native) and
 * legacy flag-less records get identical treatment (R2).
 *
 * Primary signal: the #2162 `isMeta` flag (stamped for EVERY synthetic user record).
 * Fallback: the literal `"Stop hook feedback:"` text prefix, for the legacy flag-less
 * records only — a real assistant response could in principle begin with that literal,
 * so the flag wins when present.
 */
export function isStopHookFeedbackBlock(b: AgentTextBlock): boolean {
  return b.isMeta === true || b.text.startsWith(STOP_HOOK_FEEDBACK_PREFIX);
}
