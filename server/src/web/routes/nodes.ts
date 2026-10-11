// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import {
  LOCAL_NODE_ID,
  defineCapability,
  ProviderIdSchema,
} from "@hapi/protocol";
import type { WebAppEnv } from "../middleware/auth";
import { logAndJson } from "./routeErrorHelper";
import { cataloged } from "../../capabilities/cataloged";
import { createRateLimiter } from "../middleware/rateLimit";
import type { AccountService } from "../../services/accountService";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { UsageService } from "../../accounts/usageService";
import type { ErrorLogger } from "../../logging/errorLogger";

const setActiveAccountSchema = z.object({
  accountUuid: z.string().uuid(),
  // #3808 Task 4b: optional provider — set the node's PER-PROVIDER default
  // (absent ⇒ the Anthropic pointer, byte-identical to today).
  provider: ProviderIdSchema.optional(),
});

/**
 * Per-node active-account HTTP routes (issue #1451, Sub-Issue E of epic #1446).
 *
 *   GET  /api/nodes/:nodeId/active-account — redacted active account, or null (R8)
 *   POST /api/nodes/:nodeId/active-account — set the node's active account (R7)
 *
 * E implemented LOCAL behavior; Sub-Issue F (#1452) added the cross-node proxy.
 * When federation is configured and `:nodeId` refers to a DIFFERENT node than
 * this one, the route proxies to the owning node via
 * `NodeRegistry.{get,set}ActiveAccountOnNode` (→ `proxyToNode` → the peer
 * receivers in `federation/accounts.ts`). Only `accountUuid` crosses the
 * federation boundary — never tokens (R4); the owning node resolves the token
 * from its OWN AccountStore. A non-federated instance (`getLocalNodeId()`
 * returns null) treats every nodeId as local.
 *
 * Mounted under `/api` AFTER the JWT auth middleware in `server.ts` (R9). The
 * active account is returned redacted — token values never appear (R11).
 */
