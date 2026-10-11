// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import type { WebAppEnv } from "../middleware/auth";
import { logAndJson } from "./routeErrorHelper";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import {
  MaxConcurrencyPreferenceSchema,
  MAX_CONCURRENCY_DEFAULT,
} from "@hapi/protocol/schemas";
import { getDaemonCapacity } from "../../utils/daemonControlClient";
import {
  clampMaxConcurrency,
  readMaxConcurrency,
  writeMaxConcurrency,
} from "../../config/maxConcurrency";
import { createRateLimiter } from "../middleware/rateLimit";

/**
 * Per-machine spawn-capacity + settable-cap routes (issue #1805).
 *
 *   GET  /api/daemon/capacity                  — local spawn capacity (R2)
 *   GET  /api/nodes/:nodeId/max-concurrency    — a node's current cap (R6)
 *   POST /api/nodes/:nodeId/max-concurrency    — set a node's cap (R6/R7/R10/R11)
 *
 * Mirrors the per-node active-account pattern (`routes/nodes.ts`, #1452): a
 * remote `:nodeId` proxies through `NodeRegistry` to the owning node's
 * federation receiver; a local nodeId reads/writes this node's own settings.
 * Mounted under `/api` AFTER the JWT middleware in `server.ts` → JWT-gated.
 *
 * The local capacity read NEVER 500s on a down daemon — it returns a typed
 * `{ null, null }` (HTTP 200) so the meter renders "—" and does NOT block
 * spawning; the daemon's own gate stays the real enforcement (R5).
 */

// #4417: `tier` / `derived` are reported by the daemon (`sessionCapacity.ts`); the
// server adds `remote` / `unknown` for its own inference. A daemon-reported `capSource`
// always wins; `inferLocalSource` is only a FALLBACK for a pre-#4417 daemon.
type CapSource =
  | "env"
  | "settings"
  | "tier"
  | "derived"
  | "default"
  | "unknown"
  | "remote";

/**
 * Best-effort inference for a pre-#4417 daemon that does NOT report its own
 * `capSource`. It can only distinguish `env` / `settings` / `default` / `unknown` —
 * it CANNOT see the tier/derived layers (those are daemon-internal), which is exactly
 * why a reported `capSource` is preferred over this inference. Fixes the #4417 bug
 * where, once the default becomes tier/derived, an unconfigured node would be
 * mislabeled `env` and Preferences would falsely warn the control is a no-op.
 */
function inferLocalSource(
  persisted: number | undefined,
  effective: number | null
): CapSource {
  if (effective === null) return "unknown";
  if (persisted === undefined) {
    return effective === MAX_CONCURRENCY_DEFAULT ? "default" : "env";
  }
  // If the daemon's enforced cap matches the persisted value (clamped), the
  // setting is in effect; otherwise an env override is winning.
  return clampMaxConcurrency(persisted) === effective ? "settings" : "env";
}

