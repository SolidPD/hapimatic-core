// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { configuration } from "../../configuration";
import { getGlobalSessionsP95Ms } from "../../metrics/sessionsMetrics";
import { getSocketCounts } from "../../metrics/socketMetrics";
import { gatherSystemHealth } from "../../metrics/systemHealth";
import { createAuthMiddleware } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";

// The system-health metric-gathering logic was extracted to
// `../../metrics/systemHealth` (#1445) so the federation peer-metrics endpoint
// can share a single source of truth. Re-exported here for API stability —
// callers that imported the type from this module continue to work.
export type { SystemHealthMetrics } from "../../metrics/systemHealth";

/**
 * CLOSE_WAIT threshold (#1032) — once more than this many sockets are in
 * CLOSE_WAIT on the listen port, /api/health reports a `warn` status.
 * Derived from the evidence in issue #1032 where 122 CLOSE_WAIT sockets
 * coincided with /api/sessions degrading to 11-13s latency.
 */
const CLOSE_WAIT_WARN_THRESHOLD = 20;

/** Sessions p95 threshold (#1032). Above this, /api/health reports warn. */
const SESSIONS_P95_WARN_THRESHOLD_MS = 1000;

export interface HealthMetrics {
  sessionsP95Ms: number | null;
  closeWaitCount: number | null;
  listenPort: number;
}

export interface HealthResponse {
  status: "ok" | "warn";
  reasons: string[];
  metrics: HealthMetrics;
}

/**
 * Health check routes.
 *
 * - `/health` is the unauth liveness probe (used by deployment scripts and
 *   external monitoring) and intentionally remains public.
 * - `/system-health` returns host metadata (hostname, CPU, memory, disk)
 *   that should not be readable by unauthenticated callers (#1062 M-3).
 *   When `jwtSecret` is provided, JWT auth is enforced on that route only.
 */
export function createHealthRoutes(
  jwtSecret?: Uint8Array,
  errorLogger?: ErrorLogger | null
): Hono {
  const app = new Hono();

  // #1032: /api/health returns an operational-status summary. Backward
  // compatible with the old `{ status: "ok" }` top-level `/health` endpoint
  // — callers that only read `.status` continue to work unchanged.
  app.get("/health", async c => {
    const listenPort = configuration.webappPort;
    const [sessionsP95Ms, socketCounts] = await Promise.all([
      Promise.resolve(getGlobalSessionsP95Ms()),
      getSocketCounts(listenPort).catch(() => null),
    ]);
    const closeWaitCount = socketCounts?.closeWait ?? null;

    const reasons: string[] = [];
    if (
      sessionsP95Ms !== null &&
      sessionsP95Ms > SESSIONS_P95_WARN_THRESHOLD_MS
    ) {
      reasons.push(
        `/api/sessions p95 ${sessionsP95Ms.toFixed(0)}ms exceeds ${SESSIONS_P95_WARN_THRESHOLD_MS}ms threshold`
      );
    }
    if (closeWaitCount !== null && closeWaitCount > CLOSE_WAIT_WARN_THRESHOLD) {
      reasons.push(
        `CLOSE_WAIT socket count ${closeWaitCount} exceeds ${CLOSE_WAIT_WARN_THRESHOLD} threshold`
      );
    }

    const response: HealthResponse = {
      status: reasons.length === 0 ? "ok" : "warn",
      reasons,
      metrics: {
        sessionsP95Ms,
        closeWaitCount,
        listenPort,
      },
    };
    return c.json(response);
  });

  // #1062 M-3: /system-health returns hostname, CPU, memory, and disk metrics
  // that should not be exposed to unauthenticated callers. The only legitimate
  // consumer (web SystemHealthModal) already sends a Bearer token, so adding
  // JWT auth here is a defense-in-depth hardening with no UX cost.
  // Mounted BEFORE the global /api/* JWT middleware, so we apply auth inline
  // for this specific route.
  if (jwtSecret) {
    app.use("/system-health", createAuthMiddleware(jwtSecret, errorLogger));
  }
  app.get(
    "/system-health",
    cataloged(
      defineCapability({
        id: "telemetry.system-health",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return host operational metrics (hostname, CPU, memory, disk) for this node; JWT-gated (not readable unauthenticated).",
        whenToUse: "When the operator views node system health.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/system-health",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      // #1445: gathering logic lives in metrics/systemHealth — same object shape.
      return c.json(await gatherSystemHealth());
    }
  );

  return app;
}
