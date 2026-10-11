// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";

import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";
import { FederationSettingsSyncSchema } from "@hapi/protocol/schemas";

/**
 * Issue #2624 (Sub-Issue B) — federation-global settings replication.
 *
 * Two PEER-INCOMING (fed-token authed) endpoints, structurally mirroring E's
 * output-style-sync receiver (#2627):
 *
 *  - `POST /federation/settings-sync` — Task 5 receiver. LWW-applies a pushed
 *    `{ key → { value, updatedAt, originNodeId? } }` digest to this node's stored
 *    federation-global values. Only keys/values cross the wire (KD-6).
 *
 *  - `GET /federation/settings-digest` — Task 9 reconcile backstop. Returns this
 *    node's global digest so a peer that was OFFLINE at push time converges on
 *    its next poll pull.
 *
 * Node-global, like the active-account / output-style receivers: gated ONLY on
 * the federation token, no `checkCallerNamespace` (settings are host-scoped, not
 * per-namespace — KD-5). Registered PRE-JWT inside `createFederationRoutes`
 * (`federation/index.ts`) because peers present a fed token, not a JWT — a
 * post-auth mount would 401 every push.
 */
export function createSettingsSyncReceiverRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/federation/settings-sync",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-settings-sync",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Last-write-wins apply a pushed federation-global settings digest to this node's stored values; only keys and values cross the wire.",
        whenToUse:
          "When a peer pushes a federation-global settings change for this node to converge on.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/settings-sync",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getSettingsSyncService?.();
      if (!svc) {
        return c.json({ error: "Not connected" }, 503);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = FederationSettingsSyncSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid settings-sync body", details: parsed.error.issues },
          400
        );
      }

      const { changed } = await svc.applyRemote(parsed.data.values);
      return c.json({ ok: true, changed }, 200);
    }
  );

  app.get(
    "/federation/settings-digest",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-settings-digest",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return this node's federation-global settings digest so a peer that was offline at push time converges on its next pull.",
        whenToUse:
          "When a peer reconciles federation-global settings after missing a live push.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/settings-digest",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getSettingsSyncService?.();
      if (!svc) {
        return c.json({ error: "Not connected" }, 503);
      }
      return c.json(await svc.buildDigest(), 200);
    }
  );

  return app;
}
