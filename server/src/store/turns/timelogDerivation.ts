// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import {
  bucketKey,
  localDateForTimestamp,
  resolveNamespaceTimezone,
  type BucketKey,
} from "../../parity/timeParityDerivation";
import type { TimelogAdjustmentType } from "./types";

/**
 * Derived daily time-log read path (issue #1670, Sub H1, epic #1662).
 *
 * Computes per-namespace daily time totals from `turns` + the `timelog_adjustments`
 * manual ledger, bucketed by per-namespace IANA-TZ LOCAL calendar day. This is the
 * TS-side derivation H1 needs because SQLite's `date()` is UTC-only — the
 * `v_timelog_daily` view (Sub A) keeps its locked column contract for other
 * consumers, but its UTC-bucket aggregation cannot satisfy R6 (settings-TZ day
 * boundaries), so the derived read path supersedes it.
 *
 * It deliberately reuses Sub-G's auto-side primitives (`deriveNewPipelineDailyTime`'s
 * timezone resolution + local-day bucketing) verbatim so the displayed total cannot
 * drift from the parity comparator's definition; it ADDS the six-control ledger
 * semantics (R4) on top of the same auto bucketing.
 *
 * PURITY: `defaultTimezone` is injected; there is no `Date.now()`. The function is a
 * read-only SELECT over `turns` + `timelog_adjustments`, so it is reproducible and
 * unit-testable.
 *
 * DORMANCY (#1670 PR-1): nothing in the live read path / HTTP routes calls this yet.
 * PR-2 wires the modal + #1039 route to it, gated on the Sub-G parity green-streak
 * (`cutoverGate.ts`). PR-1 ships the derivation + tests only.
 *
 * ── Control-type semantics (R4) ──
 *   - `delta`   : signed `delta_ms` added to the bucket of its `ts_ms` local day.
 *   - `set`     : absolute checkpoint to `to_ms` at `ts_ms`; the running total is
 *                 reset to `to_ms`, and only auto/delta contributions AFTER `ts_ms`
 *                 accrue on top (latest checkpoint in a bucket wins).
 *   - `reset`   : a `set` to 0.
 *   - `undo`    : EXCLUDES the adjustment referenced by `target_adjustment_id` from
 *                 the computation entirely (uniform across delta/set/reset/disable/
 *                 enable). The undo row contributes nothing itself; it never deletes.
 *   - `disable` : marks a `[from_ms, to_ms]` namespace range; auto-turn durations
 *                 whose `started_at_ms` falls inside a NET-disabled range are excluded
 *                 from `netMs` (but still counted in raw `autoMs`).
 *   - `enable`  : re-includes a `[from_ms, to_ms]` range (interval subtraction over
 *                 the disabled set; a later `enable` over an overlapping `disable`
 *                 re-includes that portion).
 *
 * KNOWN PR-1 LIMITATION: undo-of-undo ("redo") is not specially supported — a second
 * undo targeting an undo row simply adds that row to the excluded set (no effect,
 * since undo rows contribute nothing). Documented; out of PR-1 scope.
 */

export interface DerivedDailyBucket {
  namespace: string;
  /** YYYY-MM-DD in the namespace-local timezone. */
  localDate: string;
  /** Raw recorded auto-turn duration for the day (INCLUDING disabled ranges). */
  autoMs: number;
  /** Manual-ledger portion = netMs - autoMs (mirrors v_timelog_daily.adjustment_ms intent). */
  adjustmentMs: number;
  /** Displayed total for the day after all six-control semantics applied. */
  netMs: number;
}

/**
 * One per-session row of the turns-derived daily breakdown (issue #1892 Task 3B /
 * BD-2). `ms` is the summed `duration_ms` of that session's completed/orphaned turns
 * in the bucket; `projectDirectory` maps from the turn's `repo ?? cwd`.
 */
export interface SessionBreakdownItem {
  sessionId: string;
  sessionName: string;
  projectDirectory: string;
  ms: number;
}

export interface DeriveTimelogOptions {
  defaultTimezone: string;
  /**
   * #4613: the federation-global time-log timezone, when one is in effect. When
   * set, it WINS over every namespace's stored `midnight_reset_state` row (passed
   * through to `resolveNamespaceTimezone` as `federationOverride`). Omitted/null →
   * pre-#4613 stored-row → default behavior.
   */
  federationTimezone?: string | null;
  /** Restrict to these namespaces (COALESCE(namespace,'') match); omitted → all. */
  namespaces?: string[];
  /** Inclusive `started_at_ms` / `ts_ms` lower bound (epoch ms). */
  startMs?: number;
  /** Inclusive `started_at_ms` / `ts_ms` upper bound (epoch ms). */
  endMs?: number;
}

