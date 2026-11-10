// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Read-only telemetry queries over one `telemetry.db` connection (issue #6516).
 *
 * The SQL here moved verbatim out of `TelemetryStore`, so the same statements
 * run on the main connection (in-thread: the inline executor calls
 * `store.queries` directly; `TelemetryStore`'s delegates remain, and today
 * only tests call them) and on the query worker's read-only connection. Nothing here writes, opens a
 * database, or touches the schema: the worker constructs this class over a
 * `readonly` connection and must never run the `TelemetryStore` constructor
 * (schema, migrations, prune, chmod). The write half of a day's aggregation is
 * `TelemetryStore.replaceDayAggregates`, which runs on the main connection.
 *
 * Pattern: `TurnAnalyticsCounts` (`./turns/analyticsCounts.ts`).
 */

// ── Types ──────────────────────────────────────────────────
export interface TelemetrySummary {
  byFile: Array<{ filePath: string; count: number }>;
  byType: Array<{ fileType: string; count: number }>;
}

export interface TelemetryTimeseriesBucket {
  bucket: string;
  count: number;
}

export interface TelemetryFileInfo {
  filePath: string;
  fileType: string;
  count: number;
  lastSeen: number;
}

export interface DailyAggregate {
  filePath: string;
  fileType: string;
  date: string;
  totalCount: number;
  invocationCount: number;
  completionCount: number;
  errorCount: number;
  skipCount: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
  durationP99Ms: number | null;
  durationAvgMs: number | null;
  durationMaxMs: number | null;
  successCount: number;
  failureCount: number;
  blockCount: number;
}

export interface DurationStats {
  filePath: string;
  fileType: string;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  avgMs: number | null;
  maxMs: number | null;
  sampleCount: number;
}

export interface OutcomeRate {
  filePath: string;
  fileType: string;
  totalCount: number;
  successCount: number;
  failureCount: number;
  errorCount: number;
  skipCount: number;
  blockCount: number;
  failureRate: number;
}

export interface AnomalyRecord {
  filePath: string;
  fileType: string;
  date: string;
  count: number;
  baselineMean: number;
  baselineStddev: number;
  zScore: number;
}

export interface PeriodComparison {
  filePath: string;
  fileType: string;
  period1Count: number;
  period2Count: number;
  delta: number;
  deltaPercent: number | null;
}

export interface SessionAggregate {
  sessionId: string;
  totalEvents: number;
  uniqueFiles: number;
  archetype: string;
  startTime: number;
  endTime: number;
  hookCount: number;
  skillCount: number;
  agentCount: number;
  errorCount: number;
}

const MS_PER_DAY = 86_400_000;

// ── Helpers ───────────────────────────────────────────────

function classifySession(stats: {
  skill_count: number;
  agent_count: number;
  error_count: number;
  hook_count: number;
  total_events: number;
}): string {
  const { skill_count, agent_count, error_count, total_events } = stats;
  if (total_events === 0) return "empty";
  const errorRate = error_count / total_events;
  if (errorRate > 0.3) return "debugging";
  if (skill_count > 0 && agent_count > 0) return "issue-workflow";
  if (skill_count > 0) return "skill-driven";
  if (agent_count > 0) return "agent-driven";
  return "exploratory";
}

// ── TelemetryQueries ───────────────────────────────────────

export class TelemetryQueries {
  constructor(private readonly db: Database) {}

  // ── Query: Summary ─────────────────────────────────────

