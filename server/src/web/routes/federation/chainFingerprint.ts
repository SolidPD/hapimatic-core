// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import { checkFederationToken, type FederationDeps } from "./shared";
import {
  isolatedChainFacts,
  type ChainLayoutFacts,
  type ChainMarkerFacts,
  type IsolatedChainFacts,
} from "../../../services/isolatedCredentialsSync";

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
 *     Fans out to every node that is not offline via the local registry + this
 *     node's own fingerprint. `degraded` ⇒ at least one node it asked could not
 *     be reached (the consumer must then fail SAFE and skip rotation).
 *
 * Issue #6997 (Task 4), additive: each answer also carries
 * `layoutFingerprints` (every folder layout's fingerprint and, when the node's
 * `~/.claude` login is this account, that chain's), `deadlineAt` (the first
 * layout's sign-in deadline), `layouts` (each layout's fingerprint with ITS OWN
 * deadline) and `markers` (each sign-in marker's fingerprint and time). Hashes
 * and times only. The receivers read every layout with this node's data dir
 * (`chainFactsOptions`). A reply from an older peer lacks them and reads as no
 * layouts, no deadline and no markers. The aggregator now asks DEGRADED nodes
 * too (M6), so a holder on a degraded peer is compared rather than skipped.
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
          "Return this node's sha256 refresh-token fingerprints for an account (each folder layout and its login), sign-in deadlines and marker hashes and times (never a token), so a peer can prove independence.",
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
      const facts = isolatedChainFacts(
        parsed.data.accountUuid,
        deps.chainFactsOptions
      );
      // `type: "success"` is REQUIRED: the hub wrapper (NodeRegistry
      // .getAccountChainFingerprintOnNode → proxyToNode) returns this raw body as
      // its result, and the aggregator classifies it via `res.type === "success"`
      // (the convention every other /api/federation receiver follows). Without it
      // a healthy peer response is misread as an error → the aggregator marks the
      // pass degraded and the chain-independence verdict can never be "independent".
      return c.json({ type: "success" as const, nodeId, ...facts });
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
          "List, per federation node, an account's sha256 refresh-token fingerprints, sign-in deadlines and sign-in marker hashes and times (never a token), plus a degraded flag — the chain-independence probe.",
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
      const fingerprints: Array<
        {
          nodeId: string;
          nodeLabel: string;
          self: boolean;
        } & IsolatedChainFacts
      > = [
        {
          nodeId: localNodeId,
          nodeLabel: localNodeId,
          self: true,
          ...isolatedChainFacts(accountUuid, deps.chainFactsOptions),
        },
      ];
      let degraded = false;
      if (!registry) {
        // No federation on this node — only self is known. NOT degraded: a
        // single-node mesh genuinely has no remote holder to collide with.
        return c.json({ fingerprints, degraded });
      }
      // #6997 (M6): every node that is not offline is asked, a degraded one
      // included, so a holder there is compared instead of silently skipped.
      const asked = registry
        .getNodeStates()
        .filter(s => s.status !== "offline" && s.config.id !== localNodeId);
      const results = await Promise.all(
        asked.map(async s => {
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
            ...peerChainFacts(res),
          });
        } else {
          // A node we asked and could not reach — its chain is UNKNOWN this
          // pass, so the whole probe is degraded (the consumer fails safe).
          degraded = true;
        }
      }
      return c.json({ fingerprints, degraded });
    }
  );

  return app;
}

/** A peer's chain-fingerprint reply as the hub wrapper returns it. */
type PeerChainReply = {
  fingerprint: string | null;
  layoutFingerprints?: unknown;
  deadlineAt?: unknown;
  layouts?: unknown;
  markers?: unknown;
};

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (v): v is Record<string, unknown> => typeof v === "object" && v !== null
      )
    : [];
}

/**
 * Issue #6997: a peer's reply as chain facts. The reply crosses the federation
 * boundary, so each field is normalized: anything that is not a hash or a
 * finite time is dropped. A reply from an older peer (no layouts, deadline or
 * markers) reads as just its fingerprint, which the consumer treats as unknown
 * for the sign-in checks.
 */
function peerChainFacts(res: PeerChainReply): IsolatedChainFacts {
  const layouts: ChainLayoutFacts[] = objects(res.layouts).map(l => ({
    fingerprint: stringOrNull(l.fingerprint),
    deadlineAt: finiteOrNull(l.deadlineAt),
    source: l.source === "host" ? "host" : "isolated",
  }));
  const markers: ChainMarkerFacts[] = objects(res.markers).map(m => ({
    fingerprint: stringOrNull(m.fingerprint),
    writtenAt: finiteOrNull(m.writtenAt),
  }));
  return {
    fingerprint: stringOrNull(res.fingerprint),
    layoutFingerprints: Array.isArray(res.layoutFingerprints)
      ? res.layoutFingerprints.filter(
          (f): f is string => stringOrNull(f) !== null
        )
      : [],
    deadlineAt: finiteOrNull(res.deadlineAt),
    layouts,
    markers,
  };
}
