// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Node-to-node rotation-lease receivers (issue #1644).
 *
 *   POST /api/federation/account-lease/acquire    — try to acquire/renew a family lease
 *   POST /api/federation/account-lease/heartbeat  — extend the holder's lease
 *   POST /api/federation/account-lease/release    — release a held lease
 *
 * PEER-INCOMING endpoints: a peer's `RotationLeaseService` proxies here when the
 * peer is NOT the coordinator (hub). The hub owns the authoritative lease ledger
 * (its `hapi.db` `account_rotation_leases` table via {@link LeaseStore}). Gated by
 * the federation token only (peer-to-peer); the caller stamps its OWN
 * `holderNodeId` (its federation nodeId), so ONLY `accountUuid` + `holderNodeId`
 * cross the boundary — never a token (R7, parity with the active-account
 * receivers in `accounts.ts`).
 *
 * The lease is node-global (not per-namespace), so — like the active-account /
 * recent-paths receivers — these do NOT call `checkCallerNamespace` (#1097 / KD-5).
 */
export function createFederationAccountLeaseRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // acquire + heartbeat share a body shape (both carry the proposed TTL).
  const ttlSchema = z.object({
    accountUuid: z.string().uuid(),
    holderNodeId: z.string().min(1),
    ttlMs: z.number().int().positive(),
  });
  const releaseSchema = z.object({
    accountUuid: z.string().uuid(),
    holderNodeId: z.string().min(1),
  });

  // ─── POST /federation/account-lease/acquire ──
  app.post(
    "/federation/account-lease/acquire",
    cataloged(
      defineCapability({
        id: "accounts.federation-lease-acquire",
        domain: "accounts",
        surface: "rest",
        description:
          "Try to acquire or renew this node's rotation lease on an account family so only one node rotates a shared account at a time.",
        whenToUse:
          "When a peer's rotation service needs exclusive rights to rotate an account and asks the hub's lease ledger.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/account-lease/acquire",
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
      const leaseStore = deps.getLeaseStore?.() ?? null;
      if (!leaseStore) {
        return c.json({ error: "Lease store unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = ttlSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { type: "error", error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const r = leaseStore.tryAcquire(
        parsed.data.accountUuid,
        parsed.data.holderNodeId,
        parsed.data.ttlMs,
        Date.now()
      );
      return c.json({
        type: "success",
        granted: r.granted,
        holder: r.holder,
        expiresAt: r.expiresAt,
      });
    }
  );

  // ─── POST /federation/account-lease/heartbeat ──
  app.post(
    "/federation/account-lease/heartbeat",
    cataloged(
      defineCapability({
        id: "accounts.federation-lease-heartbeat",
        domain: "accounts",
        surface: "rest",
        description:
          "Extend this node's currently-held rotation lease on an account before it expires so the account is not re-acquired mid-rotation.",
        whenToUse:
          "When the lease holder periodically renews its hold while it is still rotating the account.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/account-lease/heartbeat",
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
      const leaseStore = deps.getLeaseStore?.() ?? null;
      if (!leaseStore) {
        return c.json({ error: "Lease store unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = ttlSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { type: "error", error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      const granted = leaseStore.heartbeat(
        parsed.data.accountUuid,
        parsed.data.holderNodeId,
        parsed.data.ttlMs,
        Date.now()
      );
      return c.json({ type: "success", granted });
    }
  );

  // ─── POST /federation/account-lease/release ──
  app.post(
    "/federation/account-lease/release",
    cataloged(
      defineCapability({
        id: "accounts.federation-lease-release",
        domain: "accounts",
        surface: "rest",
        description:
          "Release this node's rotation lease on an account so another node may acquire it once rotation finishes.",
        whenToUse:
          "When the holder finishes rotating and frees the account family for other nodes.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/account-lease/release",
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
      const leaseStore = deps.getLeaseStore?.() ?? null;
      if (!leaseStore) {
        return c.json({ error: "Lease store unavailable" }, 503);
      }
      const body = await c.req.json().catch(() => null);
      const parsed = releaseSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { type: "error", error: "Invalid body", code: "invalid_request" },
          400
        );
      }
      leaseStore.release(parsed.data.accountUuid, parsed.data.holderNodeId);
      return c.json({ type: "success" });
    }
  );

  return app;
}
