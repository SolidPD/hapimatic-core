// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import {
  defineCapability,
  LOCAL_NODE_ID,
  NodeProviderAuthStateSchema,
  ProviderAuthStateEnvelopeSchema,
  ProviderIdSchema,
  type NodeProviderAuthState,
} from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Node-to-node active-account receivers (issue #1452, Sub-Issue F of epic #1446).
 *
 *   POST /api/federation/active-account          — set THIS node's active account
 *   POST /api/federation/active-account/current  — read THIS node's active account
 *
 * These are PEER-INCOMING endpoints: the HUB's per-node client route
 * (`/api/nodes/:nodeId/active-account` in routes/nodes.ts) proxies here via
 * `NodeRegistry.{set,get}ActiveAccountOnNode` → `proxyToNode`. Gated by the
 * federation token only (peer-to-peer); each receiver resolves the account
 * against THIS node's own `AccountService`, so account tokens never cross the
 * federation boundary — only `accountUuid` is transmitted (R4). The read
 * endpoint uses POST because the generic `proxyToNode` only issues POST
 * (mirrors `/federation/recent-paths`, KD-4).
 *
 * Active account is node-global (not per-namespace), so — like the recent-paths
 * receivers — these do NOT call `checkCallerNamespace` (#1097 / KD-5).
 */
export function createFederationAccountRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);

  const setActiveAccountSchema = z.object({
    accountUuid: z.string().uuid(),
    // #3808 Task 4b: optional provider — set the per-provider node default
    // (absent ⇒ the Anthropic pointer, today's behaviour).
    provider: ProviderIdSchema.optional(),
  });

  // #3808 Task 4b: optional `provider` on the READ receiver body.
  const readActiveAccountSchema = z.object({
    provider: ProviderIdSchema.optional(),
  });

  const removeAccountSchema = z.object({
    accountUuid: z.string().uuid(),
  });

  // ─── Node-to-node endpoint: POST /federation/active-account (SET) ──
  app.post(
    "/federation/active-account",
    cataloged(
      defineCapability({
        id: "accounts.federation-active-account-set",
        domain: "accounts",
        surface: "rest",
        description:
          "Set which stored account this federation node runs under, resolving the account against this node's own store; only the account UUID crosses the wire.",
        whenToUse:
          "When the hub changes a specific node's default account and proxies the switch to that node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/active-account",
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
      const service = deps.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = setActiveAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { type: "error", error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const result = service.setActiveAccount(
        parsed.data.accountUuid,
        parsed.data.provider
      );
      if (result.ok) {
        return c.json({ type: "success" });
      }
      return c.json(
        {
          type: "error",
          error: "Account not found",
          code: "account_not_found",
        },
        404
      );
    }
  );

  // ─── Node-to-node endpoint: POST /federation/active-account/current (READ) ──
  app.post(
    "/federation/active-account/current",
    cataloged(
      defineCapability({
        id: "accounts.federation-active-account-read",
        domain: "accounts",
        surface: "rest",
        description:
          "Return which stored account this federation node is currently running under (POST because the node proxy only issues POST).",
        whenToUse:
          "When the hub reads a specific node's current default account through the node proxy.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/active-account/current",
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
      const service = deps.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      // #3808 Task 4b: an optional `provider` in the body reads the per-provider
      // node default; absent ⇒ the Anthropic pointer (today's behaviour). Parse
      // defensively — an empty/absent body degrades to the Anthropic read.
      const body = await c.req.json().catch(() => null);
      const parsed = readActiveAccountSchema.safeParse(body ?? {});
      const provider = parsed.success ? parsed.data.provider : undefined;
      return c.json({
        type: "success",
        account: service.getActiveAccount(provider),
      });
    }
  );

  // ─── Node-to-node endpoint: POST /federation/remove-account (issue #2054) ──
  // Remove THIS node's stored credentials for `accountUuid` — the peer-incoming
  // half of the hub's `DELETE /api/nodes/:nodeId/accounts/:uuid`. Mirrors the
  // active-account SET receiver: fed-token gated, resolves against THIS node's
  // own AccountService, so only `accountUuid` crosses the boundary — never a
  // token (R7). Node-global like the sibling receivers → no checkCallerNamespace.
  app.post(
    "/federation/remove-account",
    cataloged(
      defineCapability({
        id: "accounts.federation-remove-account",
        domain: "accounts",
        surface: "rest",
        description:
          "Delete this federation node's stored credentials for an account; refuses with 409 if it is the node's only stored account.",
        whenToUse:
          "When the hub removes a specific node's account through the node proxy.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/remove-account",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const service = deps.getAccountService();
      if (!service) {
        return c.json({ error: "Account service unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = removeAccountSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { type: "error", error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const result = service.delete(parsed.data.accountUuid);
      if (result.ok) {
        // Bust this node's usage TTL snapshot so the next /accounts/usage drops
        // the deleted account immediately (mirror accounts.ts:221; R7 / ruling D1).
        deps.getUsageService?.()?.clearCache();
        return c.json({ type: "success" });
      }
      if (result.code === "last_account") {
        return c.json(
          {
            type: "error",
            error: "Cannot delete the only stored account",
            code: "last_account",
          },
          409
        );
      }
      return c.json(
        {
          type: "error",
          error: "Account not found",
          code: "account_not_found",
        },
        404
      );
    }
  );

  // ─── Web client endpoint: GET /federation/provider-auth-state (JWT, HUB aggregation) ──
  // Non-Anthropic provider auth state across the mesh (issue #3806, epic #3345).
  // Mirrors the /federation/accounts/usage aggregator byte-for-byte: serves THIS
  // node locally (the hub is itself a node, not in getNodeSummaries()) + fans out
  // to every peer via NodeRegistry.getProviderAuthStateOnNode, one row per node.
  // Only DERIVED fields cross the wire; the envelope is parse'd on egress (R6).
  // GET/POST share the path and differ by method (Hono dispatches by method): the
  // GET carries jwtAuth (end-user), the POST does its own checkFederationToken.
  // [ER 2026-09-19: 3806-5] [ER 2026-09-19: 3806-12] [ER 2026-09-19: K9]
  app.get(
    "/federation/provider-auth-state",
    cataloged(
      defineCapability({
        id: "accounts.federation-provider-auth-state-aggregate",
        domain: "accounts",
        surface: "rest",
        description:
          "Aggregate non-Anthropic provider auth state (Codex/Gemini) across the whole mesh: reads this node and fans out to every peer, one row per node; DERIVED fields only, never a token/key.",
        whenToUse:
          "When the Accounts page shows the OpenAI / Google Gemini provider sections across all federation nodes.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/provider-auth-state",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    async c => {
      const reader = deps.getProviderAuthState;
      const registry = deps.getNodeRegistry();
      const nodes: NodeProviderAuthState[] = [];

      // Local node first (the hub is itself a node; NOT in getNodeSummaries()).
      // On a non-federated install this is the only row (LOCAL_NODE_ID sentinel).
      if (reader) {
        try {
          const facts = await reader();
          nodes.push({
            nodeId: deps.federationConfig?.nodeId ?? LOCAL_NODE_ID,
            status: "ok",
            openai: facts.openai,
            google: facts.google,
          });
        } catch {
          // Local failure is non-fatal — degrade to remote-only (mirror usage.ts).
        }
      }

      // Remote peers — concurrent, partial-success. An unreachable peer becomes a
      // degraded `unreachable` row, NEVER silently dropped (3806-12).
      if (registry) {
        const summaries = registry.getNodeSummaries();
        const results = await Promise.allSettled(
          summaries.map(s => registry.getProviderAuthStateOnNode(s.nodeId))
        );
        results.forEach((r, i) => {
          const s = summaries[i]!;
          if (r.status === "fulfilled" && r.value && !("type" in r.value)) {
            const v = r.value;
            nodes.push({
              // Stamp the hub's canonical id for the peer (correlates with the
              // web's node list), not whatever the peer reported for itself.
              nodeId: s.nodeId,
              status: v.status ?? "ok",
              openai: v.openai ?? [],
              google: v.google,
            });
          } else {
            nodes.push({ nodeId: s.nodeId, status: "unreachable", openai: [] });
          }
        });
      }

      return c.json(ProviderAuthStateEnvelopeSchema.parse({ nodes }));
    }
  );

  // ─── Node-to-node endpoint: POST /federation/provider-auth-state (peer fan-in) ──
  // Returns THIS node's provider auth state for the hub aggregator. POST (not GET)
  // because the generic proxyToNode only issues POST (same convention as the
  // active-account /current + usage receivers). Parse-on-egress strips any
  // token/key (structural guarantee). [ER 2026-09-19: 3806-5]
  app.post(
    "/federation/provider-auth-state",
    cataloged(
      defineCapability({
        id: "accounts.federation-provider-auth-state-receiver",
        domain: "accounts",
        surface: "rest",
        description:
          "Return this node's provider auth state (Codex/Gemini DERIVED fields) for the hub aggregator (POST because the node proxy only issues POST); no token or key crosses the boundary.",
        whenToUse:
          "When the hub gathers a peer node's provider auth state for the cross-node Accounts view.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/provider-auth-state",
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
      const reader = deps.getProviderAuthState;
      if (!reader) {
        return c.json({ error: "Provider auth-state unavailable" }, 503);
      }
      const facts = await reader();
      return c.json(
        NodeProviderAuthStateSchema.parse({
          nodeId: deps.federationConfig?.nodeId ?? LOCAL_NODE_ID,
          status: "ok",
          openai: facts.openai,
          google: facts.google,
        })
      );
    }
  );

  // ─── Node-to-node: Codex (OpenAI) in-app login on the OWNING node (#3807) ──
  // The hub's /api/accounts/openai/login/* routes proxy here when the target is
  // a peer, because the per-account codex dir lives on THAT node (R4). POST-only
  // (proxyToNode issues POST). Fed-token gated; the driver runs `codex login`
  // under a per-account CODEX_HOME on this node. Only the login token + state (+
  // the device-auth link/one-time code) cross back — never a key. The API key
  // arrives in the start body (over the fed-token channel) and is fed to codex
  // stdin here; it is never logged. [ER 2026-09-19: 3807-4] [ER 2026-09-19: 3807-2]
  const fedOpenAiStartSchema = z.object({
    kind: z.enum(["api-key", "device-auth"]),
    label: z.string().max(64).optional(),
    key: z.string().optional(),
  });
  const fedOpenAiTokenSchema = z.object({
    loginToken: z.string().min(1),
  });

  app.post(
    "/federation/openai-login/start",
    cataloged(
      defineCapability({
        id: "accounts.federation-openai-login-start",
        domain: "accounts",
        surface: "rest",
        description:
          "Begin a Codex (OpenAI) login on THIS node for the hub — API-key (stdin) or ChatGPT device-auth — into a per-account codex dir; only the login token + state cross back, never a key.",
        whenToUse:
          "When the hub proxies an in-app OpenAI login to the node that owns the credential dir.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/openai-login/start",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getCodexLoginService?.();
      if (!svc) {
        return c.json({ error: "Codex login service unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = fedOpenAiStartSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body", code: "invalid_request" }, 400);
      }
      const { kind, label, key } = parsed.data;
      if (kind === "api-key" && (!key || !key.trim())) {
        return c.json(
          {
            error: "key is required for an api-key login",
            code: "invalid_request",
          },
          400
        );
      }
      const result =
        kind === "api-key"
          ? await svc.loginWithApiKey({ key: key!.trim(), label })
          : await svc.startDeviceAuth({ label });
      // #4462 Task 8 (mirror of routes/accounts.ts): an api-key login writes the
      // account's codex dir synchronously, so re-import now and the new account
      // surfaces without a restart. The trigger swallows its own errors.
      if (
        result &&
        typeof result === "object" &&
        "state" in result &&
        (result as { state?: string }).state === "ok"
      ) {
        await deps.forceProviderImport?.();
      }
      return c.json(result);
    }
  );

  app.post(
    "/federation/openai-login/status",
    cataloged(
      defineCapability({
        id: "accounts.federation-openai-login-status",
        domain: "accounts",
        surface: "rest",
        description:
          "Poll a Codex device-auth login in progress on THIS node by its login token for the hub; returns state (+ link/code while pending), never a key.",
        whenToUse:
          "When the hub polls a peer node's in-progress OpenAI device-auth login.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/openai-login/status",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getCodexLoginService?.();
      if (!svc) {
        return c.json({ error: "Codex login service unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = fedOpenAiTokenSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body", code: "invalid_request" }, 400);
      }
      const status = svc.deviceAuthStatus(parsed.data.loginToken);
      // #4462 Task 8: a completed device-auth login surfaces at once (mirror of
      // the local status route).
      if (status.state === "ok") {
        await deps.forceProviderImport?.();
      }
      return c.json(status);
    }
  );

  app.post(
    "/federation/openai-login/cancel",
    cataloged(
      defineCapability({
        id: "accounts.federation-openai-login-cancel",
        domain: "accounts",
        surface: "rest",
        description:
          "Cancel a Codex device-auth login in progress on THIS node by its login token for the hub; kills the child and removes its staging dir, leaving prior auth untouched.",
        whenToUse:
          "When the hub cancels a peer node's in-progress OpenAI device-auth login.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/openai-login/cancel",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const svc = deps.getCodexLoginService?.();
      if (!svc) {
        return c.json({ error: "Codex login service unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = fedOpenAiTokenSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid body", code: "invalid_request" }, 400);
      }
      return c.json(svc.cancelDeviceAuth(parsed.data.loginToken));
    }
  );

  return app;
}
