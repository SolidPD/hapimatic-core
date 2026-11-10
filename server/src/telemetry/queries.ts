// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type {
  AnomalyRecord,
  DailyAggregate,
  DurationStats,
  OutcomeRate,
  PeriodComparison,
  SessionAggregate,
  TelemetryFileInfo,
  TelemetryQueries,
  TelemetrySummary,
  TelemetryTimeseriesBucket,
} from "../store/telemetryQueries";
import type {
  SkillTokenEstimate,
  TurnAnalyticsCounts,
} from "../store/turns/analyticsCounts";
import { TURNS_SOURCED_FILE_TYPES } from "../store/turns/analyticsCounts";

/**
 * The Analytics telemetry reads behind one entry point (issue #6516).
 *
 * `runTelemetryQuery` is called by BOTH executors: in-thread on the main
 * connections (`InlineTelemetryExecutor`, today's behaviour and the kill
 * switch) and in the query worker on read-only connections. The merge helpers
 * moved here unchanged from `web/routes/telemetry.ts`, so a route returns the
 * same JSON whichever executor ran it; the golden test proves it.
 *
 * Everything a kind takes and returns is a plain object, array, string or
 * number, so it crosses `postMessage` (structured clone) unchanged.
 */

/**
 * fileTypes whose counts come from `turn_events` (issue #1889 Sub K2). Every
 * other fileType (`hook`, plus any unknown value) stays sourced from the legacy
 * `telemetry.db`. The set drives the per-fileType source routing in the merge
 * helpers below.
 */
const TURNS_FILE_TYPES = new Set(TURNS_SOURCED_FILE_TYPES);

export interface TelemetryQuerySources {
  legacy: TelemetryQueries;
  turns: TurnAnalyticsCounts | null;
}

/** Each kind's parameters (exactly what the routes parse) and result. */
export interface TelemetryQueryMap {
  summary: {
    params: { fileType?: string; startTime?: number; endTime?: number };
    result: TelemetrySummary;
  };
  timeseries: {
    params: {
      filePath?: string;
      interval: "hour" | "day" | "week";
      startTime?: number;
      endTime?: number;
    };
    result: TelemetryTimeseriesBucket[];
  };
  files: {
    params: { fileType?: string };
    result: TelemetryFileInfo[];
  };
  "duration-stats": {
    params: { fileType?: string; startDate?: string; endDate?: string };
    result: DurationStats[];
  };
  "outcome-rates": {
    params: { fileType?: string; startDate?: string; endDate?: string };
    result: OutcomeRate[];
  };
  anomalies: {
    params: { windowDays?: number; threshold?: number };
    result: AnomalyRecord[];
  };
  comparison: {
    params: {
      period1Start: number;
      period1End: number;
      period2Start: number;
      period2End: number;
    };
    result: PeriodComparison[];
  };
  "token-estimates": {
    params: {
      fileType?: string;
      startTime?: number;
      endTime?: number;
      repo?: string;
    };
    result: SkillTokenEstimate[];
  };
  "session-aggregates": {
    params: { startTime?: number; endTime?: number; limit?: number };
    result: SessionAggregate[];
  };
  /** One UTC day's `daily_aggregates` rows, computed without writing. */
  computeDay: {
    params: { date: string };
    result: DailyAggregate[];
  };
  /** Days with events but no `daily_aggregates` rows at all. */
  missingDays: {
    params: Record<string, never>;
    result: string[];
  };
}

export type TelemetryQueryKind = keyof TelemetryQueryMap;
export type TelemetryQueryParams<K extends TelemetryQueryKind> =
  TelemetryQueryMap[K]["params"];
export type TelemetryQueryResult<K extends TelemetryQueryKind> =
  TelemetryQueryMap[K]["result"];

export const TELEMETRY_QUERY_KINDS: readonly TelemetryQueryKind[] = [
  "summary",
  "timeseries",
  "files",
  "duration-stats",
  "outcome-rates",
  "anomalies",
  "comparison",
  "token-estimates",
  "session-aggregates",
  "computeDay",
  "missingDays",
];

/**
 * The kinds that scan `events` row by row (seconds warm, minutes cold on a
 * prod-sized `telemetry.db`). In degraded mode these answer 503
 * `telemetry_unavailable` rather than run in-thread (D1 = option 1).
 */
export const EVENTS_SCAN_KINDS: ReadonlySet<TelemetryQueryKind> =
  new Set<TelemetryQueryKind>([
    "summary",
    "timeseries",
    "files",
    "comparison",
    "session-aggregates",
    "computeDay",
    "missingDays",
  ]);

/**
 * App-level merge for `summary` (issue #1889 D-C(a) — cross-DB merge, no ATTACH).
 * Source routing by fileType: skill/agent/mcp from `turn_events`, hook (and any
 * unknown type) from legacy `telemetry.db`. With no fileType filter the result
 * is turns{skill,agent,mcp} ∪ legacy{hook}, re-sorted by count DESC to preserve
 * the legacy ordering contract. Falls back to pure-legacy when the turns reader
 * is unavailable (fallback preservation — never replace the slow path).
 */
function mergedSummary(
  legacy: TelemetryQueries,
  turns: TurnAnalyticsCounts | null,
  filters: { fileType?: string; startTime?: number; endTime?: number }
): TelemetrySummary {
  if (!turns) return legacy.getSummary(filters);

  const f = filters.fileType;
  if (f === undefined) {
    const t = turns.getSummary(filters);
    const h = legacy.getSummary({ ...filters, fileType: "hook" });
    return {
      byFile: [...t.byFile, ...h.byFile].sort((a, b) => b.count - a.count),
      byType: [...t.byType, ...h.byType].sort((a, b) => b.count - a.count),
    };
  }
  if (TURNS_FILE_TYPES.has(f)) return turns.getSummary(filters);
  return legacy.getSummary(filters);
}

