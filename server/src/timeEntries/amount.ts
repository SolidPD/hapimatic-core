// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan sections 4.2 and 4.3): the planner, pure.
 *
 * One rule for both bases: covered time is counted once, the sub-minute
 * remainder is carried per session, in time order, across periods (R5). The
 * amount is computed from what is covered, never from what a run remembers,
 * so a missed night, a stop, a race and a late copy are the same case.
 *
 * Two lanes (4.2): the interval lane holds each closed `on`-mode row of the
 * session, cut by time to the periods; the counter lane holds one number C on
 * the scale `buildPeriods` gives (clip(cut − D(at), 0, C)). Coverage keys are
 * the interval id, and `e<epoch>` on the counter lane, so work after a restore
 * that passes through counter values the old epoch covered is new work.
 *
 * Per period, in time order (4.3):
 * 1. new time = the period's part of each interval row less the spans already
 *    covered for that row, plus `[counterFrom, counterTo)` less the spans
 *    covered for the epoch. Span subtraction is general, so a counter that fell
 *    and rose within one epoch is taken once; a row re-closed longer adds only
 *    its tail and a row re-closed shorter adds nothing.
 * 2. pool = carry + new; minutes = floor(pool / 60 000); carry = the rest. A
 *    portion with no whole minute writes nothing and joins the next entry.
 * 3. A period with time on both lanes gives one entry per lane, intervals
 *    first; a portion too small for its own entry goes with the next entry,
 *    whose basis names the larger part and whose `basisMs` holds both. Over
 *    1,440 minutes an entry is split: the first piece takes the carry in, every
 *    piece but the last carries out 0.
 * 4. The baseline (items 6, 7): time before the session's node `log_from` is
 *    never new. An interval row counts whole when it closed after `log_from`
 *    and not at all when it closed at or before it; the counter starts at the
 *    session's baseline on the counter scale in epoch 0, and at its own R in a
 *    later epoch (every minute after a restore is new). For a session
 *    untracked at its baseline (Q4 = EA2, N4 = UN1), an included period is not
 *    cut there: its rows before `log_from` count and its counter starts at the
 *    include's reach, less, oldest first, the minutes of the session's
 *    historical entries. Every other period is cut, the session's tracked
 *    periods before `log_from` included (Matt Starfield's answer on
 *    `ba.tt-tracked-then-off`, plan 2.6, is TO1, D-14 of 2026-11-26: this pull
 *    request keeps the cut rule, and TO1's branch is the second pull
 *    request's first task).
 * 5. Exclusions and switch steps are coverage owned by `tx:` ids: their time
 *    is covered, so it never enters the pool or the carry.
 *
 * Invariant on every entry: carry_in + measured = minutes × 60 000 + carry_out.
 */
import { TIME_ENTRY_MINUTES_MAX, type TimeEntryLane } from "@hapi/protocol";
import type { TrackedPeriod } from "./periods";

export const MS_PER_MINUTE = 60_000;
const PIECE_MS = TIME_ENTRY_MINUTES_MAX * MS_PER_MINUTE;

/** A closed `on`-mode interval row of the session (a row of D). */
export type IntervalRow = {
  id: string;
  startMs: number;
  endMs: number;
  launcherKind: string | null;
};

/** A stored coverage span; `ownerId` is an entry id or an exclusion's `tx:` id. */
export type CoverageSpan = {
  lane: TimeEntryLane;
  key: string;
  fromMs: number;
  toMs: number;
  ownerId: string;
};

export type NewCoverage = Omit<CoverageSpan, "ownerId">;

export type PlanBaseline = {
  /** The node's `log_from`. */
  logFromMs: number;
  /** The session's `baseline_ms` on the counter scale; null when none is adopted. */
  baselineCounterMs: number | null;
  /** Whether the session was tracked at its baseline (`baseline_tracked`). */
  tracked: boolean;
  /** The minutes of the session's historical entries that are not the settlement. */
  historicalMinutes: number;
};

export type PlanInput = {
  periods: readonly TrackedPeriod[];
  /** The rows of D; a row that closed after the cut waits for the next run. */
  intervals: readonly IntervalRow[];
  cutMs: number;
  /**
   * The session's launcher kind on the counter lane (OC-11). Each period names
   * its own epoch, and its counter spans are keyed by it (4.3 step 1), so one
   * plan logs an old epoch's part up to the next epoch's R with the new work.
   */
  counter: { launcherKind: string | null };
  covered: readonly CoverageSpan[];
  /** The `carry_out_ms` of the session's newest entry of kind `time`. */
  carryInMs: number;
  /** Null: the session's node has no baseline row, nothing is planned. */
  baseline: PlanBaseline | null;
};

export type PlannedEntry = {
  period: TrackedPeriod;
  minutes: number;
  measuredMs: number;
  carryInMs: number;
  carryOutMs: number;
  basis: "intervals" | "timer";
  /** Both parts, set only when the entry holds time of both lanes. */
  basisMs: { interval: number; counter: number } | null;
  coverage: NewCoverage[];
  /** The interval lane's first start and last end; null on the counter lane. */
  firstMs: number | null;
  lastMs: number | null;
  launcherMs: Record<string, number>;
};

export type Plan =
  | {
      blocked: null;
      entries: PlannedEntry[];
      /** The carry the session holds after the plan's entries. */
      carryOutMs: number;
      /** New time found, logged or not. */
      newMs: number;
      /** Tracked and not logged after the plan: the carry and the pending portions. */
      unloggedMs: number;
      /**
       * Every new span the walk found, logged or pending, in walk order: the
       * time an exclusion's preview may cover (7.6). Its total is `newMs`, so
       * `Σ newCoverage + carryIn = Σ entries' minutes × 60 000 + unloggedMs`.
       */
      newCoverage: NewCoverage[];
    }
  | {
      blocked: "no_baseline";
      entries: [];
      carryOutMs: number;
      newMs: 0;
      unloggedMs: 0;
      newCoverage: [];
    };

type Span = { from: number; to: number };

/** `target` less the union of `holes`, in order. */
export function subtractSpans(target: Span, holes: readonly Span[]): Span[] {
  if (target.to <= target.from) return [];
  const sorted = holes
    .filter(h => h.to > target.from && h.from < target.to)
    .sort((a, b) => a.from - b.from);
  const out: Span[] = [];
  let cursor = target.from;
  for (const hole of sorted) {
    if (hole.from > cursor) out.push({ from: cursor, to: hole.from });
    cursor = Math.max(cursor, hole.to);
    if (cursor >= target.to) break;
  }
  if (cursor < target.to) out.push({ from: cursor, to: target.to });
  return out;
}

const spanMs = (spans: readonly Span[]) =>
  spans.reduce((sum, s) => sum + (s.to - s.from), 0);

/** A lane portion of a period: spans on one coverage key. */
type Part = NewCoverage & { launcherKind: string };

/** Takes the first `ms` of `parts`, in order; cuts one part when it must. */
function takeParts(parts: Part[], ms: number): { taken: Part[]; rest: Part[] } {
  const taken: Part[] = [];
  let left = ms;
  let i = 0;
  for (; i < parts.length && left > 0; i += 1) {
    const part = parts[i]!;
    const len = part.toMs - part.fromMs;
    if (len <= left) {
      taken.push(part);
      left -= len;
    } else {
      taken.push({ ...part, toMs: part.fromMs + left });
      const rest = [
        { ...part, fromMs: part.fromMs + left },
        ...parts.slice(i + 1),
      ];
      return { taken, rest };
    }
  }
  return { taken, rest: parts.slice(i) };
}

/** Removes the first `ms` of the spans, oldest first; returns what is left to remove. */
function dropFirst(spans: Span[], ms: number): { kept: Span[]; left: number } {
  const kept: Span[] = [];
  let left = ms;
  for (const span of spans) {
    const len = span.to - span.from;
    if (left >= len) {
      left -= len;
    } else {
      kept.push({ from: span.from + left, to: span.to });
      left = 0;
    }
  }
  return { kept, left };
}

function coveredFor(
  covered: readonly CoverageSpan[],
  lane: TimeEntryLane,
  key: string
): Span[] {
  return covered
    .filter(c => c.lane === lane && c.key === key)
    .map(c => ({ from: c.fromMs, to: c.toMs }));
}

/** The plan for one session at one cut. Pure; writes nothing. */
export function planSession(input: PlanInput): Plan {
  const { baseline } = input;
  if (baseline === null) {
    return blocked(input.carryInMs);
  }
  // A period reaching before log_from of a session with no baseline reading
  // is not planned: the session is blocked until one is adopted (5.1; B-1).
  if (
    baseline.baselineCounterMs === null &&
    input.periods.some(p => p.from < baseline.logFromMs)
  ) {
    return blocked(input.carryInMs);
  }

  const coveredByEpoch = new Map<string, Span[]>();
  const counterCoveredFor = (key: string): Span[] => {
    let spans = coveredByEpoch.get(key);
    if (!spans) {
      spans = coveredFor(input.covered, "counter", key);
      coveredByEpoch.set(key, spans);
    }
    return spans;
  };
  const counterLauncher = input.counter.launcherKind ?? "unknown";
  const intervals = input.intervals
    .filter(r => r.endMs > r.startMs && r.endMs <= input.cutMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  // The time the record knows the old path billed for this session (EA2):
  // removed, oldest first, from the uncut pre-baseline part of its includes.
  let billedLeft = baseline.tracked
    ? 0
    : Math.max(0, baseline.historicalMinutes) * MS_PER_MINUTE;

  const entries: PlannedEntry[] = [];
  let pending: Part[] = [];
  let carry = input.carryInMs;
  let newMs = 0;
  const newCoverage: NewCoverage[] = [];

  const emit = (period: TrackedPeriod) => {
    let pool =
      carry + spanMs(pending.map(p => ({ from: p.fromMs, to: p.toMs })));
    let minutes = Math.floor(pool / MS_PER_MINUTE);
    if (minutes === 0) return;
    let carryIn = carry;
    while (minutes > 0) {
      const pieceMinutes = Math.min(minutes, TIME_ENTRY_MINUTES_MAX);
      const last = pieceMinutes === minutes;
      const takeMs = last ? pool - carryIn : PIECE_MS - carryIn;
      const { taken, rest } = takeParts(pending, takeMs);
      const measuredMs = spanMs(
        taken.map(p => ({ from: p.fromMs, to: p.toMs }))
      );
      const carryOut = carryIn + measuredMs - pieceMinutes * MS_PER_MINUTE;
      entries.push(
        entryOf(period, pieceMinutes, measuredMs, carryIn, carryOut, taken)
      );
      pending = rest;
      pool -= carryIn + measuredMs;
      minutes -= pieceMinutes;
      carryIn = 0;
      carry = carryOut;
    }
  };

  for (const period of input.periods) {
    const uncut = !baseline.tracked && period.included;
    const periodEnd = period.to ?? Number.POSITIVE_INFINITY;

    // The interval lane.
    for (const row of intervals) {
      const overlap = {
        from: Math.max(row.startMs, period.from),
        to: Math.min(row.endMs, periodEnd),
      };
      if (overlap.to <= overlap.from) continue;
      const preBaseline = row.endMs <= baseline.logFromMs;
      if (preBaseline && !uncut) continue;
      let candidate: Span[] = [overlap];
      if (preBaseline && billedLeft > 0) {
        const dropped = dropFirst(candidate, billedLeft);
        candidate = dropped.kept;
        billedLeft = dropped.left;
      }
      const holes = coveredFor(input.covered, "interval", row.id);
      for (const span of candidate) {
        for (const free of subtractSpans(span, holes)) {
          pending.push({
            lane: "interval",
            key: row.id,
            fromMs: free.from,
            toMs: free.to,
            launcherKind: row.launcherKind ?? "unknown",
          });
          newCoverage.push({
            lane: "interval",
            key: row.id,
            fromMs: free.from,
            toMs: free.to,
          });
          newMs += free.to - free.from;
        }
      }
    }
    emit(period);

    // The counter lane: [counterFrom, counterTo) of the period's epoch.
    const counterKey = `e${period.epoch}`;
    const counterCovered = counterCoveredFor(counterKey);
    // The baseline is epoch 0's floor only: a later epoch starts at its own R,
    // after the restore, so all of its work is new (5.6 step 2).
    const baselineCounter =
      period.epoch === 0 ? (baseline.baselineCounterMs ?? 0) : 0;
    let counterSpans: Span[] = [];
    if (uncut) {
      const pre = {
        from: period.counterFrom,
        to: Math.min(period.counterTo, baselineCounter),
      };
      let preSpans: Span[] = pre.to > pre.from ? [pre] : [];
      if (billedLeft > 0 && preSpans.length > 0) {
        const dropped = dropFirst(preSpans, billedLeft);
        preSpans = dropped.kept;
        billedLeft = dropped.left;
      }
      counterSpans = [
        ...preSpans,
        {
          from: Math.max(period.counterFrom, baselineCounter),
          to: period.counterTo,
        },
      ];
    } else {
      counterSpans = [
        {
          from: Math.max(period.counterFrom, baselineCounter),
          to: period.counterTo,
        },
      ];
    }
    for (const span of counterSpans) {
      for (const free of subtractSpans(span, counterCovered)) {
        pending.push({
          lane: "counter",
          key: counterKey,
          fromMs: free.from,
          toMs: free.to,
          launcherKind: counterLauncher,
        });
        counterCovered.push(free);
        newCoverage.push({
          lane: "counter",
          key: counterKey,
          fromMs: free.from,
          toMs: free.to,
        });
        newMs += free.to - free.from;
      }
    }
    emit(period);
  }

  const pendingMs = spanMs(pending.map(p => ({ from: p.fromMs, to: p.toMs })));
  return {
    blocked: null,
    entries,
    carryOutMs: carry,
    newMs,
    unloggedMs: carry + pendingMs,

    newCoverage,
  };
}

function blocked(carryInMs: number): Plan {
  return {
    blocked: "no_baseline",
    entries: [],
    carryOutMs: carryInMs,
    newMs: 0,
    unloggedMs: 0,

    newCoverage: [],
  };
}

function entryOf(
  period: TrackedPeriod,
  minutes: number,
  measuredMs: number,
  carryInMs: number,
  carryOutMs: number,
  parts: readonly Part[]
): PlannedEntry {
  let interval = 0;
  let counter = 0;
  let firstMs: number | null = null;
  let lastMs: number | null = null;
  const launcherMs: Record<string, number> = {};
  for (const part of parts) {
    const len = part.toMs - part.fromMs;
    launcherMs[part.launcherKind] = (launcherMs[part.launcherKind] ?? 0) + len;
    if (part.lane === "interval") {
      interval += len;
      firstMs = firstMs === null ? part.fromMs : Math.min(firstMs, part.fromMs);
      lastMs = lastMs === null ? part.toMs : Math.max(lastMs, part.toMs);
    } else {
      counter += len;
    }
  }
  return {
    period,
    minutes,
    measuredMs,
    carryInMs,
    carryOutMs,
    basis: interval >= counter ? "intervals" : "timer",
    basisMs: interval > 0 && counter > 0 ? { interval, counter } : null,
    coverage: parts.map(({ lane, key, fromMs, toMs }) => ({
      lane,
      key,
      fromMs,
      toMs,
    })),
    firstMs,
    lastMs,
    launcherMs,
  };
}
