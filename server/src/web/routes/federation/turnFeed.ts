// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";

/**
 * Turn-ledger mirror feed (issue #4614) — the node-to-node replication surface.
 *
 *   POST /api/federation/turn-feed         (fed-token) — peer-incoming: returns
 *        THIS node's FINALIZED turns + timelog_adjustments changed since the
 *        caller's cursors, paged, plus the ledger incarnation + high-water marks.
 *   POST /api/federation/turn-feed/digest  (fed-token) — peer-incoming: returns
 *        a per-day (count, checksum) digest for silent-drift detection (R10).
 *   GET  /api/federation/turn-mirror/status (JWT)     — this node's per-origin
 *        mirror sync status (last sync, cursor, lag) for the status read (R6).
 *
 * POST (not GET) for the receivers because `NodeRegistry.proxyToNode` only issues
 * POST (same convention as the telemetry turn-aggregates receiver). Reads are
 * node-global within the mesh — the fed-token IS the operator's-own-federation
 * boundary (R8); each turn row still carries its `namespace`, preserved into the
 * mirror. Mirrors the `telemetry.ts` receiver structure verbatim.
 */
export function createFederationTurnFeedRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);

  // ─── Peer-incoming feed: POST /federation/turn-feed (fed-token) ──
  app.post(
    "/federation/turn-feed",
    cataloged(
      defineCapability({
        id: "telemetry.federation-turn-feed",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return this node's finalized turns + timelog_adjustments changed since the caller's cursors (the turn-ledger mirror feed).",
        whenToUse:
          "When a peer node's turn-mirror pull loop replicates this node's finalized turns.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/turn-feed",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (!deps.federationConfig) {
        return c.json({ error: "Federation not enabled" }, 503);
      }
      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      return c.json(
        engine.getTurnFeedPage({
          cursor: typeof body.cursor === "number" ? body.cursor : undefined,
          adjCursor:
            typeof body.adjCursor === "number" ? body.adjCursor : undefined,
          limit: typeof body.limit === "number" ? body.limit : undefined,
        })
      );
    }
  );

  // ─── Peer-incoming drift digest: POST /federation/turn-feed/digest (fed-token) ──
  app.post(
    "/federation/turn-feed/digest",
    cataloged(
      defineCapability({
        id: "telemetry.federation-turn-feed-digest",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return a per-day (count, checksum) digest of this node's finalized turns for mirror silent-drift detection.",
        whenToUse:
          "When a peer compares its mirror of this node against the origin to detect silent drift.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/turn-feed/digest",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      if (!deps.federationConfig) {
        return c.json({ error: "Federation not enabled" }, 503);
      }
      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }
      return c.json(engine.getTurnFeedDigest());
    }
  );

  // ─── Status read: GET /federation/turn-mirror/status (JWT) ──
  app.get(
    "/federation/turn-mirror/status",
    cataloged(
      defineCapability({
        id: "telemetry.turn-mirror-status",
        domain: "telemetry",
        surface: "rest",
        description:
          "This node's per-origin turn-mirror sync status: last sync time, cursor, and lag.",
        whenToUse:
          "When an operator inspects how current each origin's turn mirror is on this node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/turn-mirror/status",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    c => {
      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }
      return c.json({ origins: engine.getTurnMirrorStatus() });
    }
  );

  return app;
}
