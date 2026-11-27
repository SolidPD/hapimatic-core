// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan 7.6; Q1 = RM2, N1 = SC1, N2 = SE1): which of a session's
 * new spans a clock control or an agent's word removes from billing. Pure.
 *
 * The candidates are the planner's `newCoverage` at the preview's moment: the
 * session's tracked, post-baseline, not-yet-covered time, logged or pending,
 * so an exclusion only ever lowers what is billed and never covers time that
 * an entry or another exclusion already holds.
 *
 * - Reset, and an agent's exclusion (as a Reset): every candidate.
 * - Set X: X is the time to keep; `A = max(0, U − X)` is removed, newest first:
 *   the interval lane's newest time first, the oldest piece cut by time, then
 *   the top of the counter (`[confirmed − a, confirmed)`); nothing when X ≥ U.
 * - Disable (a range): the interval spans inside it, cut by time; the counter's
 *   spans only when the range holds the confirmed reading's time (a counter
 *   cannot be cut by wall time); a past range removes nothing there.
 * Adjust has no span to remove and is not a control here.
 */
import type { NewCoverage } from "../../timeEntries/amount";

export type ClockControl =
  | "clock-reset"
  | "clock-set"
  | "clock-disable"
  | "agent";

export type ControlChoice =
  | { control: "clock-reset" | "agent" }
  | { control: "clock-set"; keepMs: number }
  | {
      control: "clock-disable";
      range: { fromMs: number; toMs: number };
      /** The confirmed counter reading's poll time; null when there is none. */
      confirmedAt: number | null;
    };

const len = (s: NewCoverage) => s.toMs - s.fromMs;
export const spansMs = (spans: readonly NewCoverage[]): number =>
  spans.reduce((sum, s) => sum + len(s), 0);

const ordered = (spans: NewCoverage[]): NewCoverage[] =>
  spans.sort(
    (a, b) =>
      a.lane.localeCompare(b.lane) ||
      a.key.localeCompare(b.key) ||
      a.fromMs - b.fromMs
  );

/** The newest `ms` of `spans` (by their end, highest first), cutting the oldest piece. */
function newestFirst(spans: readonly NewCoverage[], ms: number): NewCoverage[] {
  const out: NewCoverage[] = [];
  let left = ms;
  for (const span of [...spans].sort((a, b) => b.toMs - a.toMs)) {
    if (left <= 0) break;
    const take = Math.min(left, len(span));
    out.push({ ...span, fromMs: span.toMs - take });
    left -= take;
  }
  return out;
}

export function selectExcludedSpans(
  candidates: readonly NewCoverage[],
  choice: ControlChoice
): NewCoverage[] {
  const live = candidates.filter(s => len(s) > 0);
  if (choice.control === "clock-reset" || choice.control === "agent") {
    return ordered(live.map(s => ({ ...s })));
  }
  if (choice.control === "clock-set") {
    if (!Number.isSafeInteger(choice.keepMs) || choice.keepMs < 0) return [];
    const remove = Math.max(0, spansMs(live) - choice.keepMs);
    const intervals = live.filter(s => s.lane === "interval");
    const fromIntervals = newestFirst(intervals, remove);
    const rest = remove - spansMs(fromIntervals);
    const counter = live.filter(s => s.lane === "counter");
    return ordered([...fromIntervals, ...newestFirst(counter, rest)]);
  }
  if (choice.control !== "clock-disable") return [];
  const { fromMs, toMs } = choice.range;
  const inRange = live
    .filter(s => s.lane === "interval")
    .map(s => ({
      ...s,
      fromMs: Math.max(s.fromMs, fromMs),
      toMs: Math.min(s.toMs, toMs),
    }))
    .filter(s => s.toMs > s.fromMs);
  const holdsReading =
    choice.confirmedAt !== null &&
    choice.confirmedAt >= fromMs &&
    choice.confirmedAt <= toMs;
  const counter = holdsReading
    ? live.filter(s => s.lane === "counter").map(s => ({ ...s }))
    : [];
  return ordered([...inRange, ...counter]);
}
