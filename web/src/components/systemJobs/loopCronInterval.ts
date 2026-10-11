// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Loop-cron interval parse/format helpers (issue #3294, Session-UI Redesign S9).
 *
 * The interval-string grammar that `reschedule` accepts is `1-59m | 1-23h`
 * (there is NO `d` unit). It is enforced twice, byte-identically, on the server —
 * those two regexes are the ONLY grammar authorities:
 *   - `loopRescheduleSchema` regex — server/src/web/routes/systemJobs.ts:147-153
 *   - `INTERVAL_RE`             — server/src/systemJobs/loopCronController.ts:104-105
 *
 * This module mirrors that regex VERBATIM so the IntervalSelector (#3294) can
 * never emit a value the backend rejects. It is a thin UI-side input-constraint
 * layer — there is no scheduler-backend change (R2/R3). `scheduleConverters.ts`
 * (Scheduler domain) owns NO interval vocabulary and MUST NOT carry this grammar.
 */

export type IntervalUnit = "m" | "h";

export type ParsedInterval = { value: number; unit: IntervalUnit };

/**
 * The accepting grammar `1-59m | 1-23h`, mirrored verbatim from the two server
 * regexes named above. No `d` unit exists.
 */
export const INTERVAL_RE = /^([1-9]|[1-5][0-9])m$|^([1-9]|1[0-9]|2[0-3])h$/;

/** Per-unit inclusive clamps — matching the grammar exactly (m: 1-59, h: 1-23). */
export const UNIT_BOUNDS: Record<IntervalUnit, { min: number; max: number }> = {
  m: { min: 1, max: 59 },
  h: { min: 1, max: 23 },
};

/**
 * Parse a grammar-valid interval string into `{ value, unit }`, or `null` when
 * the string is OUTSIDE the `1-59m | 1-23h` grammar — a cron expression, an
 * out-of-grammar legacy value (a loop armed before #2453's validation), empty,
 * or non-numeric. A `null` return is the graceful-degrade signal for the caller
 * (R3): never a thrown error, never a corruption of the stored value.
 */
export function parseInterval(
  raw: string | null | undefined
): ParsedInterval | null {
  if (raw == null) return null;
  const s = raw.trim();
  if (!INTERVAL_RE.test(s)) return null;
  const unit = s.slice(-1) as IntervalUnit;
  const value = parseInt(s.slice(0, -1), 10);
  return { value, unit };
}

/**
 * Format `{ value, unit }` back into the interval string. The value is clamped
 * to the unit's bounds and truncated to an integer first, so the output is
 * ALWAYS grammar-valid — a lossless round-trip holds for every grammar-valid
 * input, and an out-of-range value can never be produced (defense-in-depth
 * alongside the selector's own clamp).
 */
export function formatInterval({ value, unit }: ParsedInterval): string {
  const { min, max } = UNIT_BOUNDS[unit];
  const clamped = Math.min(max, Math.max(min, Math.trunc(value)));
  return `${clamped}${unit}`;
}
