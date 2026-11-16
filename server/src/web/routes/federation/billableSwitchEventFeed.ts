// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";

import { cataloged } from "../../../capabilities/cataloged";
import type { WebAppEnv } from "../../middleware/auth";
import { billableSwitchGate } from "../../middleware/billableSwitchGate";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * The billable switch event feed (issue #6646, Task 7b, ruling Q10 (a)): the
 * node-to-node replication surface of the record, on the turn feed's pattern
 * (`turnFeed.ts`). A puller on another node asks for the rows after its cursor
 * and copies them, whole, into its `billable_switch_events_mirror`, so the record
 * of a switch-off outlives the session and the node.
 *
 * POST because the registry's node-scoped reader issues only POST. Behind the
 * gate, so it is served in `on` and `closed` and is a bare 404 in `off`. The feed
 * is node-global within the mesh like the turn feed: each row keeps its
 * `namespace`, and the namespace check is the reader's.
 */
export function createBillableSwitchEventFeedRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const mode = deps.getSyncEngine()?.getBillableSwitchMode?.() ?? "off";

  app.post(
    "/federation/billable-switch/event-feed",
    cataloged(
      defineCapability({
        id: "session-lifecycle.federation-billable-switch-event-feed",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Return this node's billable switch events after the caller's cursor, whole, with the database's incarnation and highest event id (the record's replication feed).",
        whenToUse:
          "When another node's pull loop copies this node's billable switch record.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/billable-switch/event-feed",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    billableSwitchGate(mode),
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
      > | null;
      return c.json(
        engine.getBillableSwitchEventFeedPage({
          cursor: typeof body?.cursor === "number" ? body.cursor : undefined,
          limit: typeof body?.limit === "number" ? body.limit : undefined,
        })
      );
    }
  );

  return app;
}
