// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan 8.3; R13): a session's figures, the one answer #6484's
 * guard and #6778's swap point read (Q5 = OC12-1). Pure: `TimeEntryStore`'s
 * `figuresFor` gathers the facts inside one read and calls this.
 *
 * `known: false` comes first, in the order 8.3 names the reasons:
 * `no_owner`, `stale_copy`, `no_baseline`, `epoch_pending`. Two sources (the
 * Project Manager's final ruling on Task 5's reading D): the store's own rows
 * give `no_baseline` (the planner blocked) and `epoch_pending` (the mark holds
 * a confirmed reading below its epoch's high_raw_ms); the service (Task 9; the
 * restore block is Task 22's) gives `no_owner`, `stale_copy` and its restore
 * block as `epoch_pending`, in a required input with no default. Known only
 * when the store's rows are clean and the caller passed "not blocked".
 */
import type { TimeEntryFigures } from "@hapi/protocol";
import type { Plan } from "../../timeEntries/amount";

const MS_PER_MINUTE = 60_000;

/** The service's state for the session: every field required, never defaulted. */
export type FiguresBlock = {
  noOwner: boolean;
  staleCopy: boolean;
  epochPending: boolean;
};

export type FiguresFacts = {
  sessionId: string;
  asOf: number;
  block: FiguresBlock;
  /** The planner's dry run at `asOf`. */
  plan: Plan;
  carryInMs: number;
  /** Whether the session's last period is open (it is tracked now). */
  tracked: boolean;
  /**
   * The store's own epoch sign (ruling D, final): the mark holds a confirmed
   * reading below its current epoch's high_raw_ms, a fall no epoch has opened.
   */
  markFallen: boolean;
  /** Logged minutes whose sync row waits, failed or has a change pending. */
  unsyncedMinutes: number;
  /** The measured time of the session's exclusions not released. */
  excludedMs: number;
  /** The closed timer the periods were built from, on the timer scale. */
  timerMs: number | null;
  /** The counter's top at the cut (the last period's `counterTo`), on the counter scale. */
  counterTopMs: number;
  /** The lowered cut of a tracking-off row that is the session's last row. */
  untrackedFromMs: number | null;
  baseline: {
    baselineMs: number | null;
    /** `baseline_tracked`; null when no reading was recorded. */
    tracked: boolean | null;
    settled: boolean;
    /** Every historical entry's minutes (receipts and the settlement). */
    historicalMinutes: number;
  };
};

/** Refuses a block whose fields are not all set: no default can hide a block. */
export function checkFiguresBlock(block: unknown): FiguresBlock {
  const b = block as Partial<Record<keyof FiguresBlock, unknown>> | null;
  if (
    b === null ||
    typeof b !== "object" ||
    typeof b.noOwner !== "boolean" ||
    typeof b.staleCopy !== "boolean" ||
    typeof b.epochPending !== "boolean"
  ) {
    throw new TypeError(
      "time entries: block needs noOwner, staleCopy and epochPending, each true or false"
    );
  }
  return b as FiguresBlock;
}

export function figuresOf(facts: FiguresFacts): TimeEntryFigures {
  const { sessionId, asOf, plan } = facts;
  const block = checkFiguresBlock(facts.block);
  const unknown = (
    reason: "no_owner" | "stale_copy" | "no_baseline" | "epoch_pending"
  ): TimeEntryFigures => ({ sessionId, known: false, reason, asOf });
  if (block.noOwner) return unknown("no_owner");
  if (block.staleCopy) return unknown("stale_copy");
  if (plan.blocked !== null) return unknown("no_baseline");
  // Both sources; neither turns the other into known (ruling D, final).
  if (block.epochPending || facts.markFallen) return unknown("epoch_pending");
  const unloggedMs = facts.carryInMs + plan.newMs;
  const { baselineMs, tracked, settled, historicalMinutes } = facts.baseline;
  // 8.3: baseline_ms less the historical minutes for a session tracked at its
  // baseline; 0 for one untracked at it (its earlier time comes through an
  // include, which unloggedMs counts). Under Matt Starfield's answer TO1 on
  // ba.tt-tracked-then-off (2.6, D-14) it stays 0 for one untracked at its
  // baseline: unloggedMs counts that session's tracked pre-baseline time once
  // the second pull request's TO1 branch plans it (this one still cuts it).
  const preBaselineMs =
    tracked === false || baselineMs === null
      ? 0
      : Math.max(0, baselineMs - historicalMinutes * MS_PER_MINUTE);
  return {
    sessionId,
    known: true,
    tracked: facts.tracked,
    unloggedMinutes: Math.floor(unloggedMs / MS_PER_MINUTE),
    unloggedMs,
    unsyncedMinutes: facts.unsyncedMinutes,
    excludedMs: facts.excludedMs,
    coveredThroughMs: coveredThrough(facts),
    ...(facts.untrackedFromMs === null
      ? {}
      : { untrackedFromMs: facts.untrackedFromMs }),
    asOf,
    preBaselineMs,
    preBaselineSettled: settled,
  };
}

/**
 * 8.3: the highest timer value below which every part of the session's
 * tracked, post-baseline, not-excluded time is covered. On the counter it is
 * the first uncovered counter value, moved to the timer scale by the timer's
 * distance from the counter's top; new interval time (which has no timer
 * value) is taken off below it, so the answer never claims more coverage than
 * there is. Null without a timer reading.
 */
export function coveredThrough(facts: FiguresFacts): number | null {
  const { timerMs, counterTopMs, plan } = facts;
  if (timerMs === null || plan.blocked !== null) return null;
  let firstGap = counterTopMs;
  let intervalMs = 0;
  for (const span of plan.newCoverage) {
    if (span.lane === "counter") firstGap = Math.min(firstGap, span.fromMs);
    else intervalMs += span.toMs - span.fromMs;
  }
  const onTimer = Math.min(timerMs, timerMs - (counterTopMs - firstGap));
  return Math.max(0, onTimer - intervalMs);
}
