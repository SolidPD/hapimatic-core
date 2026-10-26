// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import type { Store } from "../../store";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { configuration } from "../../configuration";
import { loadTimeLogConfig } from "../../config/timeLogConfig";
import { logAndJson } from "./routeErrorHelper";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { createRateLimiter } from "../middleware/rateLimit";
import { getTimelogSoakStatus } from "../../store/turns/cutoverGate";
import type { TimelogAdjustmentRow } from "../../store/turns/types";

// #2188 Task 7: shared date-only pattern for the derived-route epoch pre-filter
// (the zod schema above and the :257 guard keep their own inline copies).
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Issue #1670 (Sub H1, PR-2): the six clock controls → append-only
// timelog_adjustments rows. Discriminated union on `type`; namespace, tsMs, and
// nodeId are ALL server-derived (R4) — never trusted from the client body.
const adjustmentBaseSchema = z.object({
  hapiSessionId: z.string().min(1),
  note: z.string().max(1000).optional(),
});
const adjustmentRequestSchema = z.discriminatedUnion("type", [
  adjustmentBaseSchema.extend({
    type: z.literal("adjust"),
    deltaMs: z.number().int(),
  }),
  adjustmentBaseSchema.extend({
    type: z.literal("set"),
    toMs: z.number().int().min(0),
    fromMs: z.number().int().optional(),
  }),
  adjustmentBaseSchema.extend({
    type: z.literal("reset"),
    fromMs: z.number().int().optional(),
  }),
  adjustmentBaseSchema.extend({
    type: z.literal("undo"),
    targetAdjustmentId: z.string().min(1),
  }),
  adjustmentBaseSchema.extend({
    type: z.literal("disable"),
    fromMs: z.number().int(),
    toMs: z.number().int(),
  }),
  adjustmentBaseSchema.extend({
    type: z.literal("enable"),
    fromMs: z.number().int(),
    toMs: z.number().int(),
  }),
]);

