// SPDX-License-Identifier: AGPL-3.0-only
/**
 * badgeFormat — shared, pure format helpers for the Session Basic Info Bar's
 * Row-2 status-icon cluster (issue #3287, S2 of the Session-UI Redesign epic
 * #3285). This is a CROSS-ISSUE CONTRACT: #3289 (MCP Chip) and #3290 consume
 * `formatMcp` for the identical `MCP 99·99·99` format, so the three text helpers
 * are the single source of truth for the epic's tri-count / count formats.
 *
 * Design decision (R6): each helper returns the FULL glyph+text string (the
 * emoji glyph is inline, not a separate SVG icon) — the 76px / 31px anchor
 * widths the issue specifies were measured against these text strings, and the
 * "space after ⏱ / MCP" and "no space after 💬" rules only have meaning when the
 * glyph lives in the string. Color is a SEPARATE helper (`loopCronColor`) so a
 * consumer can apply the worst-state token to the rendered span without coupling
 * the pure text output to any styling.
 *
 * Relative time deliberately does NOT live here — see
 * `web/src/lib/sessionHelpers.ts` `formatRelativeTimeCompact` (a same-named
 * `formatRelativeTime` already lives there; a duplicate would collide).
 */
import type { LoopCronState } from "@/types/systemJobs";

/**
 * Worst-state color tokens — byte-identical to `SessionLoopCronBadge`'s
 * `glyphColor` (issue #2453), so the always-shown badge (#3287 R3) and any other
 * consumer render the same token per state.
 */
const STATE_COLOR: Record<LoopCronState, string> = {
  live: "text-[var(--app-badge-success-text)]",
  paused: "text-[var(--app-badge-warning-text)]",
  stalled: "text-[var(--app-badge-error-text)]",
};

/**
 * Neutral/gray token for the empty (all-zero) state (R3/R6: "gray at 0"). Matches
 * the de-emphasized `--app-hint` the Row-2 message count already uses.
 */
export const LOOP_CRON_NEUTRAL_COLOR = "text-[var(--app-hint)]";

/**
 * The worst loop-cron state across the tri-count, or `null` when all three counts
 * are 0. Precedence is stalled > paused > live — byte-identical to the server's
 * `worstState` reduce (`server/src/systemJobs/service.ts`: rank live=0, paused=1,
 * stalled=2, max wins), so a count-derived color can never diverge from the
 * summary's own `worstState`.
 */
export function worstLoopCronState(
  live: number,
  paused: number,
  stalled: number
): LoopCronState | null {
  if (stalled > 0) return "stalled";
  if (paused > 0) return "paused";
  if (live > 0) return "live";
  return null;
}

/**
 * Map a single loop-cron state (or `null`) to its color token — the shared
 * state→token map behind both `loopCronColor` (worst) and the S3 compact badge's
 * best-state total color (#4383 Task 5). `null` → neutral gray.
 */
export function loopCronColorForState(state: LoopCronState | null): string {
  return state ? STATE_COLOR[state] : LOOP_CRON_NEUTRAL_COLOR;
}

/**
 * The Loop-Cron badge's worst-state color token (R6), or the neutral gray when
 * all counts are 0 (R3: the always-shown empty state `⏱ 0·0·0` is fully gray).
 */
export function loopCronColor(
  live: number,
  paused: number,
  stalled: number
): string {
  return loopCronColorForState(worstLoopCronState(live, paused, stalled));
}

/**
 * Issue #4383 (Task 5) — pure helpers for the background-agents badge (DD4–DD8,
 * DD7). All numeric displays route through `clampCount` (the `formatMessageCount`
 * `1k+` precedent) so the fixed slot can never overflow.
 */

/** Max displayed count — clamped at 99 so the compact (S3) slot can never
 *  overflow (DD7). Negative/fractional inputs floor to a safe integer. */
export const AGENT_COUNT_MAX = 99;

export function clampCount(n: number): number {
  const safe = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return Math.min(AGENT_COUNT_MAX, safe);
}

/** Green/red tokens for the robot glyph — byte-identical to the loop badge's
 *  success/error tokens so the two badges render the same hues. */
export const AGENT_SUCCESS_COLOR = "text-[var(--app-badge-success-text)]";
export const AGENT_ERROR_COLOR = "text-[var(--app-badge-error-text)]";

/**
 * The robot-glyph color (DD4–DD8). FULL badge (S2): always green. COMPACT badge
 * (S3, DD8 R2): red when any agent errored, else green. (The S3 red is a
 * reduced signal — the full badge's per-cell error count already carries it.)
 */
