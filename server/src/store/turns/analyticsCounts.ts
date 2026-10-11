// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type {
  TelemetryFileInfo,
  TelemetrySummary,
  TelemetryTimeseriesBucket,
} from "../telemetryStore";

/**
 * Turns-side analytics-counts reader — issue #1889 (epic #1662, Sub K2).
 *
 * Re-points the count-shaped telemetry endpoints (`summary`, `timeseries`,
 * `files`) onto the per-turn telemetry core. It returns the SAME shapes as the
 * legacy `TelemetryStore` (imported here so shape drift is a compile error, not
 * a silent regression — R1), but sources them from `turn_events` in `hapi.db`.
 *
 * Operator decision bundle (D-A(a)+D-B(a)+D-C(a)+D-D(subset), 2026-06-23):
 *   - Only the three turn_events kinds with a transcript-parser emitter are
 *     sourced here: `skill`, `subagent` (legacy `agent` analogue), and
 *     `mcp_call` (net-new). `hook` has NO turn_events emitter (hooks never
 *     appear in Claude's conversation transcript) and stays on `telemetry.db`.
 *   - Duration / outcome / eventType data is NOT in `turn_events`; those rich
 *     endpoints stay on `telemetry.db`. This reader is COUNT-shaped only.
 *
 * Why query `turn_events` directly and NOT the `v_analytics_counts` view: the
 * view is pre-aggregated across ALL time (`GROUP BY kind,name,node_id,namespace`)
 * and exposes only `first_ts_ms`/`last_ts_ms`, so it cannot honor the
 * `startTime`/`endTime`/`interval` filters these endpoints accept. The view
 * remains useful for un-windowed totals only.
 *
 * Read-only; never on the prompt/reply path. Pattern mirrors `TurnStore`
 * (constructor-takes-`Database`, named-`@param` queries under bun:sqlite
 * `{ strict: true }`); time-bucket SQL mirrors `telemetryStore.getTimeseries`
 * verbatim so buckets align for the app-level merge (issue #1889 D-C(a)).
 */

/** Legacy telemetry `fileType` → `turn_events.kind` (the three turns-sourced kinds). */
const FILETYPE_TO_KIND: Record<string, string> = {
  skill: "skill",
  agent: "subagent",
  mcp: "mcp_call",
};

/** Reverse map: `turn_events.kind` → legacy telemetry `fileType` label. */
const KIND_TO_FILETYPE: Record<string, string> = {
  skill: "skill",
  subagent: "agent",
  mcp_call: "mcp",
};

/** The full turns-sourced kind set (used when no fileType filter is given). */
const TURNS_KINDS = ["skill", "subagent", "mcp_call"];

/**
 * The `fileType` values this reader can serve (the route uses this to decide,
 * per fileType, whether a count comes from turns or stays legacy-sourced).
 */
export const TURNS_SOURCED_FILE_TYPES = ["skill", "agent", "mcp"];

/**
 * Bytes per token for the injected-body estimate (issue #2154).
 *
 * The transcript records bytes, not tokens — a tool_result carries no usage
 * counts — so a divisor is unavoidable. 4 matches the heuristic the deleted
 * `fileSizeEstimates` constant used, which keeps the unit comparable across the
 * change.
 *
 * What changed is not the divisor but what it divides: previously every skill
 * was assigned one hardcoded number (2,250 tokens each), so the figure carried
 * no per-skill information at all. Now the byte count is measured per
 * invocation, so skills rank against each other on real data. The residual error
 * is the tokenizer approximation, applied uniformly.
 */
const BYTES_PER_TOKEN = 4;

/**
 * Measured per-skill context-load cost (issue #2154). Replaces the legacy
 * `TokenEstimate`, whose `estimatedTokensPerLoad` was a per-fileType constant.
 */
export interface SkillTokenEstimate {
  /** Skill name (the `turn_events.name` of the skill event). */
  filePath: string;
  fileType: string;
  /** All invocations in the window, measured or not. */
  invocationCount: number;
  /** Median measured tokens per invocation; null when `measured` is false. */
  tokensP50: number | null;
  /** p90 measured tokens per invocation; null when `measured` is false. */
  tokensP90: number | null;
  /**
   * False when the window holds no token-bearing event for this skill. Callers
   * must render/skip these rather than substituting 0 — a skill reported as free
   * ranks as free and never gets dieted (KD-4).
   */
  measured: boolean;
  /** Invocations that actually carried a measurement — the percentile denominator. */
  sampleCount: number;
}

export class TurnAnalyticsCounts {
  constructor(private readonly db: Database) {}

  /**
   * Map a legacy `fileType` filter to the `turn_events.kind` values to query.
   * - `undefined` → all three turns kinds.
   * - a turns-sourced fileType → that single kind.
   * - anything else (`hook`, unknown) → `[]` (this reader has no rows for it;
   *   the caller keeps that fileType legacy-sourced).
   */
  private resolveKinds(fileType?: string): string[] {
    if (fileType === undefined) return [...TURNS_KINDS];
    const kind = FILETYPE_TO_KIND[fileType];
    return kind ? [kind] : [];
  }