/** Half-open-agnostic inclusive interval [from, to] in epoch ms. */
interface Interval {
  from: number;
  to: number;
}

interface TurnRow {
  namespace: string | null;
  started_at_ms: number;
  duration_ms: number;
}

interface AdjRow {
  id: string;
  namespace: string | null;
  ts_ms: number;
  type: TimelogAdjustmentType;
  delta_ms: number | null;
  from_ms: number | null;
  to_ms: number | null;
  target_adjustment_id: string | null;
}

/** Per-bucket event for the timestamp-ordered walk. */
interface WalkEvent {
  tsMs: number;
  /** auto < delta < checkpoint, so an explicit checkpoint wins a tsMs collision. */
  order: 0 | 1 | 2;
  apply: (running: number) => number;
}

/**
 * Subtract interval [f, t] from a list of disabled intervals (interval difference).
 * Splits/trims overlapping intervals; used to implement `enable` re-inclusion.
 */
function subtractInterval(
  intervals: Interval[],
  f: number,
  t: number
): Interval[] {
  const out: Interval[] = [];
  for (const iv of intervals) {
    if (t < iv.from || f > iv.to) {
      // No overlap — keep as-is.
      out.push(iv);
      continue;
    }
    // Left remainder (portion of iv before f).
    if (iv.from < f) out.push({ from: iv.from, to: f - 1 });
    // Right remainder (portion of iv after t).
    if (iv.to > t) out.push({ from: t + 1, to: iv.to });
    // The overlapping middle is removed (re-enabled).
  }
  return out;
}

/** Is point p inside any interval? */
function pointInIntervals(intervals: Interval[], p: number): boolean {
  for (const iv of intervals) {
    if (p >= iv.from && p <= iv.to) return true;
  }
  return false;
}

/**
 * Build the NET disabled intervals per namespace from non-undone disable/enable
 * rows, processed in `ts_ms` ASC order (a later enable re-includes an earlier
 * disable's overlapping portion).
 */
function buildDisabledRanges(
  adjustments: AdjRow[],
  undoneIds: Set<string>
): Map<string, Interval[]> {
  const byNamespace = new Map<string, Interval[]>();
  for (const a of adjustments) {
    if (undoneIds.has(a.id)) continue;
    if (a.type !== "disable" && a.type !== "enable") continue;
    if (a.from_ms === null || a.to_ms === null) continue;
    const ns = a.namespace ?? "";
    const cur = byNamespace.get(ns) ?? [];
    if (a.type === "disable") {
      cur.push({ from: a.from_ms, to: a.to_ms });
      byNamespace.set(ns, cur);
    } else {
      byNamespace.set(ns, subtractInterval(cur, a.from_ms, a.to_ms));
    }
  }
  return byNamespace;
}

/**
 * Derive new-pipeline daily time from finalized turns + the manual ledger,
 * bucketed by per-namespace LOCAL calendar day. Read-only.
 */