export function createTimeLogRoutes(
  getStore: () => Store | null,
  getSyncEngine: () => SyncEngine | null,
  options?: {
    errorLogger?: ErrorLogger | null;
    getLocalNodeId?: () => string | null;
    getDataDir?: () => string;
  }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const getLocalNodeId = options?.getLocalNodeId;
  // Injectable for tests; defaults to the global configuration's dataDir at the
  // mount (where configuration is always initialized).
  const resolveDataDir = options?.getDataDir ?? (() => configuration.dataDir);
  const adjustmentLimiter = createRateLimiter({ name: "timelog-adjust" });
  const app = new Hono<WebAppEnv>();

  // Helper to get store or return error response
  function requireStore(c: {
    json: (data: unknown, status?: number) => Response;
  }): Store | Response {
    const store = getStore();
    if (!store) {
      return c.json({ error: "Store not available" }, 503);
    }
    return store;
  }

  // GET /timelogs - List entries with filters
  app.get(
    "/timelogs",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-list",
        domain: "telemetry",
        surface: "rest",
        description:
          "List time-tracking entries for the caller's namespace, filtered by an optional date range.",
        whenToUse: "When the user reviews logged time entries.",
        invocation: { kind: "rest", method: "GET", path: "/api/timelogs" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }

      const namespace = c.get("namespace");
      const startDate = c.req.query("startDate");
      const endDate = c.req.query("endDate");
      const sessionId = c.req.query("sessionId");
      const projectDirectory = c.req.query("projectDirectory");
      const limitStr = c.req.query("limit");
      const limit = limitStr ? parseInt(limitStr, 10) : undefined;

      const entries = store.timeLogs.getEntries(
        {
          startDate: startDate || undefined,
          endDate: endDate || undefined,
          sessionId: sessionId || undefined,
          projectDirectory: projectDirectory || undefined,
          limit: limit && !isNaN(limit) ? limit : 100,
        },
        namespace
      );

      return c.json({
        entries,
        total: entries.length,
      });
    }
  );

  // GET /timelogs/summary/daily - Daily summary
  app.get(
    "/timelogs/summary/daily",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-summary-daily",
        domain: "telemetry",
        surface: "rest",
        description:
          "Summarize tracked time per day for the caller's namespace over a date range.",
        whenToUse: "When the user wants a daily time-tracking summary.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/timelogs/summary/daily",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }

      const namespace = c.get("namespace");
      const date = c.req.query("date");

      // Issue #1228: when no date is supplied, default to today in the
      // server's configured IANA timezone (settings.json → loadTimeLogConfig)
      // rather than the previous hardcoded America/New_York.
      let effectiveDate = date;
      if (!effectiveDate) {
        const cfg = await loadTimeLogConfig(configuration.dataDir);
        effectiveDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: cfg.timezone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
      }

      const summary = store.timeLogs.getDailySummary(effectiveDate, namespace);

      return c.json(summary);
    }
  );

  // GET /timelogs/summary/weekly - Weekly summary
  app.get(
    "/timelogs/summary/weekly",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-summary-weekly",
        domain: "telemetry",
        surface: "rest",
        description:
          "Summarize tracked time per week for the caller's namespace over a date range.",
        whenToUse: "When the user wants a weekly time-tracking summary.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/timelogs/summary/weekly",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        // probe: needs ?startDate= (#5212)
        probe: "skip",
      })
    ),
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }

      const namespace = c.get("namespace");
      const startDate = c.req.query("startDate");

      if (!startDate) {
        return c.json({ error: "startDate query parameter is required" }, 400);
      }

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        return c.json({ error: "startDate must be in YYYY-MM-DD format" }, 400);
      }

      // Issue #1228: thread the server's configured IANA timezone through
      // so the underlying addDaysInTimezone helper computes a DST-correct
      // end-of-week date instead of relying on defaultTimezone()'s runtime
      // resolution (which drifts when the host TZ differs from the user's).
      const cfg = await loadTimeLogConfig(configuration.dataDir);
      const summary = store.timeLogs.getWeeklySummary(
        startDate,
        namespace,
        cfg.timezone
      );

      return c.json(summary);
    }
  );

  // GET /timelogs/summary/project-grouped - Project-grouped summary for a date range
  app.get(
    "/timelogs/summary/project-grouped",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-summary-project-grouped",
        domain: "telemetry",
        surface: "rest",
        description:
          "Summarize tracked time grouped by project directory for the caller's namespace over a date range.",
        whenToUse: "When the user wants time broken down by project.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/timelogs/summary/project-grouped",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        // probe: needs ?startDate= and ?endDate= (#5212)
        probe: "skip",
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }

      const namespace = c.get("namespace");
      const startDate = c.req.query("startDate");
      const endDate = c.req.query("endDate");

      if (!startDate || !endDate) {
        return c.json(
          { error: "startDate and endDate query parameters are required" },
          400
        );
      }

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(startDate) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(endDate)
      ) {
        return c.json({ error: "Dates must be in YYYY-MM-DD format" }, 400);
      }

      const summary = store.timeLogs.getProjectGroupedSummary(
        startDate,
        endDate,
        namespace
      );

      return c.json(summary);
    }
  );

  // GET /timelogs/projects - List distinct project directories
  app.get(
    "/timelogs/projects",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-projects",
        domain: "telemetry",
        surface: "rest",
        description:
          "List the distinct project directories that have tracked time in the caller's namespace.",
        whenToUse: "When the user needs the set of projects with logged time.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/timelogs/projects",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }

      const namespace = c.get("namespace");
      const projects = store.timeLogs.getDistinctProjectDirectories(namespace);

      return c.json({ projects });
    }
  );

  // ───────────────────────────────────────────────────────────────────
  // Issue #1670 (Sub H1, PR-2): six-control ledger writes + derived read.
  // Namespace-local (no federation proxy — mirrors the existing /timelogs
  // routes). DORMANT: the client gates ALL user-visible switching on
  // GET /timelogs/cutover-status, so these endpoints are inert until the
  // Sub-G parity green streak opens the gate.
  // ───────────────────────────────────────────────────────────────────

  // POST /timelogs/adjustments — append one of the six clock controls (R3, R4).
  // Undo writes a reversing entry (never deletes); Disable/Enable write ranges.
  app.post(
    "/timelogs/adjustments",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-create-adjustment",
        domain: "telemetry",
        surface: "rest",
        description:
          "Append a manual clock adjustment (adjust, set, reset, undo, disable, or enable) to the time-tracking ledger.",
        whenToUse:
          "When the user corrects or overrides tracked time for a session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/timelogs/adjustments",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"type":"adjust","hapiSessionId":"hapi-123","deltaMs":60000}',
      })
    ),
    adjustmentLimiter,
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }
      const namespace = c.get("namespace");
      const body = await c.req.json().catch(() => null);
      const parsed = adjustmentRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      }

      // R4: namespace + tsMs + nodeId are server-derived (never from the body).
      const base = {
        hapiSessionId: parsed.data.hapiSessionId,
        nodeId: getLocalNodeId?.() ?? "unknown",
        namespace,
        tsMs: Date.now(),
        note: parsed.data.note ?? null,
      };
      const adj = store.timelogAdjustments;

      try {
        let row: TimelogAdjustmentRow;
        switch (parsed.data.type) {
          case "adjust":
            row = adj.adjust({ ...base, deltaMs: parsed.data.deltaMs });
            break;
          case "set":
            row = adj.set({
              ...base,
              toMs: parsed.data.toMs,
              fromMs: parsed.data.fromMs ?? null,
            });
            break;
          case "reset":
            row = adj.reset({ ...base, fromMs: parsed.data.fromMs ?? null });
            break;
          case "undo":
            row = adj.undo({
              ...base,
              targetAdjustmentId: parsed.data.targetAdjustmentId,
            });
            break;
          case "disable":
            row = adj.disableRange({
              ...base,
              fromMs: parsed.data.fromMs,
              toMs: parsed.data.toMs,
            });
            break;
          case "enable":
            row = adj.enableRange({
              ...base,
              fromMs: parsed.data.fromMs,
              toMs: parsed.data.toMs,
            });
            break;
        }
        return c.json({ adjustment: row });
      } catch (error) {
        // undo() throws when the target adjustment does not exist → 404.
        if (
          error instanceof Error &&
          error.message.includes("does not exist")
        ) {
          return c.json({ error: error.message }, 404);
        }
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "timelog-adjustment",
          fallbackMessage: "Failed to append adjustment",
          severity: "warn",
        });
      }
    }
  );

  // GET /timelogs/adjustments — read the namespace's ledger back, ts-ordered.
  // Used by the Undo control to pick a target. Optional startMs/endMs bounds.
  app.get(
    "/timelogs/adjustments",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-list-adjustments",
        domain: "telemetry",
        surface: "rest",
        description:
          "Read back the caller's namespace time-adjustment ledger in timestamp order.",
        whenToUse: "When the user reviews prior clock adjustments.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/timelogs/adjustments",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }
      const namespace = c.get("namespace");
      const startMsStr = c.req.query("startMs");
      const endMsStr = c.req.query("endMs");
      const startMs = startMsStr ? parseInt(startMsStr, 10) : undefined;
      const endMs = endMsStr ? parseInt(endMsStr, 10) : undefined;
      const adjustments = store.timelogAdjustments.getAdjustments({
        namespace,
        startMs: startMs !== undefined && !isNaN(startMs) ? startMs : undefined,
        endMs: endMs !== undefined && !isNaN(endMs) ? endMs : undefined,
      });
      return c.json({ adjustments });
    }
  );

  // GET /timelogs/derived — TS-derived daily buckets (R2). Bucketed by
  // per-namespace IANA-TZ local day (R6). Filter by the requested localDate
  // range after derivation (string compare on YYYY-MM-DD).
  app.get(
    "/timelogs/derived",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-derived",
        domain: "telemetry",
        surface: "rest",
        description:
          "Report time-per-day buckets derived from session turn timestamps for the caller's namespace.",
        whenToUse:
          "When the user wants activity-derived time buckets rather than clock time.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/timelogs/derived",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }
      const namespace = c.get("namespace");
      const startDate = c.req.query("startDate");
      const endDate = c.req.query("endDate");
      const cfg = await loadTimeLogConfig(resolveDataDir());

      // Widen epoch bounds ±1 day so TZ offsets near local-day boundaries don't
      // drop turns; the derivation re-buckets to local days, then we filter the
      // returned buckets by the requested localDate range below.
      // #2188 Task 7: these regexes were missing their backslashes
      // (/^d{4}-d{2}-d{2}$/ matches only a literal "dddd-dd-dd"), so a real date
      // NEVER matched, the bounds stayed undefined, and deriveDailyTimeLog
      // scanned full history on every request (perf-only — results were correct
      // via the localDate post-filter below).
      const startMs =
        startDate && DATE_ONLY_RE.test(startDate)
          ? Date.parse(`${startDate}T00:00:00Z`) - 86_400_000
          : undefined;
      const endMs =
        endDate && DATE_ONLY_RE.test(endDate)
          ? Date.parse(`${endDate}T23:59:59Z`) + 86_400_000
          : undefined;

      const deriveOpts = {
        defaultTimezone: cfg.timezone,
        // #4613: when a federation-global time-log timezone is in effect, make it
        // WIN over each namespace's stored midnight_reset_state row (the ms1 bug).
        federationTimezone: cfg.isFederation ? cfg.timezone : null,
        namespaces: [namespace],
        startMs,
        endMs,
      };
      const derived = store.deriveDailyTimeLog(deriveOpts);
      // Issue #1892 Task 3B (BD-2): attach the turns-derived per-session breakdown
      // to each bucket so the TimeLogModal can render a populated per-session/project
      // split post-cutover (the client falls back to the read-only archive for days
      // with no turns).
      const breakdownByBucket = store.deriveDailyBreakdown(deriveOpts);
      let buckets = Array.from(derived.entries()).map(([key, b]) => ({
        ...b,
        breakdown: breakdownByBucket.get(key) ?? [],
      }));
      if (startDate) buckets = buckets.filter(b => b.localDate >= startDate);
      if (endDate) buckets = buckets.filter(b => b.localDate <= endDate);
      buckets.sort((a, b) => a.localDate.localeCompare(b.localDate));
      // #4613: state the zone the day buckets were computed in (R5). `source`
      // tells the client whether it is the one federation-wide value or this
      // node's local fallback.
      return c.json({
        buckets,
        timezone: cfg.timezone,
        timezoneSource: cfg.isFederation ? "federation" : "local",
      });
    }
  );

  // GET /timelogs/cutover-status — single source of truth for the client's
  // dormancy gate (R1, R6). `ready` is unchanged (false until Sub-G's parity
  // green streak); #2188 V4 enriches the payload with per-metric streak /
  // lastGreen / daysToGate and the latest run's red buckets (sourced from the
  // recorded artifact via parity_runs.artifact_path — no per-request dir scan).
  app.get(
    "/timelogs/cutover-status",
    cataloged(
      defineCapability({
        id: "telemetry.timelogs-cutover-status",
        domain: "telemetry",
        surface: "rest",
        description:
          "Report whether the turn-derived time source has completed its soak-based cutover from the legacy clock.",
        whenToUse:
          "When the client decides which time-tracking source to display.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/timelogs/cutover-status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) {
        return store;
      }
      const status = await getTimelogSoakStatus(store, resolveDataDir());
      return c.json(status);
    }
  );

  return app;
}
