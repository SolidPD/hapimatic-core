// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { createRateLimiter } from "../middleware/rateLimit";
import { cataloged } from "../../capabilities/cataloged";
import { auditInvoke, runCapabilityInvoke } from "./capabilityPolicy";

/**
 * The 404 envelope for an unknown / socketless / cross-namespace session.
 * Centralized so the three return sites cannot drift: `code:"session_not_found"`
 * is the locked signal #2419/#2420 discriminate from a pre-B server's bare 404.
 */
const SESSION_NOT_FOUND = {
  ok: false as const,
  error: "Session not found",
  code: "session_not_found" as const,
};

/**
 * Capability enumeration read path (issue #2418, epic #2416 Sub-Issue B).
 *
 * `GET /api/sessions/:id/capabilities` returns a session's live RPC methods
 * WITH their CapabilityMeta (when registered by a post-#2417 client), so a
 * mixed-version fleet can feature-detect the read/invoke surface. Sub-Issues C
 * (#2419, invoke) and D (#2420, MCP tools) build on this. Read-only — there is
 * NO invoke path here.
 *
 * Guards + envelope hand-rolled from the mcp-toggle sibling
 * (`sessions.ts` `POST /sessions/:id/mcp-toggle`), NOT `requireSessionFromParam`
 * / `requireSyncEngine` — both return bare non-envelope bodies and the former
 * leaks session existence via a 403/404 split (expert-review ruling 1B-8).
 *
 * Federation passthrough (R3) ships in the SAME factory as the local route (the
 * #1099 local-only-drift class), modeled on the `GET /sessions/:id` node-registry
 * proxy in `sessions.ts`.
 */