export function agentRobotColor(
  counts: { error: number },
  compact: boolean
): string {
  if (compact && counts.error > 0) return AGENT_ERROR_COLOR;
  return AGENT_SUCCESS_COLOR;
}

/**
 * The best (most-alive) loop-cron state across the tri-count, or `null` when all
 * three are 0. Precedence live > paused > stalled — the INVERSE of
 * `worstLoopCronState`. Drives the S3 compact loop badge's total color (DD-E9:
 * stopwatch in the WORST state's color, the total in the BEST state's color).
 */
export function bestLoopCronState(
  live: number,
  paused: number,
  stalled: number
): LoopCronState | null {
  if (live > 0) return "live";
  if (paused > 0) return "paused";
  if (stalled > 0) return "stalled";
  return null;
}

/**
 * Pick the agents-badge COMPACT FORM for the shared 76px slot (DD7, deterministic
 * — no DOM measuring). C1 (`active / total`) fits only when EVERY number rendered
 * in the slot — the loop badge's total AND the agents badge's active + total — is
 * a single digit (≤ 9, after clamping). Any two-digit number → C3 (`active` only)
 * so the two side-by-side boxes never overflow 76px.
 */
export function agentCompactForm(
  loopTotal: number,
  active: number,
  total: number
): "C1" | "C3" {
  const oneDigit = (n: number) => clampCount(n) <= 9;
  return oneDigit(loopTotal) && oneDigit(active) && oneDigit(total)
    ? "C1"
    : "C3";
}

/**
 * #4388 (R3, C1 pick) — the background-shell indicator FORM in the shared 76px
 * slot. The full `>_ N` count **pill** shows unless the slot already holds BOTH
 * the loop badge AND the agents badge; only then (three competing cells) does it
 * degrade to a presence **dot** so the slot never overflows (DD7). The full
 * agents badge is forced compact whenever a shell cell is present (the caller's
 * `compact` prop), so a `pill` always has room beside a single other cell.
 */
export function shellBadgeForm(
  hasLoops: boolean,
  hasAgents: boolean
): "full" | "pill" | "dot" {
  // Crowded (loop + agents + shells): a bare presence dot (DD7).
  if (hasLoops && hasAgents) return "dot";
  // Shells ALONE (2026-10-05): fill the 76px slot with the running·done·error
  // tri-count — the agents badge's S2 full form — instead of a narrow centered
  // `>_ N` pill leaving the rest of the slot empty.
  if (!hasLoops && !hasAgents) return "full";
  // One neighbour (loop XOR agents): the compact `>_ N` pill beside it.
  return "pill";
}

/**
 * `live·paused·stalled` — the `·`-joined tri-count of the Loop-Cron Badge (R6).
 * The three numbers are the counts of a session's `loops[].state`
 * (live·paused·stalled). Empty = `0·0·0` (R3).
 *
 * Correction pass 1 (epic #3285, 2026-09-05): the stopwatch is an SVG line
 * icon (`StopwatchIcon`) rendered by the badge — NOT an emoji glyph baked into
 * this string (the emoji rendered as a color glyph on iOS, against the E6
 * line-icon design). The helper now returns the counts only.
 */
export function formatLoopCron(
  live: number,
  paused: number,
  stalled: number
): string {
  return `${live}·${paused}·${stalled}`;
}

/**
 * `MCP a·b·c` — "MCP", a single space, then the `·`-joined tri-count (R6). The
 * shared format for the epic's MCP Chip (#3289/#3290 consume this helper).
 */
export function formatMcp(a: number, b: number, c: number): string {
  return `MCP ${a}·${b}·${c}`;
}

/**
 * The Message Count number (R4/R6): `999` for sub-1000 counts; a count `≥ 1000`
 * collapses to `1k+` so the fixed 31px slot never overflows. Negative or
 * fractional inputs are floored to a safe non-negative integer.
 *
 * Correction pass 1 (epic #3285, 2026-09-05): the chat bubble is an SVG line
 * icon (`MessageSquareIcon`, the exact E6 path) rendered by the row — NOT the
 * `💬` emoji baked into this string. The helper returns the number only; the
 * "no space after the icon" rule is the row's `gap-px` layout.
 */
export function formatMessageCount(n: number): string {
  const safe = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return safe >= 1000 ? "1k+" : String(safe);
}
