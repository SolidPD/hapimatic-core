// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { Store } from "../../store";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogFilters } from "../../store/types";
import { cataloged } from "../../capabilities/cataloged";

export function createErrorLogRoutes(store: Store): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/error-logs",
    cataloged(
      defineCapability({
        id: "telemetry.list-error-logs",
        domain: "telemetry",
        surface: "rest",
        description:
          "List persisted error-log entries (secrets scrubbed) with filters for severity, category, source, session, and time range.",
        whenToUse:
          "When reviewing recent server/client errors in the diagnostics panel.",
        invocation: { kind: "rest", method: "GET", path: "/api/error-logs" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    c => {
      const url = new URL(c.req.url);

      const filters: ErrorLogFilters = {};

      const severity = url.searchParams.get("severity");
      if (severity) {
        filters.severity = severity as ErrorLogFilters["severity"];
      }

      const category = url.searchParams.get("category");
      if (category) {
        filters.category = category;
      }

      const source = url.searchParams.get("source");
      if (source) {
        filters.source = source as ErrorLogFilters["source"];
      }

      const sessionId = url.searchParams.get("sessionId");
      if (sessionId) {
        filters.sessionId = sessionId;
      }

      const startTime = url.searchParams.get("startTime");
      if (startTime) {
        const parsed = Number(startTime);
        if (!Number.isNaN(parsed)) {
          filters.startTime = parsed;
        }
      }

      const endTime = url.searchParams.get("endTime");
      if (endTime) {
        const parsed = Number(endTime);
        if (!Number.isNaN(parsed)) {
          filters.endTime = parsed;
        }
      }

      const limit = url.searchParams.get("limit");
      if (limit) {
        const parsed = Number(limit);
        if (!Number.isNaN(parsed) && parsed > 0) {
          filters.limit = Math.min(parsed, 500);
        }
      } else {
        filters.limit = 100;
      }

      const offset = url.searchParams.get("offset");
      if (offset) {
        const parsed = Number(offset);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          filters.offset = parsed;
        }
      }

      const entries = store.errorLogs.getEntries(filters);
      return c.json({ entries, count: entries.length });
    }
  );

  app.get(
    "/error-logs/stats",
    cataloged(
      defineCapability({
        id: "telemetry.error-log-stats",
        domain: "telemetry",
        surface: "rest",
        description: "Return aggregate error-log counts grouped by severity.",
        whenToUse:
          "When showing an error-rate summary in the diagnostics panel.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/error-logs/stats",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    c => {
      const bySeverity = store.errorLogs.countBySeverity();
      return c.json({ bySeverity });
    }
  );

  app.delete(
    "/error-logs/:id",
    cataloged(
      defineCapability({
        id: "telemetry.delete-error-log",
        domain: "telemetry",
        surface: "rest",
        description: "Delete a single error-log entry by id.",
        whenToUse: "When dismissing a specific error-log entry.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/error-logs/:id",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    c => {
      const id = c.req.param("id");
      const deleted = store.errorLogs.deleteEntry(id);
      if (!deleted) {
        return c.json({ error: "Not found" }, 404);
      }
      return c.json({ ok: true });
    }
  );

  return app;
}