  getSummary(filters?: {
    fileType?: string;
    startTime?: number;
    endTime?: number;
  }): TelemetrySummary {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    if (filters?.fileType) {
      conditions.push("file_type = @file_type");
      params.file_type = filters.fileType;
    }
    if (filters?.startTime) {
      conditions.push("timestamp >= @start_time");
      params.start_time = filters.startTime;
    }
    if (filters?.endTime) {
      conditions.push("timestamp <= @end_time");
      params.end_time = filters.endTime;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const byFile = this.db
      .prepare(
        `SELECT file_path, COUNT(*) as count FROM events ${where} GROUP BY file_path ORDER BY count DESC`
      )
      .all(params) as Array<{ file_path: string; count: number }>;

    const byType = this.db
      .prepare(
        `SELECT file_type, COUNT(*) as count FROM events ${where} GROUP BY file_type ORDER BY count DESC`
      )
      .all(params) as Array<{ file_type: string; count: number }>;

    return {
      byFile: byFile.map(r => ({ filePath: r.file_path, count: r.count })),
      byType: byType.map(r => ({ fileType: r.file_type, count: r.count })),
    };
  }

  // ── Query: Timeseries ──────────────────────────────────

  getTimeseries(params: {
    filePath?: string;
    /**
     * Optional fileType filter (issue #1889). Backward-compatible: existing
     * callers omit it and get the prior all-types behavior. The analytics
     * re-point uses it to request the hook-only legacy slice when merging with
     * turn_events-sourced skill/agent/mcp buckets.
     */
    fileType?: string;
    interval: "hour" | "day" | "week";
    startTime?: number;
    endTime?: number;
  }): TelemetryTimeseriesBucket[] {
    const conditions: string[] = [];
    const queryParams: Record<string, string | number> = {};

    if (params.filePath) {
      conditions.push("file_path = @file_path");
      queryParams.file_path = params.filePath;
    }
    if (params.fileType) {
      conditions.push("file_type = @file_type");
      queryParams.file_type = params.fileType;
    }
    if (params.startTime) {
      conditions.push("timestamp >= @start_time");
      queryParams.start_time = params.startTime;
    }
    if (params.endTime) {
      conditions.push("timestamp <= @end_time");
      queryParams.end_time = params.endTime;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let bucketExpr: string;
    switch (params.interval) {
      case "hour":
        bucketExpr =
          "strftime('%Y-%m-%dT%H:00:00Z', timestamp / 1000, 'unixepoch')";
        break;
      case "day":
        bucketExpr = "strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch')";
        break;
      case "week":
        bucketExpr = "strftime('%Y-W%W', timestamp / 1000, 'unixepoch')";
        break;
    }

    const rows = this.db
      .prepare(
        `SELECT ${bucketExpr} as bucket, COUNT(*) as count
         FROM events ${where}
         GROUP BY bucket ORDER BY bucket`
      )
      .all(queryParams) as Array<{ bucket: string; count: number }>;

    return rows;
  }

  // ── Query: Files ───────────────────────────────────────

  getFiles(fileType?: string): TelemetryFileInfo[] {
    const where = fileType ? "WHERE file_type = @file_type" : "";
    const params: Record<string, string> = fileType
      ? { file_type: fileType }
      : {};

    const rows = this.db
      .prepare(
        `SELECT file_path, file_type, COUNT(*) as count, MAX(timestamp) as last_seen
         FROM events ${where}
         GROUP BY file_path, file_type
         ORDER BY count DESC`
      )
      .all(params) as Array<{
      file_path: string;
      file_type: string;
      count: number;
      last_seen: number;
    }>;

    return rows.map(r => ({
      filePath: r.file_path,
      fileType: r.file_type,
      count: r.count,
      lastSeen: r.last_seen,
    }));
  }

  // ── Aggregation: compute (read-only) ───────────────────

  /**
   * Compute the `daily_aggregates` rows for one UTC day (YYYY-MM-DD), without
   * writing anything. One row per distinct (file_path, file_type) seen that
   * day; each row's counts are keyed by `file_path` exactly as the pre-#6516
   * `aggregateDay` keyed them, so the rows are identical. The write half is
   * `TelemetryStore.replaceDayAggregates`.
   */
  computeDayAggregates(date: string): DailyAggregate[] {
    const dayStartMs = new Date(`${date}T00:00:00Z`).getTime();
    const dayEndMs = dayStartMs + MS_PER_DAY;

    // Get distinct file paths that have events on this date
    const files = this.db
      .prepare(
        `SELECT DISTINCT file_path, file_type FROM events
         WHERE timestamp >= @start AND timestamp < @end`
      )
      .all({ start: dayStartMs, end: dayEndMs }) as Array<{
      file_path: string;
      file_type: string;
    }>;

    const rows: DailyAggregate[] = [];
    for (const { file_path, file_type } of files) {
      // Count by event_type
      const counts = this.db
        .prepare(
          `SELECT event_type, COUNT(*) as c FROM events
           WHERE file_path = @fp AND timestamp >= @start AND timestamp < @end
           GROUP BY event_type`
        )
        .all({ fp: file_path, start: dayStartMs, end: dayEndMs }) as Array<{
        event_type: string;
        c: number;
      }>;

      const countMap: Record<string, number> = {};
      let total = 0;
      for (const { event_type, c } of counts) {
        countMap[event_type] = c;
        total += c;
      }

      // Count by outcome
      const outcomes = this.db
        .prepare(
          `SELECT outcome, COUNT(*) as c FROM events
           WHERE file_path = @fp AND timestamp >= @start AND timestamp < @end
             AND outcome IS NOT NULL
           GROUP BY outcome`
        )
        .all({ fp: file_path, start: dayStartMs, end: dayEndMs }) as Array<{
        outcome: string;
        c: number;
      }>;

      const outcomeMap: Record<string, number> = {};
      for (const { outcome, c } of outcomes) {
        outcomeMap[outcome] = c;
      }

      // Duration stats (only events with duration_ms set)
      const durStats = this.db
        .prepare(
          `SELECT COUNT(*) as n, AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms
           FROM events
           WHERE file_path = @fp AND timestamp >= @start AND timestamp < @end
             AND duration_ms IS NOT NULL`
        )
        .get({ fp: file_path, start: dayStartMs, end: dayEndMs }) as {
        n: number;
        avg_ms: number | null;
        max_ms: number | null;
      } | null;

      let p50: number | null = null;
      let p95: number | null = null;
      let p99: number | null = null;

      if (durStats && durStats.n > 0) {
        const pctQuery = this.db.prepare(
          `SELECT duration_ms FROM events
           WHERE file_path = @fp AND timestamp >= @start AND timestamp < @end
             AND duration_ms IS NOT NULL
           ORDER BY duration_ms
           LIMIT 1 OFFSET @offset`
        );
        p50 =
          (
            pctQuery.get({
              fp: file_path,
              start: dayStartMs,
              end: dayEndMs,
              offset: Math.floor(durStats.n * 0.5),
            }) as { duration_ms: number } | null
          )?.duration_ms ?? null;
        p95 =
          (
            pctQuery.get({
              fp: file_path,
              start: dayStartMs,
              end: dayEndMs,
              offset: Math.floor(durStats.n * 0.95),
            }) as { duration_ms: number } | null
          )?.duration_ms ?? null;
        p99 =
          (
            pctQuery.get({
              fp: file_path,
              start: dayStartMs,
              end: dayEndMs,
              offset: Math.floor(durStats.n * 0.99),
            }) as { duration_ms: number } | null
          )?.duration_ms ?? null;
      }

      rows.push({
        filePath: file_path,
        fileType: file_type,
        date,
        totalCount: total,
        invocationCount: countMap["invocation"] ?? 0,
        completionCount: countMap["completion"] ?? 0,
        errorCount: countMap["error"] ?? 0,
        skipCount: countMap["skip"] ?? 0,
        durationP50Ms: p50,
        durationP95Ms: p95,
        durationP99Ms: p99,
        durationAvgMs: durStats?.avg_ms ?? null,
        durationMaxMs: durStats?.max_ms ?? null,
        successCount: outcomeMap["success"] ?? 0,
        failureCount: outcomeMap["failure"] ?? 0,
        blockCount: outcomeMap["blocked"] ?? 0,
      });
    }
    return rows;
  }

  /**
   * Days that have events but no `daily_aggregates` rows at all (the discovery
   * query of `aggregateMissing`, verbatim). A day that already holds rows is
   * never returned, which is why skipped today-refreshes need the separate
   * `daily_aggregate_debt` table (issue #6516 R12).
   */
  missingAggregateDays(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') as d
         FROM events
         WHERE strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch')
           NOT IN (SELECT DISTINCT date FROM daily_aggregates)
         ORDER BY d`
      )
      .all() as Array<{ d: string }>;
    return rows.map(r => r.d);
  }

  // ── Query: Duration Stats ─────────────────────────────

  getDurationStats(filters?: {
    fileType?: string;
    startDate?: string;
    endDate?: string;
  }): DurationStats[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (filters?.fileType) {
      conditions.push("file_type = @file_type");
      params.file_type = filters.fileType;
    }
    if (filters?.startDate) {
      conditions.push("date >= @start_date");
      params.start_date = filters.startDate;
    }
    if (filters?.endDate) {
      conditions.push("date <= @end_date");
      params.end_date = filters.endDate;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT file_path, file_type,
           SUM(completion_count) as sample_count,
           AVG(duration_avg_ms) as avg_ms,
           MAX(duration_max_ms) as max_ms,
           AVG(duration_p50_ms) as p50_ms,
           AVG(duration_p95_ms) as p95_ms,
           AVG(duration_p99_ms) as p99_ms
         FROM daily_aggregates ${where}
         GROUP BY file_path, file_type
         HAVING sample_count > 0
         ORDER BY avg_ms DESC`
      )
      .all(params) as Array<{
      file_path: string;
      file_type: string;
      sample_count: number;
      avg_ms: number | null;
      max_ms: number | null;
      p50_ms: number | null;
      p95_ms: number | null;
      p99_ms: number | null;
    }>;

    return rows.map(r => ({
      filePath: r.file_path,
      fileType: r.file_type,
      p50Ms: r.p50_ms,
      p95Ms: r.p95_ms,
      p99Ms: r.p99_ms,
      avgMs: r.avg_ms,
      maxMs: r.max_ms,
      sampleCount: r.sample_count,
    }));
  }

  // ── Query: Outcome Rates ──────────────────────────────

  getOutcomeRates(filters?: {
    fileType?: string;
    startDate?: string;
    endDate?: string;
  }): OutcomeRate[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (filters?.fileType) {
      conditions.push("file_type = @file_type");
      params.file_type = filters.fileType;
    }
    if (filters?.startDate) {
      conditions.push("date >= @start_date");
      params.start_date = filters.startDate;
    }
    if (filters?.endDate) {
      conditions.push("date <= @end_date");
      params.end_date = filters.endDate;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT file_path, file_type,
           SUM(total_count) as total_count,
           SUM(success_count) as success_count,
           SUM(failure_count) as failure_count,
           SUM(error_count) as error_count,
           SUM(skip_count) as skip_count,
           SUM(block_count) as block_count
         FROM daily_aggregates ${where}
         GROUP BY file_path, file_type
         ORDER BY total_count DESC`
      )
      .all(params) as Array<{
      file_path: string;
      file_type: string;
      total_count: number;
      success_count: number;
      failure_count: number;
      error_count: number;
      skip_count: number;
      block_count: number;
    }>;

    return rows.map(r => ({
      filePath: r.file_path,
      fileType: r.file_type,
      totalCount: r.total_count,
      successCount: r.success_count,
      failureCount: r.failure_count,
      errorCount: r.error_count,
      skipCount: r.skip_count,
      blockCount: r.block_count,
      failureRate:
        r.total_count > 0
          ? (r.failure_count + r.error_count) / r.total_count
          : 0,
    }));
  }

  // ── Query: Anomaly Detection ──────────────────────────

  getAnomalies(options?: {
    windowDays?: number;
    threshold?: number;
  }): AnomalyRecord[] {
    const windowDays = options?.windowDays ?? 7;
    const threshold = options?.threshold ?? 3;

    // Get the most recent aggregated date
    const latestRow = this.db
      .prepare("SELECT MAX(date) as d FROM daily_aggregates")
      .get() as { d: string | null } | null;
    if (!latestRow?.d) return [];

    const latestDate = latestRow.d;

    // For each file, compute rolling mean+stddev over the window, compare latest day
    const rows = this.db
      .prepare(
        `WITH recent AS (
           SELECT file_path, file_type, date, total_count
           FROM daily_aggregates
           WHERE date >= date(@latest, '-' || @window || ' days')
             AND date <= @latest
         ),
         baseline AS (
           SELECT file_path, file_type,
             AVG(total_count) as mean_count,
             CASE WHEN COUNT(*) > 1
               THEN SQRT(
                 SUM((total_count - (SELECT AVG(r2.total_count) FROM recent r2 WHERE r2.file_path = recent.file_path)) *
                     (total_count - (SELECT AVG(r2.total_count) FROM recent r2 WHERE r2.file_path = recent.file_path)))
                 / (COUNT(*) - 1)
               )
               ELSE 0
             END as stddev_count
           FROM recent
           WHERE date < @latest
           GROUP BY file_path, file_type
         )
         SELECT r.file_path, r.file_type, r.date, r.total_count as count,
           b.mean_count, b.stddev_count,
           CASE WHEN b.stddev_count > 0
             THEN (r.total_count - b.mean_count) / b.stddev_count
             ELSE 0
           END as z_score
         FROM recent r
         JOIN baseline b ON r.file_path = b.file_path
         WHERE r.date = @latest
           AND b.stddev_count > 0
           AND (r.total_count - b.mean_count) / b.stddev_count > @threshold
         ORDER BY z_score DESC`
      )
      .all({
        latest: latestDate,
        window: windowDays,
        threshold,
      }) as Array<{
      file_path: string;
      file_type: string;
      date: string;
      count: number;
      mean_count: number;
      stddev_count: number;
      z_score: number;
    }>;

    return rows.map(r => ({
      filePath: r.file_path,
      fileType: r.file_type,
      date: r.date,
      count: r.count,
      baselineMean: r.mean_count,
      baselineStddev: r.stddev_count,
      zScore: r.z_score,
    }));
  }

  // ── Query: Period Comparison ───────────────────────────

  getComparison(
    period1Start: number,
    period1End: number,
    period2Start: number,
    period2End: number
  ): PeriodComparison[] {
    const rows = this.db
      .prepare(
        `WITH p1 AS (
           SELECT file_path, file_type, COUNT(*) as cnt
           FROM events
           WHERE timestamp >= @p1s AND timestamp < @p1e
           GROUP BY file_path, file_type
         ),
         p2 AS (
           SELECT file_path, file_type, COUNT(*) as cnt
           FROM events
           WHERE timestamp >= @p2s AND timestamp < @p2e
           GROUP BY file_path, file_type
         )
         SELECT
           COALESCE(p1.file_path, p2.file_path) as file_path,
           COALESCE(p1.file_type, p2.file_type) as file_type,
           COALESCE(p1.cnt, 0) as period1_count,
           COALESCE(p2.cnt, 0) as period2_count
         FROM p1
         FULL OUTER JOIN p2
           ON p1.file_path = p2.file_path AND p1.file_type = p2.file_type
         ORDER BY COALESCE(p2.cnt, 0) DESC`
      )
      .all({
        p1s: period1Start,
        p1e: period1End,
        p2s: period2Start,
        p2e: period2End,
      }) as Array<{
      file_path: string;
      file_type: string;
      period1_count: number;
      period2_count: number;
    }>;

    return rows.map(r => {
      const delta = r.period2_count - r.period1_count;
      return {
        filePath: r.file_path,
        fileType: r.file_type,
        period1Count: r.period1_count,
        period2Count: r.period2_count,
        delta,
        deltaPercent:
          r.period1_count > 0 ? (delta / r.period1_count) * 100 : null,
      };
    });
  }

  // Token estimates moved to TurnAnalyticsCounts.getSkillTokenEstimates (#2154).
  // The version that lived here derived `estimatedTokensPerLoad` from a
  // per-fileType constant — every skill reported 2,250 tokens — so it ranked
  // skills purely by invocation frequency and never by cost. Measurement now
  // comes from the injected SKILL.md size recorded per turn event.

  // ── Query: Session Aggregates ─────────────────────────

  getSessionAggregates(filters?: {
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): SessionAggregate[] {
    const conditions: string[] = ["session_id IS NOT NULL"];
    const params: Record<string, number> = {};

    if (filters?.startTime) {
      conditions.push("timestamp >= @start_time");
      params.start_time = filters.startTime;
    }
    if (filters?.endTime) {
      conditions.push("timestamp <= @end_time");
      params.end_time = filters.endTime;
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const limit = filters?.limit ?? 50;

    const rows = this.db
      .prepare(
        `SELECT session_id,
           COUNT(*) as total_events,
           COUNT(DISTINCT file_path) as unique_files,
           MIN(timestamp) as start_time,
           MAX(timestamp) as end_time,
           SUM(CASE WHEN file_type = 'hook' THEN 1 ELSE 0 END) as hook_count,
           SUM(CASE WHEN file_type = 'skill' THEN 1 ELSE 0 END) as skill_count,
           SUM(CASE WHEN file_type = 'agent' THEN 1 ELSE 0 END) as agent_count,
           SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) as error_count
         FROM events ${where}
         GROUP BY session_id
         ORDER BY start_time DESC
         LIMIT @limit`
      )
      .all({ ...params, limit }) as Array<{
      session_id: string;
      total_events: number;
      unique_files: number;
      start_time: number;
      end_time: number;
      hook_count: number;
      skill_count: number;
      agent_count: number;
      error_count: number;
    }>;

    return rows.map(r => ({
      sessionId: r.session_id,
      totalEvents: r.total_events,
      uniqueFiles: r.unique_files,
      archetype: classifySession(r),
      startTime: r.start_time,
      endTime: r.end_time,
      hookCount: r.hook_count,
      skillCount: r.skill_count,
      agentCount: r.agent_count,
      errorCount: r.error_count,
    }));
  }
}
