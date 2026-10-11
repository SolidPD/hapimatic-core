// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type {
  TelemetryFileInfo,
  TelemetryStore,
  TelemetrySummary,
  TelemetryTimeseriesBucket,
} from "../../store/telemetryStore";
import type { TurnAnalyticsCounts } from "../../store/turns/analyticsCounts";
import { TURNS_SOURCED_FILE_TYPES } from "../../store/turns/analyticsCounts";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { configuration } from "../../configuration";
import { constantTimeEquals } from "../../utils/crypto";
import { parseAccessToken } from "../../utils/accessToken";
import { logAndJson } from "./routeErrorHelper";

/**
 * fileTypes whose counts come from `turn_events` (issue #1889 Sub K2). Every
 * other fileType (`hook`, plus any unknown value) stays sourced from the legacy
 * `telemetry.db`. The set drives the per-fileType source routing in the merge
 * helpers below.
 */
const TURNS_FILE_TYPES = new Set(TURNS_SOURCED_FILE_TYPES);

/**
 * App-level merge for `summary` (issue #1889 D-C(a) — cross-DB merge, no ATTACH).
 * Source routing by fileType: skill/agent/mcp from `turn_events`, hook (and any
 * unknown type) from legacy `telemetry.db`. With no fileType filter the result
 * is turns{skill,agent,mcp} ∪ legacy{hook}, re-sorted by count DESC to preserve
 * the legacy ordering contract. Falls back to pure-legacy when the turns reader
 * is unavailable (fallback preservation — never replace the slow path).
 */
function mergedSummary(
  legacy: TelemetryStore,
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
  legacy: TelemetryStore,
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
  legacy: TelemetryStore,
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

const eventSchema = z.object({
  filePath: z.string().min(1),
  fileType: z.enum(["skill", "hook", "agent"]),
  eventType: z.enum(["invocation", "completion", "skip", "error"]),
  sessionId: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
  outcome: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  // #2154. Optional by contract: this endpoint is Tailscale-exposed and hooks
  // deploy independently of the server, so a writer that omits these must still
  // get a 200 and a row with NULLs. They are declared here and not only in the
  // store because this z.object strips unrecognized keys — a writer sending them
  // against an unextended schema would be silently dropped, with a 200 either way.
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  sessionRole: z.string().optional(),
  repo: z.string().optional(),
});

const batchSchema = z.array(eventSchema);

/**
 * Telemetry ingestion route — mounted BEFORE JWT middleware.
 * Uses CLI API token auth (same as /cli/* routes) so hooks can POST
 * without JWT overhead.
 */
export function createTelemetryIngestRoute(
  getTelemetryStore: () => TelemetryStore | null
): Hono {
  const app = new Hono();

  // POST /telemetry/event — ingest single event or batch (CLI token auth)
  app.post(
    "/telemetry/event",
    cataloged(
      defineCapability({
        id: "telemetry.event",
        domain: "telemetry",
        surface: "rest",
        description:
          "Ingest a single hook telemetry event or a batch array into the telemetry store (CLI-token authenticated).",
        whenToUse:
          "When the hooks telemetry logger records capability, skill, agent, or MCP usage events.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/telemetry/event",
        },
        auth: "cli-token",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    async c => {
      // Validate CLI API token (required — endpoint is Tailscale-exposed)
      const raw = c.req.header("authorization");
      if (!raw) {
        return c.json({ error: "Authorization required" }, 401);
      }
      const token = raw.replace(/^Bearer\s+/i, "");
      const parsedToken = parseAccessToken(token);
      if (
        !parsedToken ||
        !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)
      ) {
        return c.json({ error: "Invalid token" }, 401);
      }

      const store = getTelemetryStore();
      if (!store) {
        return c.json({ error: "Telemetry store not available" }, 503);
      }

      const body = await c.req.json().catch(() => null);
      if (!body) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      // Detect batch (array) vs single (object)
      if (Array.isArray(body)) {
        const parsed = batchSchema.safeParse(body);
        if (!parsed.success) {
          return c.json(
            { error: "Invalid batch body", details: parsed.error.issues },
            400
          );
        }
        const events = store.insertEvents(parsed.data);
        return c.json({ events, count: events.length }, 201);
      }

      const parsed = eventSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid event body", details: parsed.error.issues },
          400
        );
      }
      const event = store.insertEvent(parsed.data);
      return c.json({ event }, 201);
    }
  );

  return app;
}

/**
 * Telemetry query routes — mounted AFTER JWT middleware.
 * Dashboard GET endpoints require authenticated web sessions.
 */