export function createNodesRoutes(opts: {
  getAccountService: () => AccountService | null;
  getLocalNodeId?: () => string | null;
  getNodeRegistry?: () => NodeRegistry | null;
  // Issue #2054: usage TTL snapshot buster for the local-branch account removal
  // (mirrors createAccountsRoutes). The remote branch needs no clear — the peer
  // receiver clears its own node's snapshot [expert-review 2026-07-02, ruling D1].
  getUsageService?: () => UsageService | null;
  federationApiToken?: string | null;
  errorLogger?: ErrorLogger | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = opts.errorLogger ?? null;
  // Instantiated inside the factory so each createNodesRoutes() call (incl. tests)
  // gets a fresh bucket map (mirrors the accounts-delete limiter, #1099).
  const deleteLimiter = createRateLimiter({ name: "nodes-account-delete" });

  // True when federation is configured AND the request targets a remote node.
  // Non-federated instances (localNodeId === null) treat every request as local.
  const isRemoteNode = (nodeId: string): boolean => {
    const localNodeId = opts.getLocalNodeId?.() ?? null;
    return localNodeId !== null && nodeId !== localNodeId;
  };
  /** Epic #3285 round 15: the web client addresses "this node" as the
   *  LOCAL_NODE_ID sentinel ("local"). On a FEDERATED instance that string is
   *  not the hub's own nodeId, so bare isRemoteNode() proxied it to a peer
   *  named "local" → 502 federation_proxy_error (reproduced on prod:
   *  GET /api/nodes/local/active-account). Every dispatcher branches on THIS —
   *  the sentinel is served locally exactly like the hub's real id (the same
   *  fix systemJobs.ts carries). */
  const isLocalRequest = (nodeId: string): boolean =>
    nodeId === LOCAL_NODE_ID || !isRemoteNode(nodeId);

  // #3456: force an immediate federation poll of ALL nodes, bypassing per-node
  // backoff, and return the status diff (newly-online / still-offline). Serves
  // the Create-page "Refresh federation" button. Every node runs its own
  // NodeRegistry, so this force-polls the registry of whichever node serves the
  // page — no federation proxying needed. Mounted under `/api` AFTER the JWT
  // middleware (server.ts), so it inherits the auth gate; a static 2-segment
  // path that does not collide with `/nodes/:nodeId/active-account` (3-segment).
  app.post(
    "/nodes/poll",
    cataloged(
      defineCapability({
        id: "federation.node-poll",
        domain: "federation",
        surface: "rest",
        description:
          "Force an immediate federation poll of every known node, bypassing per-node backoff, and return the online/offline status diff.",
        whenToUse: "When the user refreshes the federation node list.",
        invocation: { kind: "rest", method: "POST", path: "/api/nodes/poll" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
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
      try {
        const result = await registry.forcePoll();
        return c.json(result);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "nodes",
          fallbackMessage: "Failed to force-poll federation",
        });
      }
    }
  );

  app.get(
    "/nodes/:nodeId/active-account",
    cataloged(
      defineCapability({
        id: "federation.node-active-account-get",
        domain: "federation",
        surface: "rest",
        description:
          "Read a node's currently active (default) account, redacted, or null when none is set.",
        whenToUse: "When showing which account a node spawns sessions under.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/nodes/:nodeId/active-account",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const nodeId = c.req.param("nodeId");
      // #3808 Task 4b: optional `provider` query → read the per-provider node
      // default (absent ⇒ the Anthropic pointer, today's behaviour).
      const providerQuery = ProviderIdSchema.safeParse(c.req.query("provider"));
      const provider = providerQuery.success ? providerQuery.data : undefined;
      if (!isLocalRequest(nodeId)) {
        // Sub-Issue F (#1452): proxy to the owning node via NodeRegistry.
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
        const result = await registry.getActiveAccountOnNode(nodeId, provider);
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
        return c.json({ activeAccount: result.account });
      }
      const service = opts.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      try {
        return c.json({ activeAccount: service.getActiveAccount(provider) });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "nodes",
          fallbackMessage: "Failed to read active account",
        });
      }
    }
  );

  app.post(
    "/nodes/:nodeId/active-account",
    cataloged(
      defineCapability({
        id: "federation.node-active-account-set",
        domain: "federation",
        surface: "rest",
        description:
          "Set a node's active (default) account by account UUID; proxied to the owning node when federated.",
        whenToUse:
          "When changing the default account a node uses for new sessions.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/nodes/:nodeId/active-account",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"accountUuid":"0341af7d-269a-4283-95d6-344a93bd0504"}',
      })
    ),
    async c => {
      const nodeId = c.req.param("nodeId");
      if (!isLocalRequest(nodeId)) {
        // Sub-Issue F (#1452): proxy to the owning node via NodeRegistry.
        const body = await c.req.json().catch(() => null);
        const parsed = setActiveAccountSchema.safeParse(body);
        if (!parsed.success) {
          return c.json(
            { ok: false, error: "Invalid body", code: "invalid_request" },
            400
          );
        }
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
        const result = await registry.setActiveAccountOnNode(
          nodeId,
          parsed.data.accountUuid,
          parsed.data.provider
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
        return c.json({ ok: true });
      }
      const body = await c.req.json().catch(() => null);
      const parsed = setActiveAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const service = opts.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      try {
        const result = service.setActiveAccount(
          parsed.data.accountUuid,
          parsed.data.provider
        );
        if (result.ok) {
          return c.json({ ok: true });
        }
        return c.json(
          { ok: false, error: "Account not found", code: "account_not_found" },
          404
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "nodes",
          fallbackMessage: "Failed to set active account",
        });
      }
    }
  );

  // ─── Per-node account removal: DELETE /nodes/:nodeId/accounts/:uuid (issue #2054) ──
  // Federation-aware credential removal (R7). Remote node → proxy via
  // NodeRegistry.removeAccountOnNode (structured-error idiom, D2/D5) → the peer
  // receiver's own AccountService.delete (only accountUuid crosses the boundary).
  // Local node → service.delete directly, mirroring DELETE /api/accounts/:uuid's
  // 409 last_account / 404 not_found mapping, then bust the usage snapshot (D1).
  app.delete(
    "/nodes/:nodeId/accounts/:uuid",
    cataloged(
      defineCapability({
        id: "federation.node-account-remove",
        domain: "federation",
        surface: "rest",
        description:
          "Remove a stored account from a node; refuses with 409 when it is the node's only account.",
        whenToUse: "When deleting an account from a node.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/nodes/:nodeId/accounts/:uuid",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    deleteLimiter,
    async c => {
      const nodeId = c.req.param("nodeId");
      const uuid = c.req.param("uuid");
      if (!isLocalRequest(nodeId)) {
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
        const result = await registry.removeAccountOnNode(nodeId, uuid);
        if (result.type === "error") {
          // D2/D5: map the receiver's structured code to the right HTTP status;
          // code-less transport failures fall through to 502.
          if (result.code === "last_account") {
            return c.json(
              {
                ok: false,
                error: "Cannot delete the only stored account",
                code: "last_account",
              },
              409
            );
          }
          if (result.code === "account_not_found") {
            return c.json(
              { ok: false, error: "Account not found", code: "not_found" },
              404
            );
          }
          return c.json(
            {
              ok: false,
              error: result.message,
              code: "federation_proxy_error",
            },
            502
          );
        }
        return c.json({ ok: true });
      }
      const service = opts.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      try {
        const result = service.delete(uuid);
        if (result.ok) {
          // Bust this node's usage TTL snapshot so the next /accounts/usage drops
          // the deleted account immediately (mirror accounts.ts:221; ruling D1).
          opts.getUsageService?.()?.clearCache();
          return c.json({ ok: true });
        }
        if (result.code === "last_account") {
          return c.json(
            {
              ok: false,
              error: "Cannot delete the only stored account",
              code: "last_account",
            },
            409
          );
        }
        return c.json(
          { ok: false, error: "Account not found", code: "not_found" },
          404
        );
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "nodes",
          fallbackMessage: "Failed to remove account",
        });
      }
    }
  );

  return app;
}
