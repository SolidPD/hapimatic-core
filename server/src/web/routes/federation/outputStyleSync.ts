// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";

import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";
import type { OutputStyleSyncOp } from "../../../services/outputStyleSyncService";

/**
 * Issue #2627 (Sub-Issue E) — custom output-style cross-node distribution.
 *
 * Two PEER-INCOMING (fed-token authed) endpoints:
 *
 *  - `POST /federation/output-style-sync` — Task 3 receiver. Applies a pushed
 *    op (a content upsert or a `{ deleted: true }` tombstone) to this node's
 *    `~/.claude/output-styles/` under last-write-wins. `updatedAt` is the
 *    ORIGINATING node's server-receipt time (propagated unchanged, never
 *    re-stamped) so LWW orders consistently across the mesh.
 *
 *  - `GET /federation/output-style-digest` — Task 3b reconcile backstop. Returns
 *    this node's LWW digest (with content) so a peer that was OFFLINE at push
 *    time converges on the next pull — both new files and tombstones.
 *
 * Node-global, like the claim-sync / recent-paths receivers: gated ONLY on the
 * federation token, no `checkCallerNamespace` (custom styles are host-scoped,
 * not per-namespace). Registered PRE-JWT inside `createFederationRoutes`
 * (`federation/index.ts`) because peers present a fed token, not a JWT — a
 * post-auth mount would 401 every push (expert-review R23).
 */
export function createOutputStyleSyncRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/federation/output-style-sync",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-output-style-sync",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Apply a pushed custom output-style op (content upsert or delete tombstone) to this node under last-write-wins so styles replicate across the mesh.",
        whenToUse:
          "When a peer pushes a custom output-style change for this node to converge on.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/output-style-sync",
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
      const svc = deps.getOutputStyleSyncService?.();
      if (!svc) {
        return c.json({ error: "Not connected" }, 503);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const op = (body ?? {}) as Partial<OutputStyleSyncOp>;
      if (
        typeof op.name !== "string" ||
        op.name.length === 0 ||
        typeof op.updatedAt !== "number"
      ) {
        return c.json(
          {
            error: "Invalid op",
            details:
              "name (non-empty string) and updatedAt (number) are required",
          },
          400
        );
      }

      const result = svc.applyRemote({
        name: op.name,
        content: typeof op.content === "string" ? op.content : undefined,
        deleted: op.deleted === true,
        updatedAt: op.updatedAt,
      });
      return c.json({ ok: true, applied: result.applied }, 200);
    }
  );

  app.get(
    "/federation/output-style-digest",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-output-style-digest",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return this node's last-write-wins output-style digest (with content) so a peer that was offline at push time converges on its next pull.",
        whenToUse:
          "When a peer reconciles custom output styles after missing a live push.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/output-style-digest",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getOutputStyleSyncService?.();
      if (!svc) {
        return c.json({ error: "Not connected" }, 503);
      }
      return c.json(svc.buildDigest(), 200);
    }
  );

  return app;
}
