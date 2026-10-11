// SPDX-License-Identifier: AGPL-3.0-only
/**
 * G-owned local-day time derivation over `turns` (issue #1669, epic #1662, Sub G).
 *
 * KD1 → (b): G does NOT create or modify A's `v_timelog_daily` view (its UTC→local
 * TZ refinement is Sub H / #1670's job — A's schema comment says so). Instead G
 * computes its OWN local-day-correct daily-time aggregation in TypeScript so the
 * shadow-mode parity diff against legacy `timelog_entries` is apples-to-apples.
 *
 * The local-day bucket key for each finalized turn is computed with
 * `Intl.DateTimeFormat("en-CA", { timeZone })` — the SAME mechanism as
 * `getTodayInTimezone`/`addDaysInTimezone` (`store/timeLog.ts:24,48`) and the
 * per-namespace `midnight_reset_state` semantics the legacy flush uses. This
 * AVOIDS the UTC `date(...,'unixepoch')` bucketing in
 * `estimateNamespaceTimeFromMessages` (`timeLog.ts:718`), which would mis-bucket
 * every evening session east of UTC (R3 / KD5).
 *
 * Shadow mode (R7): read-only. This module only SELECTs from `turns`,
 * `timelog_entries`, and `midnight_reset_state`.
 */

import type { Database } from "bun:sqlite";

/** `${namespace}|${localDate}` — the bucket key both sides share. */
export type BucketKey = string;

export interface DailyTimeBucket {
  namespace: string;
  localDate: string; // YYYY-MM-DD in the namespace-local timezone
  durationMs: number;
  turnCount: number;
}

export function bucketKey(namespace: string, localDate: string): BucketKey {
  return `${namespace}|${localDate}`;
}

/**
 * Format an epoch-ms timestamp as a YYYY-MM-DD local date in an IANA timezone.
 * Mirrors `getTodayInTimezone` (`store/timeLog.ts:48`) but for an arbitrary
 * timestamp. `en-CA` yields the ISO `YYYY-MM-DD` shape.
 */
export function localDateForTimestamp(tsMs: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(tsMs));
}

/**
 * Resolve a namespace's IANA timezone from `midnight_reset_state`, falling back
 * to the server default when the namespace has no recorded reset state. This
 * matches how the legacy flush resolves per-namespace day boundaries (#1119).
 *
 * #4613: when `federationOverride` is a non-empty string, it WINS over both the
 * stored `midnight_reset_state` row AND `defaultTimezone`. This is load-bearing:
 * a node whose stored row holds another zone (the ms1 `UTC` case) would otherwise
 * keep bucketing in that stale zone even with a federation value set, because the
 * stored row is preferred over `defaultTimezone`. Callers pass the override ONLY
 * when a federation-global `timeLogTimezone` is in effect (`TimeLogConfig.isFederation`);
 * when it is null/absent the pre-#4613 stored-row → default precedence is byte-identical.
 */
export function resolveNamespaceTimezone(
  db: Database,
  namespace: string,
  defaultTimezone: string,
  federationOverride?: string | null
): string {
  if (federationOverride) return federationOverride;
  if (!namespace) return defaultTimezone;
  const row = db
    .prepare("SELECT timezone FROM midnight_reset_state WHERE namespace = ?")
    .get(namespace) as { timezone: string } | undefined;
  return row?.timezone || defaultTimezone;
}

export interface DeriveTimeOptions {
  defaultTimezone: string;
  /**
   * #4613: the federation-global time-log timezone, when one is in effect. When
   * set, it WINS over every namespace's stored `midnight_reset_state` row (passed
   * to `resolveNamespaceTimezone` as `federationOverride`). Omitted/null →
   * pre-#4613 stored-row → default behavior.
   */
  federationTimezone?: string | null;
  /** Restrict to these namespaces (omitted → all). */
  namespaces?: string[];
  /** Inclusive `started_at_ms` lower bound (epoch ms). */
  startMs?: number;
  /** Inclusive `started_at_ms` upper bound (epoch ms). */
  endMs?: number;
}

interface TurnTimeRow {
  namespace: string | null;
  started_at_ms: number;
  duration_ms: number;
}

/**
 * Derive new-pipeline daily time from finalized turns, bucketed by per-namespace
 * LOCAL calendar day. `status IN ('completed','orphaned')` turns with a non-NULL
 * `duration_ms` participate (issue #2248): a swept orphan now carries a lower-bound
 * `duration_ms` (its transcript last-message watermark, else the `started_at_ms`
 * floor), so including it stops the ~10% under-count that dropping orphan time
 * caused. Still excluded: `interrupted`/`errored` turns (status clause) and any
 * residual NULL-duration row (the null clause). NULL namespaces coalesce to `""`
 * so they still diff against the legacy `""` bucket. Participation is kept
 * CONSISTENT with the user-facing read path `deriveDailyTimeLog` (same filter);
 * the `v_session_totals` view (no status filter) counts these durations once
 * populated. Safe re: parity — time-parity is retired as a gate (#1892).
 */