  /**
   * Build the WHERE clause + bound params for a kind set plus optional
   * `filePath` (matched against the event `name`) and `ts_ms` window. Only
   * params that appear in the clause are added (bun:sqlite strict mode).
   * `startTime`/`endTime` use truthy guards to mirror `telemetryStore` exactly.
   */
  private buildWhere(opts: {
    kinds: string[];
    startTime?: number;
    endTime?: number;
    filePath?: string;
  }): { clause: string; params: Record<string, string | number> } {
    const conditions: string[] = [];
    const params: Record<string, string | number> = {};

    const placeholders = opts.kinds.map((_, i) => `@k${i}`).join(", ");
    opts.kinds.forEach((kind, i) => {
      params[`k${i}`] = kind;
    });
    conditions.push(`kind IN (${placeholders})`);

    if (opts.filePath) {
      conditions.push("COALESCE(name, kind) = @file_path");
      params.file_path = opts.filePath;
    }
    if (opts.startTime) {
      conditions.push("ts_ms >= @start_time");
      params.start_time = opts.startTime;
    }
    if (opts.endTime) {
      conditions.push("ts_ms <= @end_time");
      params.end_time = opts.endTime;
    }

    return { clause: `WHERE ${conditions.join(" AND ")}`, params };
  }

  /**
   * Count-shaped summary (mirrors `TelemetryStore.getSummary`). `byFile` groups
   * by event `name` (the legacy `filePath` analogue); `byType` groups by kind,
   * mapped back to the legacy `fileType` label. Returns empty for a non-turns
   * fileType (e.g. `hook`).
   */
  getSummary(filters?: {
    fileType?: string;
    startTime?: number;
    endTime?: number;
  }): TelemetrySummary {
    const kinds = this.resolveKinds(filters?.fileType);
    if (kinds.length === 0) return { byFile: [], byType: [] };

    const { clause, params } = this.buildWhere({
      kinds,
      startTime: filters?.startTime,
      endTime: filters?.endTime,
    });

    const byFile = this.db
      .prepare(
        `SELECT COALESCE(name, kind) as file_path, COUNT(*) as count
         FROM turn_events ${clause}
         GROUP BY COALESCE(name, kind) ORDER BY count DESC`
      )
      .all(params) as Array<{ file_path: string; count: number }>;

    const byType = this.db
      .prepare(
        `SELECT kind, COUNT(*) as count
         FROM turn_events ${clause}
         GROUP BY kind ORDER BY count DESC`
      )
      .all(params) as Array<{ kind: string; count: number }>;

    return {
      byFile: byFile.map(r => ({ filePath: r.file_path, count: r.count })),
      byType: byType.map(r => ({
        fileType: KIND_TO_FILETYPE[r.kind] ?? r.kind,
        count: r.count,
      })),
    };
  }

  /**
   * Time-bucketed counts for the turns-sourced kinds (mirrors
   * `TelemetryStore.getTimeseries`). Has no `fileType` filter (matching the
   * legacy method) — it always covers `skill`/`subagent`/`mcp_call`. The bucket
   * expressions are byte-identical to the legacy method so the route can merge
   * turns buckets with the legacy `hook` buckets by summing on the same key.
   */
  getTimeseries(params: {
    filePath?: string;
    interval: "hour" | "day" | "week";
    startTime?: number;
    endTime?: number;
  }): TelemetryTimeseriesBucket[] {
    const { clause, params: bound } = this.buildWhere({
      kinds: [...TURNS_KINDS],
      startTime: params.startTime,
      endTime: params.endTime,
      filePath: params.filePath,
    });

    let bucketExpr: string;
    switch (params.interval) {
      case "hour":
        bucketExpr =
          "strftime('%Y-%m-%dT%H:00:00Z', ts_ms / 1000, 'unixepoch')";
        break;
      case "day":
        bucketExpr = "strftime('%Y-%m-%d', ts_ms / 1000, 'unixepoch')";
        break;
      case "week":
        bucketExpr = "strftime('%Y-W%W', ts_ms / 1000, 'unixepoch')";
        break;
    }

    const rows = this.db
      .prepare(
        `SELECT ${bucketExpr} as bucket, COUNT(*) as count
         FROM turn_events ${clause}
         GROUP BY bucket ORDER BY bucket`
      )
      .all(bound) as Array<{ bucket: string; count: number }>;

    return rows;
  }

