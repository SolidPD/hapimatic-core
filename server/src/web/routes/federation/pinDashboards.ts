// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";

import { cataloged } from "../../../capabilities/cataloged";
import { resolveLocalNodeIdentity } from "../../../config/nodeLabel";
import {
  engineDashboardDeps,
  listLocalDashboards,
} from "../../../sync/pinDashboards";
import type { WebAppEnv } from "../../middleware/auth";
import { pinsGate } from "../../middleware/pinsGate";
import { withPinErrors } from "../pinRouteHelpers";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Peer-incoming Project Manager dashboards (issue #6454, epic #6446): this node's
 * half of the hub's `GET /api/pins/dashboards` fan-out. It answers this node's
 * own dashboards only and never fans out further (server/CLAUDE.md "SessionService
 * Audience Boundary"), so a request cannot loop and a dashboard is never listed
 * twice.
 *
 * Checks, in order, before anything is read: the Pins gate (a closed or older
 * node reads to the hub as "does not support pins"), the federation token (401),
 * the engine (503), then the STRICT caller namespace (absent → 404), which a
 * receiver added after #6224 must use. POST because the hub's peer read only
 * POSTs.
 */
export function createFederationPinDashboardRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = pinsGate(deps.pinsEnabled === true);
  const errors = deps.errorLogger ?? null;

  app.post(
    "/federation/pins/dashboards",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-pin-dashboards",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return this node's Project Manager dashboard pins in the caller's namespace, with the facts of the sessions their lanes name (POST because the node proxy only issues POST).",
        whenToUse:
          "When the hub gathers Project Manager dashboards from a peer node for the Pins tab.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/pins/dashboards",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pin-dashboards", () => {
        if (!checkFederationToken(deps, c.req.header("authorization"))) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        const engine = deps.getSyncEngine();
        if (!engine) {
          return c.json({ error: "Not connected" }, 503);
        }
        const namespace = c.req.header("x-hapi-caller-namespace");
        if (!namespace) {
          return c.json({ error: "Not found" }, 404);
        }
        return c.json(
          listLocalDashboards(
            engineDashboardDeps(
              engine,
              resolveLocalNodeIdentity(deps.federationConfig)
            ),
            namespace
          )
        );
      })
  );

  return app;
}