export function deriveNewPipelineDailyTime(
  db: Database,
  opts: DeriveTimeOptions
): Map<BucketKey, DailyTimeBucket> {
  const clauses = [
    "status IN ('completed', 'orphaned')",
    "duration_ms IS NOT NULL",
  ];
  const params: (string | number)[] = [];
  if (opts.namespaces && opts.namespaces.length > 0) {
    const placeholders = opts.namespaces.map(() => "?").join(", ");
    clauses.push(`COALESCE(namespace, '') IN (${placeholders})`);
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

  const rows = db
    .prepare(
      `SELECT namespace, started_at_ms, duration_ms
       FROM turns
       WHERE ${clauses.join(" AND ")}`
    )
    .all(...params) as TurnTimeRow[];

  // Cache TZ lookups per namespace to avoid a query per turn.
  const tzCache = new Map<string, string>();
  const buckets = new Map<BucketKey, DailyTimeBucket>();

  for (const row of rows) {
    const namespace = row.namespace ?? "";
    let tz = tzCache.get(namespace);
    if (tz === undefined) {
      tz = resolveNamespaceTimezone(
        db,
        namespace,
        opts.defaultTimezone,
        opts.federationTimezone
      );
      tzCache.set(namespace, tz);
    }
    const localDate = localDateForTimestamp(row.started_at_ms, tz);
    const key = bucketKey(namespace, localDate);
    const existing = buckets.get(key);
    if (existing) {
      existing.durationMs += row.duration_ms;
      existing.turnCount += 1;
    } else {
      buckets.set(key, {
        namespace,
        localDate,
        durationMs: row.duration_ms,
        turnCount: 1,
      });
    }
  }

  return buckets;
}

export interface LegacyTimeOptions {
  namespaces?: string[];
  /** Inclusive YYYY-MM-DD lower bound on `timelog_entries.date`. */
  startDate?: string;
  /** Inclusive YYYY-MM-DD upper bound on `timelog_entries.date`. */
  endDate?: string;
}

interface LegacyTimeRow {
  namespace: string | null;
  date: string;
  total_ms: number;
}

/**
 * Read legacy daily time from `timelog_entries`, grouped by `(namespace, date)`.
 * `timelog_entries.date` is already a per-namespace LOCAL date string (#1119), so
 * it lines up directly with the new-side local-day buckets. READ-ONLY (R7).
 */
export function readLegacyDailyTime(
  db: Database,
  opts: LegacyTimeOptions = {}
): Map<BucketKey, DailyTimeBucket> {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.namespaces && opts.namespaces.length > 0) {
    const placeholders = opts.namespaces.map(() => "?").join(", ");
    clauses.push(`COALESCE(namespace, '') IN (${placeholders})`);
    params.push(...opts.namespaces);
  }
  if (opts.startDate) {
    clauses.push("date >= ?");
    params.push(opts.startDate);
  }
  if (opts.endDate) {
    clauses.push("date <= ?");
    params.push(opts.endDate);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT COALESCE(namespace, '') AS namespace, date,
              COALESCE(SUM(duration_ms), 0) AS total_ms
       FROM timelog_entries
       ${where}
       GROUP BY COALESCE(namespace, ''), date`
    )
    .all(...params) as LegacyTimeRow[];

  const buckets = new Map<BucketKey, DailyTimeBucket>();
  for (const row of rows) {
    const namespace = row.namespace ?? "";
    buckets.set(bucketKey(namespace, row.date), {
      namespace,
      localDate: row.date,
      durationMs: row.total_ms,
      turnCount: 0,
    });
  }
  return buckets;
}

/**
 * UTC offset (local − UTC, in ms) for an instant `ms` in IANA `timezone`.
 * DST-correct: measured at the actual instant via `formatToParts`.
 */
function tzOffsetMs(ms: number, timezone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  // `hour` can come back as 24 at midnight under hour12:false — normalize.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    parts.minute,
    parts.second
  );
  return asUtc - ms;
}

/**
 * Epoch-ms bounds [startMs, endMs] of a local calendar day `dateStr`
 * (YYYY-MM-DD) in IANA `timezone`. `endMs` is the last ms of the day
 * (next local midnight − 1). DST-correct (offset measured at local noon to
 * avoid the spring-forward gap). Used to scope the nightly harness to one day.
 */
export function localDayBoundsMs(
  dateStr: string,
  timezone: string
): { startMs: number; endMs: number } {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`localDayBoundsMs: invalid YYYY-MM-DD: ${dateStr}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Offset measured at local noon (stable across the spring-forward gap), then
  // local midnight epoch = (UTC midnight of the calendar date) − offset.
  const noonUtc = Date.UTC(year, month - 1, day, 12, 0, 0);
  const offset = tzOffsetMs(noonUtc, timezone);
  const startMs = Date.UTC(year, month - 1, day, 0, 0, 0) - offset;
  const endMs = startMs + 86_400_000 - 1;
  return { startMs, endMs };
}
