// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";

import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";

/**
 * Epic #1965 (File Conflict Monitor) Sub D / #1969 — federation-wide claim sync,
 * anti-entropy backstop (R4).
 *
 * `GET /federation/claims` — returns THIS node's live-claim snapshot (the same
 * #1968-liveness-filtered, version-stamped `FileClaimSyncSnapshot` the SSE-bridge
 * fast path publishes, built by `SyncEngine.buildFileClaimSnapshot()`). A peer's
 * `NodeRegistry` poll fetches this every ~15 s and merges it, reconciling any
 * delta dropped during a bridge disconnect — WITHOUT replacing the existing
 * session-list poll (Fallback-Preservation Rule).
 *
 * Node-global: claims are cross-session by design (like the recent-paths /
 * active-account receivers), so this gates ONLY on the federation token and does
 * NOT apply `checkCallerNamespace`. Mirrors `events.ts`'s fed-token gate + the
 * `getSyncEngine()` null-guard (503).
 */
export function createFederationClaimSyncRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/federation/claims",
    cataloged(
      defineCapability({
        id: "files-git.federation-claims",
        domain: "files-git",
        surface: "rest",
        description:
          "Return this node's live file-claim snapshot (which session holds which path) so a peer's poll reconciles claims dropped during a bridge disconnect.",
        whenToUse:
          "When a peer's file-conflict monitor polls this node to reconcile its cross-node claim view.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/claims",
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
      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }
      return c.json(engine.buildFileClaimSnapshot(), 200);
    }
  );

  return app;
}
