// SPDX-License-Identifier: AGPL-3.0-only
// Web-client federation health routes (issue #1445, Task 9). JWT-gated.
//
// Four read endpoints backed by the HealthAggregator:
//   GET /federation/health/aggregate  — federation-wide worst-case status (R7)
//   GET /federation/health/nodes      — batch per-node view, no aggregation (#1632)
//   GET /federation/health/:nodeId     — one node's metrics + time-series (R8)
//   GET /federation/alerts             — paginated alerts feed (R9)
//
// ⚠️ Route-ordering hazard (directive §4 Task 9): Hono matches in registration
// order, so `/federation/health/aggregate` and `/federation/health/nodes` MUST
// be registered BEFORE `/federation/health/:nodeId` or "aggregate"/"nodes"
// would be captured as the `:nodeId` param. Defense-in-depth: the `:nodeId`
// handler also rejects both literals explicitly.
import { Hono } from "hono";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import type { FederationDeps } from "./shared";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../../capabilities/cataloged";

const HEALTH_DISABLED = { error: "Federation health not enabled" } as const;

function parseWindowMinutes(raw: string | undefined): number {
  if (!raw) return 30;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined; // ring buffer applies its default (50) + cap (200)
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function createFederationHealthRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);

  // ─── GET /federation/health/aggregate (JWT) — register BEFORE :nodeId ──
  app.get(
    "/federation/health/aggregate",
    cataloged(
      defineCapability({
        id: "federation.health-aggregate",
        domain: "federation",
        surface: "rest",
        description:
          "Report the federation-wide worst-case health status aggregated across all monitored nodes.",
        whenToUse: "When the user wants the overall health of the federation.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/health/aggregate",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    c => {
      const agg = deps.getHealthAggregator();
      if (!agg) return c.json(HEALTH_DISABLED, 503);
      return c.json(agg.getAggregate());
    }
  );

  // ─── GET /federation/health/nodes (JWT) — register BEFORE :nodeId ──
  app.get(
    "/federation/health/nodes",
    cataloged(
      defineCapability({
        id: "federation.health-nodes",
        domain: "federation",
        surface: "rest",
        description:
          "Report the current health metrics for every monitored node without aggregation, in a single call.",
        whenToUse: "When the user wants a per-node health snapshot.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/health/nodes",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    c => {
      const agg = deps.getHealthAggregator();
      if (!agg) return c.json(HEALTH_DISABLED, 503);
      return c.json(agg.getNodes());
    }
  );

  // ─── GET /federation/alerts (JWT) ──────────────────────────────
  app.get(
    "/federation/alerts",
    cataloged(
      defineCapability({
        id: "federation.alerts",
        domain: "federation",
        surface: "rest",
        description:
          "Return the paginated feed of federation health alerts, optionally filtered to a single node.",
        whenToUse: "When the user reviews recent federation health alerts.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/alerts",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    c => {
      const agg = deps.getHealthAggregator();
      if (!agg) return c.json(HEALTH_DISABLED, 503);
      const nodeId = c.req.query("nodeId");
      return c.json(
        agg.getAlerts({
          limit: parseLimit(c.req.query("limit")),
          cursor: c.req.query("cursor"),
          nodeId: nodeId && nodeId.length > 0 ? nodeId : undefined,
        })
      );
    }
  );

  // ─── GET /federation/health/:nodeId (JWT) — register AFTER aggregate ──
  app.get(
    "/federation/health/:nodeId",
    cataloged(
      defineCapability({
        id: "federation.health-node",
        domain: "federation",
        surface: "rest",
        description:
          "Return one node's current health metrics and recent time-series over a chosen window.",
        whenToUse: "When the user drills into a single node's health history.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/health/:nodeId",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    c => {
      const id = c.req.param("nodeId");
      // Defense-in-depth: never serve reserved path segments as node lookups
      // ("aggregate" — #1445; "nodes" — #1632).
      if (id === "aggregate" || id === "nodes") {
        return c.json({ error: `Unknown node: ${id}` }, 404);
      }
      const agg = deps.getHealthAggregator();
      if (!agg) return c.json(HEALTH_DISABLED, 503);
      const node = agg.getNode(
        id,
        parseWindowMinutes(c.req.query("windowMinutes"))
      );
      if (!node) {
        return c.json({ error: `Unknown node: ${id}` }, 404);
      }
      return c.json(node);
    }
  );

  return app;
}
