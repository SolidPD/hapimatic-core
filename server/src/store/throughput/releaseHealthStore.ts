// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { tableExists } from "../turns/schema";

/**
 * Release-health data (issue #6173, D3 — R1, R2): the node's version segments
 * and a per-minute read of its `error`/`fatal` log rows.
 *
 * A version segment is one run of an app version on this node: opened when
 * throughput boots, touched every 5 minutes, closed with `clean_stop = 1` on a
 * graceful stop. Node-local (never replicated) and outside the rollup tables.
 * Built from `store.getRawDb()` so `store/index.ts` stays untouched. Both tables
 * are read fail-open: a DB where a DDL block failed returns empty reads, and the
 * segment writes are no-ops there.
 */

export interface VersionSegment {
  version: string;
  startedMs: number;
  lastSeenMs: number;
  cleanStop: boolean;
}

/**
 * One (minute, source, category, replayed) group of `error`/`fatal` rows. The
 * release-health policy decides which groups count; the store only groups.
 */
export interface ErrorMinuteGroup {
  /** The minute's start (epoch ms). */
  minuteMs: number;
  /** The earliest row in the group (epoch ms), used to attribute it to a segment. */
  firstMs: number;
  source: string;
  category: string;
  /** Rows carrying a client `original_timestamp` (replayed at replay time). */
  replayed: boolean;
  /** Rate-limit summary rows (`rateLimitSummary: true` in the context JSON). */
  floods: number;
  rows: number;
}

const MINUTE_MS = 60_000;

export class ReleaseHealthStore {
  private segmentsTable: boolean | undefined;
  private errorLogsTable: boolean | undefined;

  constructor(private readonly db: Database) {}

  private hasSegments(): boolean {
    this.segmentsTable ??= tableExists(this.db, "throughput_version_segments");
    return this.segmentsTable;
  }

  private hasErrorLogs(): boolean {
    this.errorLogsTable ??= tableExists(this.db, "error_logs");
    return this.errorLogsTable;
  }

  /**
   * Open a segment for this run; null when the table is missing. Returns the
   * row it actually inserted: a run that starts in the same millisecond as an
   * earlier run of the same version (a quick restart) moves forward 1 ms rather
   * than silently reusing the earlier row.
   */
  openSegment(version: string, nowMs: number): VersionSegment | null {
    if (!this.hasSegments()) return null;
    const insert = this.db.prepare(
      `INSERT INTO throughput_version_segments (version, started_ms, last_seen_ms, clean_stop)
       VALUES (@version, @at, @at, 0)
       ON CONFLICT (version, started_ms) DO NOTHING`
    );
    for (let at = nowMs; at < nowMs + 1000; at++) {
      if (insert.run({ version, at }).changes > 0) {
        return { version, startedMs: at, lastSeenMs: at, cleanStop: false };
      }
    }
    return null;
  }

  /** Move an open segment's last-seen time forward; false when nothing matched. */
  touchSegment(version: string, startedMs: number, nowMs: number): boolean {
    if (!this.hasSegments()) return false;
    const r = this.db
      .prepare(
        `UPDATE throughput_version_segments
            SET last_seen_ms = MAX(last_seen_ms, @now)
          WHERE version = @version AND started_ms = @started AND clean_stop = 0`
      )
      .run({ version, started: startedMs, now: nowMs });
    return r.changes > 0;
  }

  /** Close a segment on a graceful stop (`clean_stop = 1`). */
  closeSegment(version: string, startedMs: number, nowMs: number): boolean {
    if (!this.hasSegments()) return false;
    const r = this.db
      .prepare(
        `UPDATE throughput_version_segments
            SET last_seen_ms = MAX(last_seen_ms, @now), clean_stop = 1
          WHERE version = @version AND started_ms = @started`
      )
      .run({ version, started: startedMs, now: nowMs });
    return r.changes > 0;
  }

  /**
   * Segments still running at or after `sinceMs`, oldest first, plus the latest
   * segment that started before it: a run that crashed just before the window
   * owns a short tail past its last touch, which may fall inside the window.
   */
  listSegments(sinceMs: number): VersionSegment[] {
    if (!this.hasSegments()) return [];
    const rows = this.db
      .prepare(
        `SELECT version, started_ms, last_seen_ms, clean_stop
           FROM throughput_version_segments
          WHERE last_seen_ms >= ?1
             OR started_ms = (SELECT MAX(started_ms)
                                FROM throughput_version_segments
                               WHERE started_ms < ?1)
          ORDER BY started_ms, version`
      )
      .all(sinceMs) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      version: String(r.version),
      startedMs: Number(r.started_ms),
      lastSeenMs: Number(r.last_seen_ms),
      cleanStop: Number(r.clean_stop) === 1,
    }));
  }

  /** Delete segments last seen before `ms`; returns the count removed. */
  pruneBefore(ms: number): number {
    if (!this.hasSegments()) return 0;
    return this.db
      .prepare("DELETE FROM throughput_version_segments WHERE last_seen_ms < ?")
      .run(ms).changes;
  }

  /**
   * `error` and `fatal` rows in `[fromMs, toMs]`, grouped per minute, source,
   * category and replay flag. Grouping in SQL keeps the read bounded during a
   * flood (the per-category limiter still writes up to 11 rows a minute per
   * category), and the `(severity, timestamp)` index serves the filter.
   */
  errorMinutes(fromMs: number, toMs: number): ErrorMinuteGroup[] {
    if (!this.hasErrorLogs()) return [];
    const rows = this.db
      .prepare(
        `SELECT (timestamp / ${MINUTE_MS}) * ${MINUTE_MS} AS minute_ms,
                MIN(timestamp) AS first_ms,
                source,
                category,
                (original_timestamp IS NOT NULL) AS replayed,
                SUM(CASE WHEN instr(COALESCE(context, ''), '"rateLimitSummary":true') > 0
                         THEN 1 ELSE 0 END) AS floods,
                COUNT(*) AS n
           FROM error_logs
          WHERE severity IN ('error', 'fatal')
            AND timestamp >= ? AND timestamp <= ?
          GROUP BY minute_ms, source, category, replayed
          ORDER BY minute_ms, source, category, replayed`
      )
      .all(fromMs, toMs) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      minuteMs: Number(r.minute_ms),
      firstMs: Number(r.first_ms),
      source: String(r.source),
      category: String(r.category),
      replayed: Number(r.replayed) === 1,
      floods: Number(r.floods),
      rows: Number(r.n),
    }));
  }
}
