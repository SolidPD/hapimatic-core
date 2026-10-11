// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { Store } from "../../store";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import { cataloged } from "../../capabilities/cataloged";
import { scrubString } from "../../sentry";

const errorReportSchema = z.object({
  message: z.string().min(1).max(2000),
  stack: z.string().max(5000).nullish(),
  category: z.string().min(1).max(100),
  source: z.enum(["client", "cli"]),
  severity: z
    .enum(["debug", "info", "warn", "error", "fatal"])
    .default("error"),
  sessionId: z.string().max(200).nullish(),
  context: z.string().max(2000).nullish(),
  userAgent: z.string().max(500).nullish(),
  requestPath: z.string().max(500).nullish(),
  requestMethod: z.string().max(10).nullish(),
  statusCode: z.number().int().min(0).max(999).nullish(),
  // Issue #1244 finding #4: replayed reports include the client-side
  // enqueuedAt as a separate fact from `timestamp` (= server INSERT time).
  // Live POSTs are self-stamping and omit this field. No upper bound — even
  // a clock-skewed value is useful diagnostic data.
  originalTimestamp: z.number().int().min(0).nullish(),
});

export function createErrorReportRoutes(store: Store): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // Existing endpoint preserves its prior 10 req/60s behavior; the new
  // /cli/error-reports and /api/sessions/:id/mcp-toggle limiters use the
  // module default (100/60s).
  const limiter = createRateLimiter({ name: "error-reports", limit: 10 });

  app.post(
    "/error-reports",
    cataloged(
      defineCapability({
        id: "telemetry.report-error",
        domain: "telemetry",
        surface: "rest",
        description:
          "Submit a client- or CLI-originated error report; the entry is scrubbed of secrets and persisted to the error-log store.",
        whenToUse:
          "When a client reports a runtime error for diagnostics (rate-limited).",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/error-reports",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    async c => {
      const namespace = c.get("namespace");

      const json = await c.req.json().catch(() => null);
      const parsed = errorReportSchema.safeParse(json);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      }

      const data = parsed.data;

      // #1062 M-5: Scrub bearer tokens, JWTs, and `?token=` query params from
      // free-text fields before persisting to the error_logs DB. Stack frames
      // commonly contain interpolated function args (e.g. `authenticate(<JWT>)`),
      // and request URLs in `requestPath` may include `?token=` from earlier
      // legitimate WS/SSE auth flows. The scrubber is the same one used by the
      // Sentry beforeSend hook — see `scrubString` in `server/src/sentry.ts`.
      // When #1058 ships, this falls through to the comprehensive scrubber.
      const entry = store.errorLogs.createEntry({
        severity: data.severity,
        category: scrubString(data.category),
        source: data.source,
        message: scrubString(data.message),
        stack: data.stack ? scrubString(data.stack) : null,
        sessionId: data.sessionId ?? null,
        namespace,
        context: data.context ? scrubString(data.context) : null,
        userAgent: data.userAgent ?? c.req.header("user-agent") ?? null,
        requestPath: data.requestPath ? scrubString(data.requestPath) : null,
        requestMethod: data.requestMethod ?? null,
        statusCode: data.statusCode ?? null,
        // No scrub — integer timestamp can't carry tokens. See finding #4.
        originalTimestamp: data.originalTimestamp ?? null,
      });

      return c.json({ id: entry.id }, 201);
    }
  );

  return app;
}
