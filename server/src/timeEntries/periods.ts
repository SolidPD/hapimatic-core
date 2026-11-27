// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan section 4.1): a session's tracked periods, and the counter
 * cut of each history row.
 *
 * Pure: nothing is imported from the store. The input is the session's
 * timeline (`buildTimeline`'s segments, each with the id of the row whose
 * settings it carries and the id of the row whose `at` begins it; the two
 * differ after an include-earlier pop), the same rows' readings, and the
 * session's stored cuts. The output is its tracked periods, each with its
 * status (`timeBillingStatus`, the only source, D-5) and its counter bounds.
 *
 * The counter bounds (items 1, 2). A row's `timerMs` is on the live scale (the
 * closed timer plus the running stretch); the stored timer and the polled
 * summary are on the closed scale. So a closed reading below a row's live
 * reading proves a loss only when no stretch that began before the row's `at`
 * was running when it was read: `isEligibleFor`. Each row's cut starts at its
 * own reading and is only ever lowered, by an eligible reading
 * (`cutsLoweredBy`); the store keeps the lowered cut of each row and epoch.
 *
 * The residual (stated in `time-entries.md`): a hub restart that loses a
 * running stretch, followed by that session's next stretch closing before the
 * first eligible reading, leaves the cut unlowered; up to the lost running
 * part before the settings change is then logged under the later period. It is
 * bounded by one stretch per restart and is never a double.
 */
import {
  timeBillingStatus,
  type TrackingBillingStatus,
  type TrackingRecord,
} from "@hapi/protocol";

/**
 * A pull's start is its drained sync time less one minute (5.4), which also
 * covers small clock differences between nodes; another node's reading counts
 * from its poll time less this margin.
 */
export const SAFE_CUT_MARGIN_MS = 60_000;

/** A history row as the period builder reads it. */
export type PeriodRow = {
  id: number;
  at: number;
  /** The row's live reading; null on `copy-not-sent` and reconciled rows. */
  timerMs: number | null;
};

/** One segment of `buildTimeline`, with the two ids Task 6 adds to it. */
export type PeriodSegment = {
  /** The row whose settings the segment carries. */
  eventId: number;
  /** The row whose `at` begins it (an include-earlier pop's untracked row). */
  beginEventId: number;
  from: number;
  to: number | null;
  record: TrackingRecord | null;
};

export type TrackedPeriod = {
  eventId: number;
  beginEventId: number;
  from: number;
  /** Null: the period is still open. */
  to: number | null;
  record: TrackingRecord;
  status: TrackingBillingStatus;
  /** `confirm` is pending: logged as Pending, released by Keep or Reverse. */
  held: boolean;
  /** The status the held period copied (D-5; item 26). */
  heldStatus: TrackingBillingStatus | null;
  /** On the counter scale: clip(cut − D(at), R of its epoch, its end: C or the next R). */
  counterFrom: number;
  counterTo: number;
  epoch: number;
  /**
   * The period begins before its own row: a turn-on that included earlier,
   * untracked time (Q4 = EA2 reads this for a session untracked at its
   * node's baseline).
   */
  included: boolean;
};

/** Where a reading came from. Only a poll's own answer and a sample lower a cut. */
export type TimerReadingOrigin =
  | "local"
  | "poll"
  | "boot"
  | "bridged"
  | "registry-exit";

export type TimerReading = {
  /** The session timer on the closed scale. */
  ms: number;
  /** When it was read: the local sample's time, or the poll that returned it. */
  pollAt: number;
  thinking: boolean;
  thinkingSince: number | null;
  origin: TimerReadingOrigin;
};

/** A row's cut as the store keeps it, with the row's time. */
export type RowCut = { eventId: number; at: number; cutMs: number };

/** The time a reading speaks for: another node's from its poll, less the margin. */
export function readingTime(reading: TimerReading): number {
  return reading.origin === "poll"
    ? reading.pollAt - SAFE_CUT_MARGIN_MS
    : reading.pollAt;
}

/**
 * 4.1 rule 2 (N-1, N-12): a reading lowers row k's cut only when it was taken
 * at or after row k's `at` and no stretch that began before row k was running
 * then. A bridged change and a registry-exit value never lower a cut: on a
 * node not in `on`, a session's end sends `thinking: false` and no timer.
 * Rule 3: the boot sample is taken before any CLI connects, when no stretch
 * can be running.
 */
