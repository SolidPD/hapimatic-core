// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";

import type { WebAppEnv } from "../../middleware/auth";
import { defineCapability, type AvailabilityContext } from "@hapi/protocol";
import type { FederationDeps } from "./shared";
import { cataloged } from "../../../capabilities/cataloged";
import { checkFederationToken } from "./shared";
import {
  annotateAndFilterCatalog,
  type SessionLike,
} from "../../../capabilities/availabilityContext";

/**
 * Issue #3743 (Sub-Issue C) — peer-incoming live capability catalog.
 *
 * `GET /federation/capabilities/catalog` (fed-token authed, node-global) serves
 * THIS node's live Tier-1 catalog — the OWNING binary's — so the hub's
 * `GET /api/capabilities/catalog?nodeId=<remote>` proxy reflects the peer's own
 * routes, not the hub's. Node-global like the claim-sync / output-style
 * receivers: gated ONLY on the federation token (the catalog is host-scoped, not
 * per-namespace), so no `checkCallerNamespace`.
 *
 * This receiver is JUST the source of truth for its own binary. The fallback /
 * unreachable handling — a peer 404 (old binary with no receiver) yields the
 * hub's own catalog stamped `{ fallback: true, peerVersion }`, an unreachable
 * peer yields a DISTINCT shape — lives HUB-SIDE in `routes/capabilityCatalog.ts`,
 * because only the hub has both its local catalog and the cross-peer fetch. The
 * envelope shapes are defined once in
 * `docs/internal/architecture/capability-catalog.md`.
 *
 * Registered PRE-JWT inside `createFederationRoutes` (`federation/index.ts`) —
 * peers present a fed token, not a JWT, so a post-auth mount would 401 the proxy.
 */
export function createFederationCapabilitiesRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/federation/capabilities/catalog",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-capabilities-catalog",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Serve this node's own live capability catalog, availability-annotated and hard-filtered to user scope, so the hub can proxy a peer node's catalog.",
        whenToUse:
          "When the hub answers a capability-catalog request scoped to a specific remote node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/capabilities/catalog",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      // Optional like the other federation deps (test stubs omit it). In the real
      // server.ts construction it is always wired, so this 503 is a
      // misconfiguration signal, never a fresh-boot state.
      const catalog = deps.getCapabilityCatalog?.() ?? null;
      if (!catalog) {
        return c.json({ error: "Not connected" }, 503);
      }
      // #3749 (Sub-Issue I / Task 4 / R3a): annotate + HARD-FILTER with the OWNING
      // node's context before the catalog crosses the wire — a raw (operator-
      // bearing) catalog must never be relayed. Scope fail-closes to `user`: the
      // hub forwards only the caller namespace (an operator verdict also needs a
      // userId match, R2a), so cross-node operator visibility is deferred by
      // construction. A forwarded `?sessionId=`, its namespace re-asserted (#1097),
      // supplies the OWNING session's mode axes (agent/launcher) for the annotation.
      const sessionId = c.req.query("sessionId") || undefined;
      const callerNamespace =
        c.req.header("x-hapi-caller-namespace") || undefined;
      let session: SessionLike | undefined;
      if (sessionId) {
        const owned = deps.getSyncEngine?.()?.getSession(sessionId);
        if (
          owned &&
          (!callerNamespace || owned.namespace === callerNamespace)
        ) {
          session = owned as SessionLike;
        }
      }
      const built = deps.getAvailabilityContext?.({
        session,
        caller: { userId: 0, namespace: callerNamespace ?? "" },
      });
      const context: AvailabilityContext = built
        ? { ...built, scope: "user" } // fail-closed: never operator over the wire
        : { scope: "user", nodeCapabilities: [] };
      return c.json(annotateAndFilterCatalog(catalog, context));
    }
  );

  /**
   * Issue #3744 (Sub-Issue D / R5) — peer-incoming runtime self-audit.
   *
   * `GET /federation/capabilities/audit` (fed-token authed, node-global) serves
   * THIS node's audit result — the OWNING binary's — so the hub's
   * `GET /api/capabilities/audit?nodeId=<remote>` proxy reflects the peer's own
   * routes, not the hub's. Returns `{ report, observed }` (the full shape) so the
   * hub can render either `?format`. Node-global like the catalog receiver: gated
   * ONLY on the federation token (host-scoped), so no `checkCallerNamespace`. The
   * hub-side fallback (peer 404 → the hub's own report stamped
   * `{ fallback, peerVersion }`) lives in `routes/capabilityAudit.ts`, because only
   * the hub has both its local audit and the cross-peer fetch.
   */
  app.get(
    "/federation/capabilities/audit",
    cataloged(
      defineCapability({
        id: "harness-admin.federation-capabilities-audit",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Serve this node's own runtime capability self-audit (report plus observed routes) so the hub can proxy a peer node's audit result.",
        whenToUse:
          "When the hub answers a capability-audit request scoped to a specific remote node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/capabilities/audit",
        },
        auth: "federation-token",
        riskTier: "readonly",
        availability: { scope: "operator" },
      })
    ),
    c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const audit = deps.getCapabilityAudit?.() ?? null;
      if (!audit) {
        return c.json({ error: "Not connected" }, 503);
      }
      return c.json(audit);
    }
  );

  return app;
}