  /**
   * File listing with stats (mirrors `TelemetryStore.getFiles`). `filePath`
   * comes from the event `name`; `fileType` is the kind mapped to its legacy
   * label. Returns empty for a non-turns fileType.
   */
  getFiles(fileType?: string): TelemetryFileInfo[] {
    const kinds = this.resolveKinds(fileType);
    if (kinds.length === 0) return [];

    const { clause, params } = this.buildWhere({ kinds });

    const rows = this.db
      .prepare(
        `SELECT COALESCE(name, kind) as file_path, kind, COUNT(*) as count, MAX(ts_ms) as last_seen
         FROM turn_events ${clause}
         GROUP BY COALESCE(name, kind), kind
         ORDER BY count DESC`
      )
      .all(params) as Array<{
      file_path: string;
      kind: string;
      count: number;
      last_seen: number;
    }>;

    return rows.map(r => ({
      filePath: r.file_path,
      fileType: KIND_TO_FILETYPE[r.kind] ?? r.kind,
      count: r.count,
      lastSeen: r.last_seen,
    }));
  }

  /**
   * Measured p50/p90 context-load cost per skill over a rolling window
   * (issue #2154, R3).
   *
   * Sourced from the `injectedBytes` payload the transcript parser records on
   * each `skill` event — the real size of the SKILL.md body that invocation
   * pushed into context. This is the surface that replaces the hardcoded
   * `fileSizeEstimates` constant.
   *
   * Skill-scoped by design: `injectedBytes` only exists for skills. A `subagent`
   * or `mcp_call` tool_result is a *return value*, not a context-load of a file,
   * so there is no comparable figure to report and a non-skill `fileType` filter
   * returns empty rather than inventing one.
   *
   * NULL payloads are filtered out of the percentile sample, never coalesced to
   * 0 (OR-5): events predating this measurement, and errored invocations, carry
   * no size, and folding them in as zeros would drag every percentile down.
   *
   * Percentiles use the ordered-OFFSET idiom from `telemetryStore.aggregateDay`.
   */
  getSkillTokenEstimates(filters?: {
    fileType?: string;
    startTime?: number;
    endTime?: number;
    repo?: string;
  }): SkillTokenEstimate[] {
    // Only skills carry an injected-body measurement — see the docblock.
    if (filters?.fileType !== undefined && filters.fileType !== "skill") {
      return [];
    }

    const conditions: string[] = ["e.kind = 'skill'"];
    const params: Record<string, string | number> = {};

    // Join `turns` only when a repo filter is present — the window filter reads
    // the denormalized `turn_events.ts_ms` and needs no join.
    let join = "";
    if (filters?.repo) {
      join = "JOIN turns t ON t.id = e.turn_id";
      conditions.push("t.repo = @repo");
      params.repo = filters.repo;
    }
    if (filters?.startTime) {
      conditions.push("e.ts_ms >= @start_time");
      params.start_time = filters.startTime;
    }
    if (filters?.endTime) {
      conditions.push("e.ts_ms <= @end_time");
      params.end_time = filters.endTime;
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const bytesExpr = "json_extract(e.payload, '$.injectedBytes')";

    // COUNT(expr) skips NULLs, so sample_count is the measured subset of
    // invocation_count — the two differ exactly when some events lack a size.
    const rows = this.db
      .prepare(
        `SELECT COALESCE(e.name, e.kind) as file_path,
           COUNT(*) as invocation_count,
           COUNT(${bytesExpr}) as sample_count
         FROM turn_events e ${join} ${where}
         GROUP BY COALESCE(e.name, e.kind)
         ORDER BY invocation_count DESC`
      )
      .all(params) as Array<{
      file_path: string;
      invocation_count: number;
      sample_count: number;
    }>;

    const pctQuery = this.db.prepare(
      `SELECT ${bytesExpr} as bytes
         FROM turn_events e ${join} ${where}
           AND COALESCE(e.name, e.kind) = @fp
           AND ${bytesExpr} IS NOT NULL
         ORDER BY bytes
         LIMIT 1 OFFSET @offset`
    );

    const bytesAt = (filePath: string, offset: number): number | null => {
      const row = pctQuery.get({ ...params, fp: filePath, offset }) as {
        bytes: number;
      } | null;
      return row?.bytes ?? null;
    };

    const toTokens = (bytes: number | null): number | null =>
      bytes === null ? null : Math.round(bytes / BYTES_PER_TOKEN);

    return rows.map(r => {
      const measured = r.sample_count > 0;
      if (!measured) {
        return {
          filePath: r.file_path,
          fileType: "skill",
          invocationCount: r.invocation_count,
          tokensP50: null,
          tokensP90: null,
          measured: false,
          sampleCount: 0,
        };
      }
      return {
        filePath: r.file_path,
        fileType: "skill",
        invocationCount: r.invocation_count,
        tokensP50: toTokens(
          bytesAt(r.file_path, Math.floor(r.sample_count * 0.5))
        ),
        tokensP90: toTokens(
          bytesAt(r.file_path, Math.floor(r.sample_count * 0.9))
        ),
        measured: true,
        sampleCount: r.sample_count,
      };
    });
  }
}
