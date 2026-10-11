// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { MaxConcurrencyPreferenceSchema } from "@hapi/protocol/schemas";
import { cataloged } from "../../../capabilities/cataloged";
import { checkFederationToken, type FederationDeps } from "./shared";
import { configuration } from "../../../configuration";
import { writeMaxConcurrency } from "../../../config/maxConcurrency";

/**
 * Node-to-node max-concurrency receiver (issue #1805, R11).
 *
 *   POST /api/federation/max-concurrency — set THIS node's spawn cap
 *
 * Peer-incoming endpoint: the hub's per-node client route
 * (`POST /api/nodes/:nodeId/max-concurrency` in routes/nodeCapacity.ts) proxies
 * here via `NodeRegistry.setMaxConcurrencyOnNode` → `proxyToNode`. Gated by the
 * federation token only (peer-to-peer); resolves + persists against THIS node's
 * OWN settings.json — only the numeric cap crosses the boundary, never a token
 * (mirrors the active-account receiver pattern, #1452 / KD-1). The READ side
 * reuses the polled `/federation/info` `maxConcurrent`, so there is no separate
 * GET receiver for v1.
 *
 * The cap is node-global (not per-namespace), so — like the active-account /
 * recent-paths receivers — this does NOT call `checkCallerNamespace` (#1097).
 */
export function createFederationCapacityRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/federation/max-concurrency",
    cataloged(
      defineCapability({
        id: "machine-daemon.federation-max-concurrency",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Set this federation node's maximum concurrent-session spawn cap (or clear it to automatic with a null value), persisting it to the node's own settings; the daemon clamps it at the next spawn.",
        whenToUse:
          "When the hub changes a specific node's spawn-capacity limit through the node proxy.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/max-concurrency",
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

      const body = await c.req.json().catch(() => null);
      const parsed = MaxConcurrencyPreferenceSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { type: "error", error: "Invalid body", code: "invalid_request" },
          400
        );
      }

      try {
        // Persist against THIS node's own settings (the cap is resolved + clamped
        // by this node's daemon at the next spawn — R7/R9).
        const persisted = await writeMaxConcurrency(
          configuration.settingsFile,
          parsed.data.value
        );
        return c.json({ type: "success", value: persisted });
      } catch (err) {
        return c.json(
          {
            type: "error",
            error: err instanceof Error ? err.message : "Failed to persist cap",
            code: "persist_failed",
          },
          500
        );
      }
    }
  );

  return app;
}
