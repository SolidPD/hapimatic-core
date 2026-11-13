// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";

/**
 * Billable interval feed (issue #6586, R11): the node-to-node replication surface
 * for closed thinking intervals.
 *
 *   POST /api/federation/interval-feed (fed-token) — peer-incoming: returns this
 *        node's CLOSED intervals whose `change_seq` is above the caller's cursor,
 *        paged, with the ledger incarnation, this node's effective billable mode
 *        and the high-water mark over closed rows.
 *
 * A separate route, not a third array on the turn feed, so a malformed interval
 * row cannot poison a turn page (the turn puller drops a whole page on a parse
 * failure). POST because `NodeRegistry.readPeerRoute` issues only POST. The route
 * serves stored closed rows in every mode, so a node in `off` still serves the
 * rows closed before the switch. Reads are node-global within the mesh, like the
 * turn feed: each row keeps its `namespace`, and the namespace check is the
 * reader's (`/api/billable-time`). Support is advertised by the capability tag
 * `billable:interval-feed`, not by a status code.
 */
export function createFederationIntervalFeedRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/federation/interval-feed",
    cataloged(
      defineCapability({
        id: "telemetry.federation-interval-feed",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return this node's closed billable thinking intervals changed since the caller's cursor (the billable interval mirror feed).",
        whenToUse:
          "When a peer node's interval-mirror pull loop replicates this node's closed thinking intervals.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/interval-feed",
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
      // A missing, unparseable or non-object body (JSON `null` included) reads
      // as `{}`: the defaults, never a 500.
      const raw: unknown = await c.req.json().catch(() => null);
      const body: Record<string, unknown> =
        raw !== null && typeof raw === "object"
          ? (raw as Record<string, unknown>)
          : {};
      return c.json(
        engine.getIntervalFeedPage({
          cursor: typeof body.cursor === "number" ? body.cursor : undefined,
          limit: typeof body.limit === "number" ? body.limit : undefined,
        })
      );
    }
  );

  return app;
}