export function deriveDailyTimeLog(
  db: Database,
  opts: DeriveTimelogOptions
): Map<BucketKey, DerivedDailyBucket> {
  // ── Load turns (auto side) — mirrors deriveNewPipelineDailyTime's filter. ──
  // #2248: swept orphans (status='orphaned' carrying a lower-bound duration_ms)
  // now participate, stopping the ~10% under-count from dropping orphan time.
  // interrupted/errored + any residual NULL-duration row stay excluded.
  const turnClauses = [
    "status IN ('completed', 'orphaned')",
    "duration_ms IS NOT NULL",
  ];
  const turnParams: (string | number)[] = [];
  if (opts.namespaces && opts.namespaces.length > 0) {
    const ph = opts.namespaces.map(() => "?").join(", ");
    turnClauses.push(`COALESCE(namespace, '') IN (${ph})`);
    turnParams.push(...opts.namespaces);
  }
  if (typeof opts.startMs === "number") {
    turnClauses.push("started_at_ms >= ?");
    turnParams.push(opts.startMs);
  }
  if (typeof opts.endMs === "number") {
    turnClauses.push("started_at_ms <= ?");
    turnParams.push(opts.endMs);
  }
  const turns = db
    .prepare(
      `SELECT namespace, started_at_ms, duration_ms
       FROM turns WHERE ${turnClauses.join(" AND ")}`
    )
    .all(...turnParams) as TurnRow[];

  // ── Load adjustments (manual ledger) ── ordered by ts so the walk + range
  // building are deterministic. Note: undo-target lookup needs ALL adjustments
  // for the in-scope namespaces (a target could pre-date the time window), so the
  // time window is applied to the WALK, not to the undo/target resolution here.
  const adjClauses: string[] = [];
  const adjParams: (string | number)[] = [];
  if (opts.namespaces && opts.namespaces.length > 0) {
    const ph = opts.namespaces.map(() => "?").join(", ");
    adjClauses.push(`COALESCE(namespace, '') IN (${ph})`);
    adjParams.push(...opts.namespaces);
  }
  const adjWhere =
    adjClauses.length > 0 ? `WHERE ${adjClauses.join(" AND ")}` : "";
  const adjustments = db
    .prepare(
      `SELECT id, namespace, ts_ms, type, delta_ms, from_ms, to_ms, target_adjustment_id
       FROM timelog_adjustments ${adjWhere} ORDER BY ts_ms ASC, id ASC`
    )
    .all(...adjParams) as AdjRow[];

  // ── undone set: every adjustment referenced by an undo row is excluded. ──
  const undoneIds = new Set<string>();
  for (const a of adjustments) {
    if (a.type === "undo" && a.target_adjustment_id) {
      undoneIds.add(a.target_adjustment_id);
    }
  }

  // ── net disabled ranges per namespace (from non-undone disable/enable). ──
  const disabledRanges = buildDisabledRanges(adjustments, undoneIds);

  // ── timezone cache + bucket accumulators. ──
  const tzCache = new Map<string, string>();
  const tzFor = (ns: string): string => {
    let tz = tzCache.get(ns);
    if (tz === undefined) {
      tz = resolveNamespaceTimezone(
        db,
        ns,
        opts.defaultTimezone,
        opts.federationTimezone
      );
      tzCache.set(ns, tz);
    }
    return tz;
  };

  const autoMsByBucket = new Map<BucketKey, number>();
  const eventsByBucket = new Map<BucketKey, WalkEvent[]>();
  const bucketMeta = new Map<
    BucketKey,
    { namespace: string; localDate: string }
  >();

  const ensureBucket = (ns: string, localDate: string): BucketKey => {
    const key = bucketKey(ns, localDate);
    if (!bucketMeta.has(key)) {
      bucketMeta.set(key, { namespace: ns, localDate });
    }
    return key;
  };

  // ── auto turns → raw autoMs + a walk event (skipped from running if disabled). ──
  for (const t of turns) {
    const ns = t.namespace ?? "";
    const localDate = localDateForTimestamp(t.started_at_ms, tzFor(ns));
    const key = ensureBucket(ns, localDate);
    autoMsByBucket.set(key, (autoMsByBucket.get(key) ?? 0) + t.duration_ms);
    const disabled = pointInIntervals(
      disabledRanges.get(ns) ?? [],
      t.started_at_ms
    );
    const ms = t.duration_ms;
    const events = eventsByBucket.get(key) ?? [];
    events.push({
      tsMs: t.started_at_ms,
      order: 0,
      apply: running => (disabled ? running : running + ms),
    });
    eventsByBucket.set(key, events);
  }

  // ── delta / set / reset adjustments → walk events (undone + undo rows skipped,
  //    disable/enable handled via the range set above). Time window applies here. ──
  for (const a of adjustments) {
    if (undoneIds.has(a.id)) continue;
    if (a.type === "undo" || a.type === "disable" || a.type === "enable")
      continue;
    if (typeof opts.startMs === "number" && a.ts_ms < opts.startMs) continue;
    if (typeof opts.endMs === "number" && a.ts_ms > opts.endMs) continue;
    const ns = a.namespace ?? "";
    const localDate = localDateForTimestamp(a.ts_ms, tzFor(ns));
    const key = ensureBucket(ns, localDate);
    const events = eventsByBucket.get(key) ?? [];
    if (a.type === "delta") {
      const ms = a.delta_ms ?? 0;
      events.push({ tsMs: a.ts_ms, order: 1, apply: running => running + ms });
    } else {
      // set or reset → absolute checkpoint (reset is `to_ms = 0`).
      const checkpoint = a.type === "reset" ? 0 : (a.to_ms ?? 0);
      events.push({ tsMs: a.ts_ms, order: 2, apply: () => checkpoint });
    }
    eventsByBucket.set(key, events);
  }

  // ── walk each bucket in (tsMs, order) order → netMs. ──
  const out = new Map<BucketKey, DerivedDailyBucket>();
  const allKeys = new Set<BucketKey>([
    ...autoMsByBucket.keys(),
    ...eventsByBucket.keys(),
  ]);
  for (const key of allKeys) {
    const meta = bucketMeta.get(key)!;
    const autoMs = autoMsByBucket.get(key) ?? 0;
    const events = (eventsByBucket.get(key) ?? []).slice();
    events.sort((x, y) =>
      x.tsMs === y.tsMs ? x.order - y.order : x.tsMs - y.tsMs
    );
    let running = 0;
    for (const ev of events) running = ev.apply(running);
    const netMs = running;
    out.set(key, {
      namespace: meta.namespace,
      localDate: meta.localDate,
      autoMs,
      adjustmentMs: netMs - autoMs,
      netMs,
    });
  }
  return out;
}

