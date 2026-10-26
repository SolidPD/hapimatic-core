// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import { checkFederationToken, type FederationDeps } from "./shared";
import { isolatedChainFingerprint } from "../../../services/isolatedCredentialsSync";

/**
 * Issue #3784 — cross-node refresh-token chain-fingerprint endpoints.
 *
 * These let the idle-refresh backstop (`TokenRefreshService`) PROVE, before
 * rotating a near-expiry account that a federation node also holds, that THIS
 * node's isolated chain is a DISTINCT grant from every remote holder's — so
 * rotating cannot cross-revoke a remote session (the #1645 P-REVOKE vector).
 *
 *   POST /api/federation/chain-fingerprint         (federation-token; peer-incoming)
 *     body {accountUuid} → {nodeId, fingerprint}   — THIS node's sha256-hex
 *     fingerprint for the account (null ⇒ no isolated dir here). proxyToNode-
 *     reachable; the raw refresh token NEVER crosses the boundary.
 *
 *   GET /api/federation/account-chain-fingerprints?accountUuid= (JWT; aggregator)
 *     → {fingerprints: [{nodeId, nodeLabel, self, fingerprint}], degraded}
 *     Fans out to every ONLINE node via the local registry + this node's own
 *     fingerprint. `degraded` ⇒ at least one online node could not be reached
 *     (the consumer must then fail SAFE and skip rotation).
 */
export function createChainFingerprintRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);
  const bodySchema = z.object({ accountUuid: z.string().uuid() });

  // ─── Peer-incoming: this node's own fingerprint (federation-token) ──
  app.post(
    "/federation/chain-fingerprint",
    cataloged(
      defineCapability({
        id: "accounts.federation-chain-fingerprint",
        domain: "accounts",
        surface: "rest",
        description:
          "Return this node's sha256 refresh-token chain fingerprint for an account (never the raw token), so a peer can prove chain independence before rotating.",
        whenToUse:
          "When a peer's idle-refresh backstop needs to know whether this node shares an account's refresh-token chain.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/chain-fingerprint",
        },
        auth: "federation-token",
        // Non-GET REST ⇒ never `readonly` (#3746 never-readonly invariant): a POST
        // must not be generically JWT-invocable. It is semantically a read, but
        // this is a federation-token peer-incoming receiver (reached only via
        // proxyToNode), so `mutating` (enumerable, gate-blocked) is correct —
        // matching every sibling /api/federation POST receiver.
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }
      const nodeId = deps.getNodeRegistry()?.getLocalNodeId() ?? "local";
      const fingerprint = isolatedChainFingerprint(parsed.data.accountUuid);
      // `type: "success"` is REQUIRED: the hub wrapper (NodeRegistry
      // .getAccountChainFingerprintOnNode → proxyToNode) returns this raw body as
      // its result, and the aggregator classifies it via `res.type === "success"`
      // (the convention every other /api/federation receiver follows). Without it
      // a healthy peer response is misread as an error → the aggregator marks the
      // pass degraded and the chain-independence verdict can never be "independent".
      return c.json({ type: "success" as const, nodeId, fingerprint });
    }
  );

  // ─── Aggregator: every node's fingerprint for an account (JWT) ──
  app.get(
    "/federation/account-chain-fingerprints",
    cataloged(
      defineCapability({
        id: "accounts.federation-chain-fingerprints",
        domain: "accounts",
        surface: "rest",
        description:
          "List, per federation node, the sha256 refresh-token chain fingerprint for an account (never raw tokens) plus a degraded flag — the cross-node chain-independence probe.",
        whenToUse:
          "When comparing an account's refresh-token chains across the mesh to decide whether a node may safely rotate its own copy.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/account-chain-fingerprints",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        // probe: needs ?accountUuid= (#5212)
        probe: "skip",
        telemetry: "off",
      })
    ),
    jwtAuth,
    async c => {
      const accountUuid = c.req.query("accountUuid") ?? "";
      if (!bodySchema.safeParse({ accountUuid }).success) {
        return c.json({ error: "Invalid accountUuid" }, 400);
      }
      const registry = deps.getNodeRegistry();
      const localNodeId = registry?.getLocalNodeId() ?? "local";
      const fingerprints: Array<{
        nodeId: string;
        nodeLabel: string;
        self: boolean;
        fingerprint: string | null;
      }> = [
        {
          nodeId: localNodeId,
          nodeLabel: localNodeId,
          self: true,
          fingerprint: isolatedChainFingerprint(accountUuid),
        },
      ];
      let degraded = false;
      if (!registry) {
        // No federation on this node — only self is known. NOT degraded: a
        // single-node mesh genuinely has no remote holder to collide with.
        return c.json({ fingerprints, degraded });
      }
      const online = registry
        .getNodeStates()
        .filter(s => s.status === "online" && s.config.id !== localNodeId);
      const results = await Promise.all(
        online.map(async s => {
          const res = await registry
            .getAccountChainFingerprintOnNode(s.config.id, accountUuid)
            .catch(() => ({ type: "error" as const, message: "throw" }));
          return { state: s, res };
        })
      );
      for (const { state, res } of results) {
        if (res.type === "success") {
          fingerprints.push({
            nodeId: state.config.id,
            nodeLabel: state.config.label,
            self: false,
            fingerprint: res.fingerprint,
          });
        } else {
          // An online node we could not reach — its chain is UNKNOWN this pass,
          // so the whole probe is degraded (the consumer fails safe).
          degraded = true;
        }
      }
      return c.json({ fingerprints, degraded });
    }
  );

  return app;
}