export function isEligibleFor(reading: TimerReading, rowAt: number): boolean {
  if (reading.origin === "bridged" || reading.origin === "registry-exit") {
    return false;
  }
  if (readingTime(reading) < rowAt) return false;
  if (reading.origin === "boot" || !reading.thinking) return true;
  return reading.thinkingSince !== null && reading.thinkingSince > rowAt;
}

/**
 * The cuts a reading lowers: `min(cut, reading)` for each eligible row whose
 * cut is above it. Only ever lower (A-2: never recompute one "lowest
 * reading" per session, which forgot the lowering at the next history row).
 * Pure: it decides and writes nothing; the store's writer `lowerCut` (Task 5)
 * persists what it answers.
 */
export function cutsLoweredBy(
  cuts: readonly RowCut[],
  reading: TimerReading
): RowCut[] {
  const lowered: RowCut[] = [];
  for (const cut of cuts) {
    if (reading.ms < cut.cutMs && isEligibleFor(reading, cut.at)) {
      lowered.push({ ...cut, cutMs: reading.ms });
    }
  }
  return lowered;
}

/**
 * Each row's cut: its stored (lowered) cut, else its own reading, else the
 * previous row's cut (rule 4); 0 before the first reading.
 */
export function resolveRowCuts(
  rows: readonly PeriodRow[],
  stored: ReadonlyMap<number, number>
): Map<number, number> {
  const out = new Map<number, number>();
  let previous = 0;
  for (const row of rows) {
    const cut = stored.get(row.id) ?? row.timerMs ?? previous;
    out.set(row.id, cut);
    previous = cut;
  }
  return out;
}

/**
 * A `time_entry_epochs` row (4.2; plan 3c): epoch e > 0 starts at `startAt`,
 * the poll time of the fallen reading R (`startMs`, raw timer). The planner
 * reads it for the epoch's bounds only: an epoch begins at its own start and R
 * and ends at the next epoch's. It applies no ghost test of its own (3e): the
 * ghost rule is 4.2's, on the copy (Task 7), and the planner takes the history
 * rows as it is given them, because a timer-value test can drop a real row
 * written in the middle of a turn before the backup.
 */
export type EpochBound = { epoch: number; startAt: number; startMs: number };

/**
 * 4.2 (N-17): a confirmed raw timer below the epoch's high-water is a restore
 * only when two confirmed readings from two different polls are below it,
 * because a poll answered before a bridged change lowers the cached timer for
 * one poll.
 */
export function isRestoreFall(
  highRawMs: number | null,
  confirmed: readonly { ms: number; pollAt: number }[]
): boolean {
  if (highRawMs === null) return false;
  const polls = new Set(
    confirmed.filter(r => r.ms < highRawMs).map(r => r.pollAt)
  );
  return polls.size >= 2;
}

/** The fields an entry copies (R4): equal keys merge adjacent periods. */
function snapshotKey(record: TrackingRecord): string {
  return JSON.stringify([
    record.billingStatus,
    record.confirm,
    record.projectKind,
    record.projectKey,
    record.projectName,
    record.categorySource,
    record.categoryId,
    record.categoryName,
    record.defaultRateMinor,
    record.defaultCurrency,
    record.rateMinor,
    record.currency,
    record.rateNote,
    record.sync,
    record.complete,
  ]);
}

export type BuildPeriodsInput = {
  segments: readonly PeriodSegment[];
  /** Every history row of the session, in id order, as it is given them. */
  rows: readonly PeriodRow[];
  /** The session's stored lowered cuts for the epoch built, by row id. */
  cuts: ReadonlyMap<number, number>;
  /** The session's start: an include from it starts at counter 0 (rule 5). */
  sessionStartMs: number;
  /** D(t): the session's closed `on`-mode interval time before t (4.2). */
  dBeforeMs?: (t: number) => number;
  /** C: the counter lane's total from the confirmed set (0 with none). */
  counterTotalMs: number;
  /** The session's `time_entry_epochs` rows (epochs above 0), for their bounds. */
  epochs?: readonly EpochBound[];
  /** The epoch whose periods are built (0 when omitted). */
  epoch?: number;
};

type EpochWindow = {
  index: number;
  /** The epoch's start in time and its counter floor (R); none for epoch 0. */
  start: { at: number; counterMs: number } | null;
  /** The next epoch's start and R, where this one ends; null for the last. */
  end: { at: number; counterMs: number } | null;
};

