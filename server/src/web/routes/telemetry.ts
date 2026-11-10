// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { TelemetryStore } from "../../store/telemetryStore";
import type { TurnAnalyticsCounts } from "../../store/turns/analyticsCounts";
import {
  extendTelemetryRequestTimeout,
  InlineTelemetryExecutor,
  logTelemetryEvent,
  TELEMETRY_AGGREGATE_LOG_CATEGORY,
  TelemetryExecutorError,
  TelemetryRequestAbortedError,
  type TelemetryExecutor,
} from "../../telemetry/executor";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { configuration } from "../../configuration";
import { constantTimeEquals } from "../../utils/crypto";
import { parseAccessToken } from "../../utils/accessToken";
import { logAndJson } from "./routeErrorHelper";

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
    /**
     * Where the reads run (issue #6516). The server passes the worker
     * executor; when absent, the routes run in-thread through an
     * `InlineTelemetryExecutor` over the two accessors above (today's
     * behaviour, which every `:memory:` route test relies on).
     */
    executor?: TelemetryExecutor | null;
  }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const getTurnAnalytics = options?.getTurnAnalytics ?? null;
  const executor: TelemetryExecutor =
    options?.executor ??
    new InlineTelemetryExecutor({
      getTelemetryStore,
      getTurnAnalytics,
      errorLogger,
    });
  const app = new Hono<WebAppEnv>();

  /**
   * Run an executor-backed read. Extends this request's Bun timeout first
   * (Premise P3), then maps an executor rejection to `503 {error, code}` with
   * `Retry-After`. Anything else propagates exactly as before #6516.
   */
  async function viaExecutor(
    c: Context<WebAppEnv>,
    fn: () => Promise<Response>
  ): Promise<Response> {
    extendTelemetryRequestTimeout(c.env, c.req.raw);
    try {
      return await fn();
    } catch (err) {
      const mapped = executorErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }
  }

  function executorErrorResponse(
    c: Context<WebAppEnv>,
    err: unknown
  ): Response | null {
    if (err instanceof TelemetryExecutorError) {
      return c.json({ error: err.message, code: err.code }, 503, {
        "Retry-After": "5",
      });
    }
    if (err instanceof TelemetryRequestAbortedError) {
      // The client has gone; the body is for completeness only.
      return c.json({ error: err.message, code: "telemetry_aborted" }, 503);
    }
    return null;
  }

  /**
   * Recompute today's `daily_aggregates` before a read of them. A failed
   * refresh still serves the stored aggregates, as before #6516, but is now
   * logged (rate-limited per category) instead of swallowed by a bare catch.
   */
  async function refreshToday(store: TelemetryStore): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    try {
      await executor.refreshDay(today, store);
    } catch (err) {
      logTelemetryEvent(
        { errorLogger },
        "warn",
        TELEMETRY_AGGREGATE_LOG_CATEGORY,
        `today refresh of ${today} failed; serving the stored aggregates: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

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
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startTimeStr = c.req.query("startTime");
      const endTimeStr = c.req.query("endTime");

      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;

      return viaExecutor(c, async () => {
        const summary = await executor.run(
          "summary",
          {
            fileType,
            startTime: startTime && !isNaN(startTime) ? startTime : undefined,
            endTime: endTime && !isNaN(endTime) ? endTime : undefined,
          },
          c.req.raw.signal
        );
        return c.json(summary);
      });
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
    async c => {
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

      return viaExecutor(c, async () => {
        const buckets = await executor.run(
          "timeseries",
          {
            filePath,
            interval: interval as "hour" | "day" | "week",
            startTime: startTime && !isNaN(startTime) ? startTime : undefined,
            endTime: endTime && !isNaN(endTime) ? endTime : undefined,
          },
          c.req.raw.signal
        );
        return c.json({ buckets });
      });
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
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      return viaExecutor(c, async () => {
        const files = await executor.run(
          "files",
          { fileType },
          c.req.raw.signal
        );
        return c.json({ files });
      });
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
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startDate = c.req.query("startDate") || undefined;
      const endDate = c.req.query("endDate") || undefined;

      return viaExecutor(c, async () => {
        await refreshToday(store);
        const stats = await executor.run(
          "duration-stats",
          { fileType, startDate, endDate },
          c.req.raw.signal
        );
        return c.json({ stats });
      });
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
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startDate = c.req.query("startDate") || undefined;
      const endDate = c.req.query("endDate") || undefined;

      return viaExecutor(c, async () => {
        await refreshToday(store);
        const rates = await executor.run(
          "outcome-rates",
          { fileType, startDate, endDate },
          c.req.raw.signal
        );
        return c.json({ rates });
      });
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
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const windowStr = c.req.query("window");
      const thresholdStr = c.req.query("threshold");
      const windowDays = windowStr ? parseInt(windowStr, 10) : undefined;
      const threshold = thresholdStr ? parseFloat(thresholdStr) : undefined;

      return viaExecutor(c, async () => {
        await refreshToday(store);
        const anomalies = await executor.run(
          "anomalies",
          { windowDays, threshold },
          c.req.raw.signal
        );
        return c.json({ anomalies });
      });
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
    async c => {
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

      return viaExecutor(c, async () => {
        const comparison = await executor.run(
          "comparison",
          {
            period1Start: parseInt(p1s, 10),
            period1End: parseInt(p1e, 10),
            period2Start: parseInt(p2s, 10),
            period2End: parseInt(p2e, 10),
          },
          c.req.raw.signal
        );
        return c.json({ comparison });
      });
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
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const fileType = c.req.query("fileType") || undefined;
      const startTimeStr = c.req.query("startTime");
      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTimeStr = c.req.query("endTime");
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;
      const repo = c.req.query("repo") || undefined;

      return viaExecutor(c, async () => {
        const estimates = await executor.run(
          "token-estimates",
          {
            fileType,
            startTime: startTime && !isNaN(startTime) ? startTime : undefined,
            endTime: endTime && !isNaN(endTime) ? endTime : undefined,
            repo,
          },
          c.req.raw.signal
        );
        return c.json({ estimates });
      });
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
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;

      const startTimeStr = c.req.query("startTime");
      const endTimeStr = c.req.query("endTime");
      const limitStr = c.req.query("limit");

      const startTime = startTimeStr ? parseInt(startTimeStr, 10) : undefined;
      const endTime = endTimeStr ? parseInt(endTimeStr, 10) : undefined;
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

      return viaExecutor(c, async () => {
        const sessions = await executor.run(
          "session-aggregates",
          {
            startTime: startTime && !isNaN(startTime) ? startTime : undefined,
            endTime: endTime && !isNaN(endTime) ? endTime : undefined,
            limit: limit && !isNaN(limit) ? limit : undefined,
          },
          c.req.raw.signal
        );
        return c.json({ sessions });
      });
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

      extendTelemetryRequestTimeout(c.env, c.req.raw);
      try {
        // Compute through the executor (off-thread in worker mode), write the
        // day atomically on the main connection. Degraded mode answers 503
        // telemetry_unavailable here: this route records no aggregate debt.
        if (date) {
          const rows = await executor.run(
            "computeDay",
            { date },
            c.req.raw.signal
          );
          store.replaceDayAggregates(date, rows);
          return c.json({ aggregated: date });
        }
        const count = await executor.aggregateMissing(store, c.req.raw.signal);
        return c.json({ aggregatedDays: count });
      } catch (err) {
        const mapped = executorErrorResponse(c, err);
        if (mapped) return mapped;
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