export function createNodeCapacityRoutes(opts: {
  settingsFile: string;
  getLocalNodeId?: () => string | null;
  getNodeRegistry?: () => NodeRegistry | null;
  errorLogger?: ErrorLogger | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = opts.errorLogger ?? null;

  // True when federation is configured AND the request targets a remote node.
  // Non-federated instances (localNodeId === null) treat every request as local.
  const isRemoteNode = (nodeId: string): boolean => {
    const localNodeId = opts.getLocalNodeId?.() ?? null;
    return localNodeId !== null && nodeId !== localNodeId;
  };

  // Bucket-per-factory (mirrors /mcp-toggle, #1099). Fresh map per test stub.
  const setLimiter = createRateLimiter({ name: "node-max-concurrency" });

  // ─── GET /api/daemon/capacity — local meter source (R2/R5) ──────
  app.get(
    "/daemon/capacity",
    cataloged(
      defineCapability({
        id: "machine-daemon.daemon-capacity",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Report this node's local spawn capacity (effective session cap, live count, and free slots) from the daemon.",
        whenToUse:
          "When rendering the spawn-capacity meter for the local node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/daemon/capacity",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const capacity = await getDaemonCapacity();
      if ("error" in capacity) {
        // Unknown ≠ block. Typed null payload, HTTP 200 (R5).
        return c.json({
          effectiveCount: null,
          maxConcurrent: null,
          recommendedConcurrent: null,
          capSource: null,
        });
      }
      // #4417: carry the warn-at count + resolved source. Both optional on the wire —
      // a pre-#4417 daemon omits them and they surface as null (the meter shows no warn
      // threshold; fail-open).
      return c.json({
        effectiveCount: capacity.effectiveCount,
        maxConcurrent: capacity.maxConcurrent,
        recommendedConcurrent: capacity.recommendedConcurrent ?? null,
        capSource: capacity.capSource ?? null,
      });
    }
  );

  // ─── GET /api/nodes/:nodeId/max-concurrency — current cap (R6) ──
  app.get(
    "/nodes/:nodeId/max-concurrency",
    cataloged(
      defineCapability({
        id: "machine-daemon.node-max-concurrency-get",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Read a node's configured maximum concurrent-session cap, its recommended (warn-at) count, and which resolver layer (env, settings, tier, derived, or default) the node's daemon reports in effect.",
        whenToUse: "When displaying a node's session-cap setting.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/nodes/:nodeId/max-concurrency",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const nodeId = c.req.param("nodeId");

      if (isRemoteNode(nodeId)) {
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
        // Read from the already-polled /federation/info summary (no extra
        // round-trip). Fields are undefined for a stale peer → null.
        const summary = registry
          .getNodeSummaries()
          .find(n => n.nodeId === nodeId);
        if (!summary) {
          return c.json(
            { ok: false, error: "Unknown node", code: "node_not_found" },
            404
          );
        }
        // #4417: return the peer's own `capSource` when the summary carries it (a
        // pre-#4417 peer omits it → keep "remote" as the fallback), plus its warn-at
        // count for the remote meter.
        return c.json({
          value: summary.maxConcurrent ?? null,
          effective: summary.effectiveCount ?? null,
          recommended: summary.recommendedConcurrent ?? null,
          source: (summary.capSource ?? "remote") satisfies CapSource,
        });
      }

      try {
        const persisted = await readMaxConcurrency(opts.settingsFile);
        const capacity = await getDaemonCapacity();
        const hasCapacity = !("error" in capacity);
        const effective = hasCapacity ? capacity.maxConcurrent : null;
        const recommended = hasCapacity
          ? (capacity.recommendedConcurrent ?? null)
          : null;
        // #4417: prefer the daemon's OWN reported source — it alone can report the
        // tier/derived layers. `inferLocalSource` is only the fallback for a pre-#4417
        // daemon (and no longer mislabels a tier/derived default as `env`).
        const reportedSource = hasCapacity ? capacity.capSource : undefined;
        return c.json({
          value: persisted ?? null,
          effective,
          recommended,
          source: reportedSource ?? inferLocalSource(persisted, effective),
        });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "node-capacity",
          fallbackMessage: "Failed to read max-concurrency",
        });
      }
    }
  );

  // ─── POST /api/nodes/:nodeId/max-concurrency — set cap (R6/R7/R10/R11) ──
  app.post(
    "/nodes/:nodeId/max-concurrency",
    cataloged(
      defineCapability({
        id: "machine-daemon.node-max-concurrency-set",
        domain: "machine-daemon",
        surface: "rest",
        description:
          "Set a node's maximum concurrent-session cap, or clear it to automatic with a null value; proxied to the owning node when federated.",
        whenToUse: "When changing how many sessions a node may run at once.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/max-concurrency",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"value":8}',
      })
    ),
    setLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const body = await c.req.json().catch(() => null);
      const parsed = MaxConcurrencyPreferenceSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error:
              "Invalid body — value must be an integer within the allowed range, or null to clear the cap to automatic",
            code: "invalid_request",
          },
          400
        );
      }

      if (isRemoteNode(nodeId)) {
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
        const result = await registry.setMaxConcurrencyOnNode(
          nodeId,
          parsed.data.value
        );
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
        return c.json({ ok: true, value: parsed.data.value });
      }

      try {
        const persisted = await writeMaxConcurrency(
          opts.settingsFile,
          parsed.data.value
        );
        return c.json({ ok: true, value: persisted });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "node-capacity",
          fallbackMessage: "Failed to set max-concurrency",
        });
      }
    }
  );

  return app;
}