/** An epoch's bounds, from the epoch list alone, whatever the confirmed slot holds. */
function epochWindow(
  input: BuildPeriodsInput,
  dBefore: (t: number) => number
): EpochWindow {
  const index = input.epoch ?? 0;
  const list = input.epochs ?? [];
  if (list.some(e => !Number.isInteger(e.epoch) || e.epoch <= 0)) {
    throw new Error("an epoch row names an epoch at or below 0");
  }
  const bound = (e: EpochBound) => ({
    at: e.startAt,
    counterMs: Math.max(0, e.startMs - dBefore(e.startAt)),
  });
  const own = list.find(e => e.epoch === index);
  if (index > 0 && !own) throw new Error(`epoch ${index} is not in the list`);
  const next = list
    .filter(e => e.epoch > index)
    .sort((a, b) => a.epoch - b.epoch)[0];
  return {
    index,
    start: own ? bound(own) : null,
    end: next ? bound(next) : null,
  };
}

/** The session's tracked periods, in time order, adjacent equal ones merged. */
export function buildPeriods(input: BuildPeriodsInput): TrackedPeriod[] {
  const { segments, rows, sessionStartMs } = input;
  const dBefore = input.dBeforeMs ?? (() => 0);
  const window = epochWindow(input, dBefore);
  // The epoch's counter ends at the next epoch's R; the last one's at C.
  const total = window.end
    ? window.end.counterMs
    : Math.max(0, input.counterTotalMs);
  const rowById = new Map(rows.map(r => [r.id, r]));
  const cutOf = resolveRowCuts(rows, input.cuts);
  const clip = (ms: number) => Math.min(Math.max(ms, 0), total);
  const counterAt = (rowId: number): number => {
    const row = rowById.get(rowId);
    if (!row) throw new Error(`history row ${rowId} is not among the rows`);
    return clip((cutOf.get(rowId) ?? 0) - dBefore(row.at));
  };
  const floor = window.start?.counterMs ?? 0;

  const out: TrackedPeriod[] = [];
  let previousTracked = false;
  segments.forEach((segment, i) => {
    const record = segment.record;
    const status = timeBillingStatus(record);
    if (record === null || status === null) {
      previousTracked = false;
      return;
    }
    const row = rowById.get(segment.eventId);
    if (!row) {
      throw new Error(`history row ${segment.eventId} is not among the rows`);
    }
    const included = segment.from < row.at;
    // Rule 5: an include over the whole untracked stretch starts at that
    // stretch's first row (0 at the session's start); one strictly inside the
    // stretch cannot be cut on a counter and starts at the turn-on's reading.
    let counterFrom: number;
    if (segment.beginEventId !== segment.eventId) {
      counterFrom = counterAt(segment.beginEventId);
    } else if (included && i === 0 && segment.from <= sessionStartMs) {
      counterFrom = 0;
    } else {
      counterFrom = counterAt(segment.eventId);
    }
    const next = segments[i + 1];
    let counterTo = next ? counterAt(next.beginEventId) : total;
    let from = segment.from;
    let to = segment.to;
    let isIncluded = included;
    const { start, end } = window;
    // Time of a later epoch: that epoch's own call builds it.
    if (end && from >= end.at) return;
    if (start) {
      if (to !== null && to <= start.at) {
        previousTracked = true;
        return;
      }
      if (from < start.at) {
        // Begun before the restore: the epoch's counter starts at R exactly,
        // whatever the row before it read (a live reading can sit above R).
        from = start.at;
        isIncluded = false;
        counterFrom = floor;
      }
      counterFrom = Math.max(counterFrom, floor);
      counterTo = Math.max(counterTo, floor);
    }
    if (end && (to === null || to > end.at)) {
      to = end.at;
      counterTo = total;
    }
    const held = record.confirm === "pending";
    const period: TrackedPeriod = {
      eventId: segment.eventId,
      beginEventId: segment.beginEventId,
      from,
      to,
      record,
      status,
      held,
      heldStatus: held ? record.billingStatus : null,
      counterFrom,
      counterTo: Math.max(counterTo, counterFrom),
      epoch: window.index,
      included: isIncluded,
    };
    const last = out[out.length - 1];
    // An included period never merges into the one before it: the planner
    // reads `included` for a session untracked at its baseline (Q4 = EA2).
    if (
      previousTracked &&
      !period.included &&
      last &&
      last.to === period.from &&
      snapshotKey(last.record) === snapshotKey(record)
    ) {
      last.to = period.to;
      last.counterTo = Math.max(last.counterTo, period.counterTo);
    } else {
      out.push(period);
    }
    previousTracked = true;
  });
  return out;
}