export function createTelemetryRoutes(
  getTelemetryStore: () => TelemetryStore | null,
  options?: {
    errorLogger?: ErrorLogger | null;
    /**
     * Late-bound accessor for the turn_events analytics-counts reader (issue
     * #1889). When present, the count-shaped endpoints (summary/timeseries/
     * files) merge turns-sourced skill/agent/mcp counts with legacy hook
     * counts. When absent (or returns null), the endpoints fall back to
     * pure-legacy behavior.
     */
    getTurnAnalytics?: () => TurnAnalyticsCounts | null;
  }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const getTurnAnalytics = options?.getTurnAnalytics ?? null;
  const app = new Hono<WebAppEnv>();

  function requireStore(c: {
    json: (data: unknown, status?: number) => Response;
  }): TelemetryStore | Response {
    const store = getTelemetryStore();
    if (!store) {
      return c.json({ error: "Telemetry store not available" }, 503);
    }
    return store;
  }

  // GET /telemetry/summary — aggregated counts
  app.get(
    "/telemetry/summary",
    cataloged(
      defineCapability({
        id: "telemetry.summary",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return aggregated telemetry counts by file type over an optional time window, merging turn-events and legacy sources.",
        whenToUse: "When populating the telemetry dashboard's summary totals.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/summary",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startTimeStr = c.req.query("startTime");
      const endTimeStr = c.req.query("endTime");

      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;

      const summary = mergedSummary(store, getTurnAnalytics?.() ?? null, {
        fileType,
        startTime: startTime && !isNaN(startTime) ? startTime : undefined,
        endTime: endTime && !isNaN(endTime) ? endTime : undefined,
      });

      return c.json(summary);
    }
  );

  // GET /telemetry/timeseries — time-bucketed counts
  app.get(
    "/telemetry/timeseries",
    cataloged(
      defineCapability({
        id: "telemetry.timeseries",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return time-bucketed telemetry counts (hour, day, or week) over an optional window for an optional file path.",
        whenToUse:
          "When drawing the telemetry dashboard's usage-over-time chart.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/timeseries",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const filePath = c.req.query("filePath") || undefined;
      const interval = c.req.query("interval") || "day";
      const startTimeStr = c.req.query("startTime");
      const endTimeStr = c.req.query("endTime");

      if (!["hour", "day", "week"].includes(interval)) {
        return c.json(
          { error: "interval must be one of: hour, day, week" },
          400
        );
      }

      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;

      const buckets = mergedTimeseries(store, getTurnAnalytics?.() ?? null, {
        filePath,
        interval: interval as "hour" | "day" | "week",
        startTime: startTime && !isNaN(startTime) ? startTime : undefined,
        endTime: endTime && !isNaN(endTime) ? endTime : undefined,
      });

      return c.json({ buckets });
    }
  );

  // GET /telemetry/files — file listing with stats
  app.get(
    "/telemetry/files",
    cataloged(
      defineCapability({
        id: "telemetry.files",
        domain: "telemetry",
        surface: "rest",
        description:
          "List telemetry-tracked files with per-file usage stats. Exposes file paths, so it is not a generically-invocable read.",
        whenToUse:
          "When showing the per-file usage breakdown in the telemetry dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/files",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const files = mergedFiles(store, getTurnAnalytics?.() ?? null, fileType);

      return c.json({ files });
    }
  );

  // GET /telemetry/duration-stats — duration percentiles per file
  app.get(
    "/telemetry/duration-stats",
    cataloged(
      defineCapability({
        id: "telemetry.duration-stats",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return duration percentiles per file (p50, p90, etc.) across telemetry events over an optional date range.",
        whenToUse:
          "When showing event-duration statistics in the telemetry dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/duration-stats",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startDate = c.req.query("startDate") || undefined;
      const endDate = c.req.query("endDate") || undefined;

      // Trigger aggregation for today before querying
      try {
        store.aggregateDay();
      } catch {
        // Non-critical — stale data is acceptable
      }

      const stats = store.getDurationStats({ fileType, startDate, endDate });
      return c.json({ stats });
    }
  );

  // GET /telemetry/outcome-rates — success/failure rates per file
  app.get(
    "/telemetry/outcome-rates",
    cataloged(
      defineCapability({
        id: "telemetry.outcome-rates",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return success and failure outcome rates per file aggregated across telemetry events over an optional date range.",
        whenToUse:
          "When showing outcome (success/failure) rates in the telemetry dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/outcome-rates",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startDate = c.req.query("startDate") || undefined;
      const endDate = c.req.query("endDate") || undefined;

      try {
        store.aggregateDay();
      } catch {
        // Non-critical
      }

      const rates = store.getOutcomeRates({ fileType, startDate, endDate });
      return c.json({ rates });
    }
  );

  // GET /telemetry/anomalies — files exceeding baseline usage
  app.get(
    "/telemetry/anomalies",
    cataloged(
      defineCapability({
        id: "telemetry.anomalies",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return files whose recent telemetry usage exceeds their baseline by a threshold over a rolling window.",
        whenToUse:
          "When surfacing anomalous usage spikes in the telemetry dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/anomalies",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const windowStr = c.req.query("window");
      const thresholdStr = c.req.query("threshold");
      const windowDays = windowStr ? parseInt(windowStr, 10) : undefined;
      const threshold = thresholdStr ? parseFloat(thresholdStr) : undefined;

      try {
        store.aggregateDay();
      } catch {
        // Non-critical
      }

      const anomalies = store.getAnomalies({ windowDays, threshold });
      return c.json({ anomalies });
    }
  );

  // GET /telemetry/comparison — compare two time periods
  app.get(
    "/telemetry/comparison",
    cataloged(
      defineCapability({
        id: "telemetry.comparison",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return a side-by-side telemetry comparison between two timestamp windows for delta analysis.",
        whenToUse:
          "When comparing telemetry usage across two time periods in the dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/comparison",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const p1s = c.req.query("period1Start");
      const p1e = c.req.query("period1End");
      const p2s = c.req.query("period2Start");
      const p2e = c.req.query("period2End");

      if (!p1s || !p1e || !p2s || !p2e) {
        return c.json(
          {
            error:
              "Required: period1Start, period1End, period2Start, period2End (timestamps)",
          },
          400
        );
      }

      const comparison = store.getComparison(
        parseInt(p1s, 10),
        parseInt(p1e, 10),
        parseInt(p2s, 10),
        parseInt(p2e, 10)
      );
      return c.json({ comparison });
    }
  );

  // GET /telemetry/token-estimates — MEASURED token cost per skill (#2154).
  //
  // Path kept for back-compat; the row shape changed. It previously reported
  // `estimatedTokensPerLoad` from a per-fileType constant (every skill = 2,250
  // tokens), which made the endpoint rank skills purely by invocation frequency
  // and never by cost. It now reports p50/p90 measured from the injected SKILL.md
  // body recorded on each turn's skill event.
  //
  // Rows are skill-only: `injectedBytes` exists for no other kind (see
  // `getSkillTokenEstimates`). With the turns reader unavailable the answer is an
  // empty list — there is no measurement to serve, and the constant that used to
  // fill the gap was the bug this issue exists to remove (KD-1/KD-4).
  app.get(
    "/telemetry/token-estimates",
    cataloged(
      defineCapability({
        id: "telemetry.token-estimates",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return measured per-skill token-cost estimates (p50, p90) derived from recorded skill-injection sizes over an optional window.",
        whenToUse:
          "When ranking skills by measured token cost in the telemetry dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/token-estimates",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startTimeStr = c.req.query("startTime");
      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTimeStr = c.req.query("endTime");
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;
      const repo = c.req.query("repo") || undefined;

      const turns = getTurnAnalytics?.() ?? null;
      const estimates =
        turns?.getSkillTokenEstimates({
          fileType,
          startTime: startTime && !isNaN(startTime) ? startTime : undefined,
          endTime: endTime && !isNaN(endTime) ? endTime : undefined,
          repo,
        }) ?? [];
      return c.json({ estimates });
    }
  );

  // GET /telemetry/session-aggregates — session-level rollups with archetypes
  app.get(
    "/telemetry/session-aggregates",
    cataloged(
      defineCapability({
        id: "telemetry.session-aggregates",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return per-session telemetry rollups with archetypes. Exposes per-session content, so it is not a generically-invocable read.",
        whenToUse:
          "When showing per-session telemetry rollups in the dashboard.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/telemetry/session-aggregates",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const startTimeStr = c.req.query("startTime");
      const endTimeStr = c.req.query("endTime");
      const limitStr = c.req.query("limit");

      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

      const sessions = store.getSessionAggregates({
        startTime: startTime && !isNaN(startTime) ? startTime : undefined,
        endTime: endTime && !isNaN(endTime) ? endTime : undefined,
        limit: limit && !isNaN(limit) ? limit : undefined,
      });
      return c.json({ sessions });
    }
  );

  // POST /telemetry/aggregate — trigger aggregation for a specific date or today
  app.post(
    "/telemetry/aggregate",
    cataloged(
      defineCapability({
        id: "telemetry.aggregate",
        domain: "telemetry",
        surface: "rest",
        description:
          "Trigger server-side telemetry aggregation for a specific date, or backfill every missing day when no date is given.",
        whenToUse:
          "When the dashboard needs telemetry rollups computed on demand for a date or backfilled.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/telemetry/aggregate",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user", mountedWhen: "getTelemetryStore" },
        probe: "skip",
        telemetry: "off",
      })
    ),
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const body = await c.req.json().catch(() => null);
      const date = (body as { date?: string } | null)?.date;

      try {
        if (date) {
          store.aggregateDay(date);
          return c.json({ aggregated: date });
        }
        const count = store.aggregateMissing();
        return c.json({ aggregatedDays: count });
      } catch (err) {
        return logAndJson(c, err, 500, {
          errorLogger,
          category: "telemetry-aggregate",
          fallbackMessage: `Aggregation failed: ${String(err)}`,
          severity: "warn",
        });
      }
    }
  );

  return app;
}