interface BreakdownTurnRow {
  namespace: string | null;
  started_at_ms: number;
  duration_ms: number;
  hapi_session_id: string;
  session_name: string | null;
  cwd: string | null;
  repo: string | null;
}

/**
 * Task 3B (#1892, BD-2): turns-derived per-session daily breakdown, bucketed by
 * per-namespace LOCAL calendar day. Groups completed/orphaned turns by
 * (bucket, hapi_session_id) and sums `duration_ms` — the auto per-session
 * attribution the `TimeLogModal` breakdown uses post-cutover (with a read-only
 * `timelog_entries` archive fallback for pre-turns days, applied on the client).
 *
 * `projectDirectory` maps from `repo ?? cwd`; `sessionName` / `projectDirectory`
 * take the values of the session's LATEST turn in the bucket. Same status /
 * namespace / time filters as {@link deriveDailyTimeLog}'s auto side. Read-only,
 * no `Date.now()`.
 *
 * Note: day-level manual adjustments (set / delta / disable / enable from the
 * ledger) are NOT distributed to individual sessions — the per-session breakdown
 * is the raw auto attribution (matches `autoMs`). On days carrying such an
 * adjustment the breakdown sum may differ from the adjusted `netMs` headline; that
 * bounded gap is the documented DD-B tradeoff.
 */
export function deriveDailyBreakdown(
  db: Database,
  opts: DeriveTimelogOptions
): Map<BucketKey, SessionBreakdownItem[]> {
  const clauses = [
    "status IN ('completed', 'orphaned')",
    "duration_ms IS NOT NULL",
  ];
  const params: (string | number)[] = [];
  if (opts.namespaces && opts.namespaces.length > 0) {
    const ph = opts.namespaces.map(() => "?").join(", ");
    clauses.push(`COALESCE(namespace, '') IN (${ph})`);
    params.push(...opts.namespaces);
  }
  if (typeof opts.startMs === "number") {
    clauses.push("started_at_ms >= ?");
    params.push(opts.startMs);
  }
  if (typeof opts.endMs === "number") {
    clauses.push("started_at_ms <= ?");
    params.push(opts.endMs);
  }
  const turns = db
    .prepare(
      `SELECT namespace, started_at_ms, duration_ms, hapi_session_id,
              session_name, cwd, repo
       FROM turns WHERE ${clauses.join(" AND ")}`
    )
    .all(...params) as BreakdownTurnRow[];

  const tzCache = new Map<string, string>();
  const tzFor = (ns: string): string => {
    let tz = tzCache.get(ns);
    if (tz === undefined) {
      tz = resolveNamespaceTimezone(
        db,
        ns,
        opts.defaultTimezone,
        opts.federationTimezone
      );
      tzCache.set(ns, tz);
    }
    return tz;
  };

  // bucket → sessionId → accumulator (ms + latest-turn metadata).
  const acc = new Map<
    BucketKey,
    Map<
      string,
      {
        ms: number;
        latestTsMs: number;
        sessionName: string;
        projectDirectory: string;
      }
    >
  >();

  for (const t of turns) {
    const ns = t.namespace ?? "";
    const localDate = localDateForTimestamp(t.started_at_ms, tzFor(ns));
    const key = bucketKey(ns, localDate);
    let byS = acc.get(key);
    if (!byS) {
      byS = new Map();
      acc.set(key, byS);
    }
    const sid = t.hapi_session_id;
    const projectDirectory = t.repo ?? t.cwd ?? "Unknown";
    const sessionName = t.session_name ?? `Session ${sid.slice(0, 8)}`;
    const cur = byS.get(sid);
    if (!cur) {
      byS.set(sid, {
        ms: t.duration_ms,
        latestTsMs: t.started_at_ms,
        sessionName,
        projectDirectory,
      });
    } else {
      cur.ms += t.duration_ms;
      // Latest turn wins for the display metadata (name/project can drift).
      if (t.started_at_ms >= cur.latestTsMs) {
        cur.latestTsMs = t.started_at_ms;
        cur.sessionName = sessionName;
        cur.projectDirectory = projectDirectory;
      }
    }
  }

  const out = new Map<BucketKey, SessionBreakdownItem[]>();
  for (const [key, byS] of acc) {
    const items: SessionBreakdownItem[] = Array.from(byS.entries()).map(
      ([sessionId, v]) => ({
        sessionId,
        sessionName: v.sessionName,
        projectDirectory: v.projectDirectory,
        ms: v.ms,
      })
    );
    items.sort((a, b) => b.ms - a.ms);
    out.set(key, items);
  }
  return out;
}