export function createCapabilitiesRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    getNodeRegistry?: () => NodeRegistry | null;
    federationApiToken?: string | null;
    errorLogger?: ErrorLogger | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // Issue #2419: the first client-controlled-method dispatch path is rate
  // limited as a requirement (1B-20), not a "consider" — mirrors the mcp-toggle
  // limiter (sessions.ts). Instantiated inside the factory so each mount gets a
  // fresh bucket map (test isolation).
  const capabilityInvokeLimiter = createRateLimiter({
    name: "capability-invoke",
  });

  app.get(
    "/sessions/:id/capabilities",
    cataloged(
      defineCapability({
        id: "session-introspection.session-capabilities",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Enumerate a session's live, invocable RPC capabilities together with their metadata. Read-only — there is no invoke path here.",
        whenToUse:
          "When discovering what capabilities a session exposes before invoking one.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/capabilities",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        // requireSyncEngine returns a bare {error:"Not connected"} 503 — hand-roll
        // the envelope so every response carries the {ok,error,code} contract.
        return c.json(
          { ok: false, error: "Sync engine unavailable", code: "unknown" },
          503
        );
      }

      const sessionId = c.req.param("id");
      const namespace = c.get("namespace");

      const localSession = engine.getSession(sessionId);
      if (localSession) {
        // Local session: enforce namespace ownership (no existence leak, #1097).
        // A cross-namespace hit 404s WITHOUT proxying — the session lives on THIS
        // node, just in another tenant's namespace.
        if (localSession.namespace !== namespace) {
          return c.json(SESSION_NOT_FOUND, 404);
        }
        const capabilities = engine.getSessionCapabilities(sessionId);
        if (capabilities === null) {
          // Known session with no live /cli socket (expert-review 1B-7 / R4).
          return c.json(SESSION_NOT_FOUND, 404);
        }
        return c.json({ ok: true, data: { sessionId, capabilities } });
      }

      // Local resolve missed → federation passthrough (R3). Proxy to the owning
      // node and return its body verbatim on success (model: sessions.ts GET).
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {};
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          try {
            const resp = await fetch(
              `${node.url}/api/federation/sessions/${encodeURIComponent(
                sessionId
              )}/capabilities`,
              { headers }
            );
            if (resp.ok) {
              const body = (await resp.json()) as Record<string, unknown>;
              return c.json(body);
            }
            // Non-2xx from the owning node → fall through to the 404 below.
          } catch {
            // Proxy failed (node offline / network) → fall through to the 404.
          }
        }
      }

      // Unknown / unreachable session → envelope 404 (R4). Callers discriminate
      // this (envelope code:"session_not_found") from a pre-B server's bare 404.
      return c.json(SESSION_NOT_FOUND, 404);
    }
  );

  /**
   * Generic capability invoke (issue #2419, epic #2416 Sub-Issue C —
   * TRUST-CRITICAL). `POST /api/sessions/:id/capabilities/:method` dispatches a
   * registered RPC capability over the socket path, gated by the fail-closed
   * risk-tier policy in `capabilityPolicy`: at launch ONLY `readonly`-tier
   * methods are invocable; every other case (mutating/destructive, absent meta,
   * absent riskTier, registry miss) → 403 `tier_not_invocable`.
   *
   * The gate/validate/dispatch pipeline (`runCapabilityInvoke`) runs on the node
   * that OWNS the session (KD-3): a local session gates here; a foreign-node
   * session is proxied, and the owning node re-runs the FULL gate — a peer's
   * gate result is never trusted.
   */
  app.post(
    "/sessions/:id/capabilities/:method",
    cataloged(
      defineCapability({
        id: "session-introspection.invoke-capability",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Invoke a registered capability method on a session over the socket path. The fail-closed tier gate admits only readonly-tier methods; others return tier_not_invocable.",
        whenToUse:
          "When invoking a readonly session capability discovered via the capabilities list.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/sessions/:id/capabilities/:method",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    capabilityInvokeLimiter,
    async c => {
      const engine = getSyncEngine();
      if (!engine) {
        return c.json(
          { ok: false, error: "Sync engine unavailable", code: "unknown" },
          503
        );
      }

      const sessionId = c.req.param("id");
      const method = c.req.param("method");
      const namespace = c.get("namespace");
      const caller = { userId: c.get("userId"), namespace };
      const logger = options?.errorLogger ?? null;

      // Read the body ONCE (forwarded to the local pipeline OR the proxy).
      // Absent/invalid JSON → undefined: a schema-less readonly method forwards
      // nothing; a schema'd method rejects the missing input at validation.
      const body = await c.req.json().catch(() => undefined);

      const localSession = engine.getSession(sessionId);
      if (localSession) {
        // Local session: enforce namespace ownership (no existence leak, #1097).
        // A cross-namespace hit 404s WITHOUT proxying (it lives on THIS node).
        if (localSession.namespace !== namespace) {
          return c.json(SESSION_NOT_FOUND, 404);
        }
        // This node owns the session → gate + validate + dispatch here (KD-3).
        const result = await runCapabilityInvoke({
          engine,
          sessionId,
          method,
          body,
          caller,
          logger,
        });
        return c.json(result.body, result.status);
      }

      // Local resolve missed → federation passthrough (R4). The owning node
      // re-runs the FULL gate (KD-3). Its envelope + status are load-bearing
      // (200 / 400 invalid_input / 403 tier_not_invocable / 409 transport_failed)
      // and relayed VERBATIM — unlike the GET, a non-2xx is NOT collapsed to 404.
      const registry = options?.getNodeRegistry?.();
      if (registry) {
        const node = registry.findNodeForSession(sessionId);
        if (node) {
          // The hub audits BEFORE proxying with the authenticated JWT identity —
          // the authoritative caller record ([1B-17]); the owning node can only
          // log the forwarded namespace.
          auditInvoke(logger, {
            method,
            sessionId,
            caller,
            outcome: "proxied",
          });
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            // #1097: forward the caller's namespace so the receiver re-asserts
            // ownership. A hand-rolled fetch would drop it — set it explicitly.
            "X-Hapi-Caller-Namespace": namespace,
          };
          if (options?.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          try {
            const resp = await fetch(
              `${node.url}/api/federation/sessions/${encodeURIComponent(
                sessionId
              )}/capabilities/${encodeURIComponent(method)}`,
              { method: "POST", headers, body: JSON.stringify(body ?? {}) }
            );
            const relayed = (await resp
              .json()
              .catch(() => SESSION_NOT_FOUND)) as Record<string, unknown>;
            return c.json(relayed, resp.status as ContentfulStatusCode);
          } catch {
            // Proxy failed (node offline / network) → fall through to the 404.
          }
        }
      }

      // Unknown / unreachable session → envelope 404 (mirrors the GET).
      return c.json(SESSION_NOT_FOUND, 404);
    }
  );

  return app;
}
