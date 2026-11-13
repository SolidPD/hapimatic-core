// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Split an interval into local-calendar-day portions (issue #6586, R9).
 *
 * The portions' `ms` sum to `endMs - startMs` exactly, including on DST-change
 * days. Pure: nothing is imported from the store, the config or the parity module.
 * The zone is a parameter and is resolved by the reader at read time (Task 12),
 * never by the node that recorded the interval.
 *
 * Day boundaries are found by this file's own search, never by
 * `localDayBoundsMs` (`server/src/parity/timeParityDerivation.ts`), which assumes a
 * 24 h day and is wrong on DST-change days (#6598).
 */

export interface DayPortion {
  /** `YYYY-MM-DD` in the given zone. */
  localDate: string;
  ms: number;
}

/**
 * The search window. A local day can last 26 h (Antarctica/Troll) or 27 h
 * (Antarctica/Casey, 2022-03-12), so a window that still ends on the same date is
 * extended by another 26 h until the date differs.
 */
const SEARCH_WINDOW_MS = 26 * 60 * 60 * 1000;

/**
 * One formatter per zone, built once. `localDateForTimestamp` builds a new
 * `Intl.DateTimeFormat` on every call, measured on ms2 at 51 to 81 µs a call
 * against 1 to 3 µs cached; a boundary search makes about 29 date computations and
 * the hub runs on one thread.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

let formattersBuilt = 0;
let dateComputations = 0;

/** Call counts for the cost test (a wall-clock budget fails on a loaded node). */
export function daySplitCounters(): {
  formattersBuilt: number;
  dateComputations: number;
} {
  return { formattersBuilt, dateComputations };
}

/** Zero the counters; the formatter cache is kept. */
export function resetDaySplitCounters(): void {
  formattersBuilt = 0;
  dateComputations = 0;
}

/**
 * The same options as `localDateForTimestamp`, so the dates match it exactly. An
 * unknown zone raises `RangeError`, which propagates: the read route validates the
 * zone first, and a silent fallback zone would put time on the wrong day.
 */
function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timezone, formatter);
    formattersBuilt++;
  }
  return formatter;
}

function dateAt(formatter: Intl.DateTimeFormat, ms: number): string {
  dateComputations++;
  return formatter.format(new Date(ms));
}

/** The first millisecond after `cur` whose date differs from `curDate`. */
function nextBoundary(
  formatter: Intl.DateTimeFormat,
  cur: number,
  curDate: string
): number {
  let lo = cur;
  let hi = cur + SEARCH_WINDOW_MS;
  while (dateAt(formatter, hi) === curDate) {
    lo = hi;
    hi += SEARCH_WINDOW_MS;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (dateAt(formatter, mid) === curDate) lo = mid;
    else hi = mid;
  }
  return hi;
}

export function splitIntervalByLocalDay(
  startMs: number,
  endMs: number,
  timezone: string
): DayPortion[] {
  if (endMs <= startMs) return [];
  const formatter = formatterFor(timezone);

  const firstDate = dateAt(formatter, startMs);
  if (dateAt(formatter, endMs - 1) === firstDate) {
    return [{ localDate: firstDate, ms: endMs - startMs }];
  }

  const portions: DayPortion[] = [];
  let cur = startMs;
  let curDate = firstDate;
  while (cur < endMs) {
    const boundary = nextBoundary(formatter, cur, curDate);
    const stop = Math.min(boundary, endMs);
    const last = portions[portions.length - 1];
    if (last !== undefined && last.localDate === curDate) {
      last.ms += stop - cur;
    } else {
      portions.push({ localDate: curDate, ms: stop - cur });
    }
    cur = stop;
    if (cur < endMs) curDate = dateAt(formatter, cur);
  }
  return portions;
}
