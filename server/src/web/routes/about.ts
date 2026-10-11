// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { WebAppEnv } from "../middleware/auth";
import { logAndJson } from "./routeErrorHelper";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { gatherAboutInfo } from "../../metrics/aboutInfo";

/**
 * About-page host-info + harness-enumeration route (issue #1984, epic #1981).
 *
 *   GET /api/about[?nodeId=<id>] — static host identity, hardware, uptime,
 *   Tailscale identity, and the harness enumeration. The B2 (#1983) Admin Drawer
 *   About page consumes this.
 *
 * Auth (R2): mounted under `/api` AFTER the global JWT middleware in `server.ts`
 * (KD-2 — the after-JWT block, where `nodes.ts`/`sessions.ts` live, is the only
 * block with `getNodeRegistry`/`getLocalNodeId` for the `?nodeId=` proxy). An
 * unauthenticated request is rejected by that middleware before reaching here.
 *
 * Federation (R6): when `?nodeId=` names a DIFFERENT node, proxy to it via
 * `NodeRegistry.getAboutForNode` (→ `proxyToNode` → the peer receiver
 * `POST /federation/about` in `federation/infrastructure.ts`). Only the nodeId
 * crosses the boundary; the owning node gathers its OWN About. A non-federated
 * instance (`getLocalNodeId()` returns null) treats every nodeId as local.
 * Returns the bare `AboutInfo` for both local and proxied paths so B2 consumes
 * one shape.
 */
export function createAboutRoutes(opts: {
  getNodeRegistry?: () => NodeRegistry | null;
  getLocalNodeId?: () => string | null;
  errorLogger?: ErrorLogger | null;
  // #3119: per-request read of the backup-key eligibility signal
  // (`configuration.googleOAuthEnabled` at the server.ts mount). Threaded into
  // the LOCAL gather only; the federation proxy branch returns the remote node's
  // own About (ruling D3(A)). Absent ⇒ `false`.
  getBackupKeyEligible?: () => boolean;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = opts.errorLogger ?? null;

  // True when federation is configured AND the request targets a remote node.
  // Non-federated instances (localNodeId === null) treat every request as local.
  const isRemoteNode = (nodeId: string): boolean => {
    const localNodeId = opts.getLocalNodeId?.() ?? null;
    return localNodeId !== null && nodeId !== localNodeId;
  };

  app.get(
    "/about",
    cataloged(
      defineCapability({
        id: "harness-admin.about",
        domain: "harness-admin",
        surface: "rest",
        description: "Return this node's about/build metadata for the UI.",
        whenToUse: "When the user opens the About panel.",
        invocation: { kind: "rest", method: "GET", path: "/api/about" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const nodeId = c.req.query("nodeId");

      if (nodeId && isRemoteNode(nodeId)) {
        const registry = opts.getNodeRegistry?.() ?? null;
        if (!registry) {
          return c.json(
            {
              ok: false,
              error: "Federation not enabled",
              code: "federation_not_enabled",
            },
            503
          );
        }
        const result = await registry.getAboutForNode(nodeId);
        if (result.type === "error") {
          return c.json(
            {
              ok: false,
              error: result.message,
              code: "federation_proxy_error",
            },
            502
          );
        }
        return c.json(result.about);
      }

      try {
        return c.json(
          await gatherAboutInfo({
            backupKeyEligible: opts.getBackupKeyEligible?.() ?? false,
          })
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "about",
          fallbackMessage: "Failed to gather about info",
        });
      }
    }
  );

  return app;
}