/**
 * App-level merge for `files` (issue #1889). Same per-fileType routing as
 * {@link mergedSummary}; unfiltered = turns files ∪ legacy hook files, by count.
 */
function mergedFiles(
  legacy: TelemetryQueries,
  turns: TurnAnalyticsCounts | null,
  fileType: string | undefined
): TelemetryFileInfo[] {
  if (!turns) return legacy.getFiles(fileType);
  if (fileType === undefined) {
    return [...turns.getFiles(undefined), ...legacy.getFiles("hook")].sort(
      (a, b) => b.count - a.count
    );
  }
  if (TURNS_FILE_TYPES.has(fileType)) return turns.getFiles(fileType);
  return legacy.getFiles(fileType);
}

/**
 * App-level merge for `timeseries` (issue #1889). The endpoint has no fileType
 * filter (only filePath), so we always take skill/agent/mcp buckets from turns
 * and the hook-only buckets from legacy (the new `fileType: "hook"` slice keeps
 * skill/agent from being double-counted), then sum on the shared bucket key.
 */
function mergedTimeseries(
  legacy: TelemetryQueries,
  turns: TurnAnalyticsCounts | null,
  params: {
    filePath?: string;
    interval: "hour" | "day" | "week";
    startTime?: number;
    endTime?: number;
  }
): TelemetryTimeseriesBucket[] {
  if (!turns) return legacy.getTimeseries(params);

  const byBucket = new Map<string, number>();
  for (const b of turns.getTimeseries(params)) {
    byBucket.set(b.bucket, (byBucket.get(b.bucket) ?? 0) + b.count);
  }
  for (const b of legacy.getTimeseries({ ...params, fileType: "hook" })) {
    byBucket.set(b.bucket, (byBucket.get(b.bucket) ?? 0) + b.count);
  }
  return [...byBucket.entries()]
    .map(([bucket, count]) => ({ bucket, count }))
    .sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
}

/**
 * Run one Analytics read. Synchronous: on the main thread this blocks for the
 * query's duration (the reason the worker exists); in the worker it blocks
 * only the worker.
 */
export function runTelemetryQuery<K extends TelemetryQueryKind>(
  kind: K,
  params: TelemetryQueryParams<K>,
  sources: TelemetryQuerySources
): TelemetryQueryResult<K> {
  const { legacy, turns } = sources;
  // Each case narrows `params` by hand: TypeScript does not narrow a generic
  // `K` through a switch, so the casts restate the map above.
  switch (kind) {
    case "summary":
      return mergedSummary(
        legacy,
        turns,
        params as TelemetryQueryParams<"summary">
      ) as TelemetryQueryResult<K>;
    case "timeseries":
      return mergedTimeseries(
        legacy,
        turns,
        params as TelemetryQueryParams<"timeseries">
      ) as TelemetryQueryResult<K>;
    case "files":
      return mergedFiles(
        legacy,
        turns,
        (params as TelemetryQueryParams<"files">).fileType
      ) as TelemetryQueryResult<K>;
    case "duration-stats":
      return legacy.getDurationStats(
        params as TelemetryQueryParams<"duration-stats">
      ) as TelemetryQueryResult<K>;
    case "outcome-rates":
      return legacy.getOutcomeRates(
        params as TelemetryQueryParams<"outcome-rates">
      ) as TelemetryQueryResult<K>;
    case "anomalies":
      return legacy.getAnomalies(
        params as TelemetryQueryParams<"anomalies">
      ) as TelemetryQueryResult<K>;
    case "comparison": {
      const p = params as TelemetryQueryParams<"comparison">;
      return legacy.getComparison(
        p.period1Start,
        p.period1End,
        p.period2Start,
        p.period2End
      ) as TelemetryQueryResult<K>;
    }
    case "token-estimates":
      // With the turns reader unavailable the answer is an empty list: there
      // is no measurement to serve (#2154 KD-1/KD-4).
      return (turns?.getSkillTokenEstimates(
        params as TelemetryQueryParams<"token-estimates">
      ) ?? []) as TelemetryQueryResult<K>;
    case "session-aggregates":
      return legacy.getSessionAggregates(
        params as TelemetryQueryParams<"session-aggregates">
      ) as TelemetryQueryResult<K>;
    case "computeDay":
      return legacy.computeDayAggregates(
        (params as TelemetryQueryParams<"computeDay">).date
      ) as TelemetryQueryResult<K>;
    case "missingDays":
      return legacy.missingAggregateDays() as TelemetryQueryResult<K>;
    default: {
      const never: never = kind;
      throw new Error(`unknown telemetry query kind: ${String(never)}`);
    }
  }
}

/**
 * Run `fn` inside one deferred read transaction on `db` (issue #6516 R9), so
 * the paired statements one job runs on that database (`byFile`/`byType`)
 * read one snapshot even while the main thread ingests. The worker nests one
 * call per database (`telemetry.db`, then `hapi.db`); turns and legacy live
 * in separate databases, so each gets its own snapshot, not one across both.
 * The worker's connections are read-only, so the transaction never upgrades to
 * a writer. A null `db` (no `hapi.db` reader) runs `fn` bare.
 */
export function withReadSnapshot<T>(db: Database | null, fn: () => T): T {
  if (!db) return fn();
  db.exec("BEGIN");
  try {
    return fn();
  } finally {
    db.exec("COMMIT");
  }
}
