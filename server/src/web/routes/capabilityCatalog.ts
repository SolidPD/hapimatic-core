// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";

import type { WebAppEnv } from "../middleware/auth";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SyncEngine } from "../../sync/syncEngine";
import type { AvailabilityContext, CatalogEntry } from "@hapi/protocol";
import type { LiveCatalog } from "../../capabilities/catalogCollector";
import {
  annotateAndFilterCatalog,
  type AnnotatedLiveCatalog,
  type Caller,
  type SessionLike,
} from "../../capabilities/availabilityContext";

/**
 * Issue #3743 (Sub-Issue C, R7) — the live Tier-1 capability catalog read route,
 * MADE session-aware by #3749 (Sub-Issue I, R3/R3a).
 *
 * `GET /api/capabilities/catalog` (JWT — mounted AFTER the `/api/*` auth
 * middleware, so mount POSITION is the auth) serves this node's live catalog,
 * filterable by `?domain=` and `?surface=`. Two #3749 additions:
 *
 * - `?sessionId=<id>` builds that session's `AvailabilityContext` and annotates
 *   each IN-SCOPE entry with `{available, reason}` + a `detectedAt` staleness
 *   marker (KD-3), while HARD-FILTERING out-of-scope (and no-`scope`) entries —
 *   ABSENCE, never `available:false` — so a tenant never learns the operator
 *   surface exists (KD-1). The session lookup copies the #1097 namespace guard
 *   from `routes/capabilities.ts` (a cross-namespace hit 404s WITHOUT proxying
 *   and without a 403/404 discriminator). A remote session proxies to its owning
 *   node's federation receiver.
 * - EVERY response is scope-filtered. WITHOUT a `sessionId` the response is
 *   filtered as `user` (fail closed, R3a-d); operator entries appear ONLY for a
 *   caller who owns a named session that derives operator scope (R2a).
 *
 * `?nodeId=<remote>` proxies to the peer's federation receiver (which annotates +
 * hard-filters with the OWNING binary's context, #3749 Task 4), then applies the
 * local `?domain`/`?surface` filters to the peer's body.
 *
 * FALLBACK PRESERVATION (KD-5): a peer that 404s (an OLDER binary with no
 * receiver) yields the HUB's own catalog — user-scope-filtered here (fail closed,
 * so a cross-node query to an old peer cannot leak the hub's operator surface) —
 * stamped `{ fallback: true, peerVersion }` (peerVersion from a second fetch of
 * the peer's `/api/federation/info`, `null` if that also fails). A peer that is
 * UNREACHABLE (network/offline) yields a DISTINCT shape
 * (`{ error: "peer_unreachable" }`), never `fallback: true`.
 *
 * `GET /api/sessions/:id/capabilities` (routes/capabilities.ts) is unrelated and
 * DELIBERATELY untouched by #3749 (Task 4) — it stays a byte-compatible
 * feature-detection surface.
 */

/** The 404 envelope for an unknown / cross-namespace session (copies the locked
 * `code:"session_not_found"` signal from routes/capabilities.ts). */
const SESSION_NOT_FOUND = {
  ok: false as const,
  error: "Session not found",
  code: "session_not_found" as const,
};

/** The `{fallback,peerVersion}` / unreachable envelope (defined in the doc). */
type CatalogResponse =
  | (AnnotatedLiveCatalog & {
      nodeId: string;
      fallback: true;
      peerVersion: string | null;
    })
  | AnnotatedLiveCatalog;

function emptyCatalog(): LiveCatalog {
  return { rest: [], uncatalogedRest: [], rpc: [], mcp: [], cli: [], ui: [] };
}

/** A fail-closed user-scope context — used whenever no owned session is named. */
const USER_FALLBACK_CONTEXT: AvailabilityContext = {
  scope: "user",
  nodeCapabilities: [],
};

/**
 * Narrow a live catalog by `?domain=` / `?surface=`. `?surface=X` keeps only the
 * X section; `?domain=Y` keeps only entries whose `domain === Y` (dropping the
 * domain-less `rpc` and `uncatalogedRest` sections, which cannot match a domain).
 * The response shape is stable (all keys present) regardless of the filters.
 * Generic over the entry type so it also narrows an ALREADY-ANNOTATED catalog.
 */
function filterCatalog<T extends CatalogEntry>(
  catalog: {
    rest: T[];
    uncatalogedRest: LiveCatalog["uncatalogedRest"];
    rpc: LiveCatalog["rpc"];
    mcp: T[];
    cli: T[];
    ui: T[];
  },
  domain?: string,
  surface?: string
): typeof catalog {
  const wantSurface = (s: string): boolean => !surface || surface === s;
  const byDomain = (entries: T[]): T[] =>
    domain ? entries.filter(e => e.domain === domain) : entries;
  return {
    rest: wantSurface("rest") ? byDomain(catalog.rest) : [],
    // Domain-less: dropped whenever a domain filter is present.
    uncatalogedRest:
      !domain && wantSurface("rest") ? catalog.uncatalogedRest : [],
    rpc: !domain && wantSurface("rpc") ? catalog.rpc : [],
    mcp: wantSurface("mcp") ? byDomain(catalog.mcp) : [],
    cli: wantSurface("cli") ? byDomain(catalog.cli) : [],
    ui: wantSurface("ui") ? byDomain(catalog.ui) : [],
  };
}

/** Best-effort second fetch of the peer's `/api/federation/info` `version`. */
async function fetchPeerVersion(
  url: string,
  headers: Record<string, string>
): Promise<string | null> {
  try {
    const resp = await fetch(`${url}/api/federation/info`, { headers });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { node?: { version?: unknown } };
    const version = body.node?.version;
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}

export function createCapabilityCatalogRoutes(options: {
  getCatalog: () => LiveCatalog | null;
  getNodeRegistry?: () => NodeRegistry | null;
  federationApiToken?: string | null;
  errorLogger?: ErrorLogger | null;
  /** #3749: session lookup for the `?sessionId=` context. */
  getSyncEngine?: () => SyncEngine | null;
  /**
   * #3749: builds a session's `AvailabilityContext` (closes over the node
   * capability detector + version + operator binding). Absent ⇒ the route still
   * hard-filters, defaulting to the fail-closed user-scope context.
   */
  getAvailabilityContext?: (args: {
    session?: SessionLike;
    caller: Caller;
    nodeVersion?: string;
  }) => AvailabilityContext;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/capabilities/catalog",
    cataloged(
      defineCapability({
        id: "mcp.capabilities-catalog",
        domain: "mcp",
        surface: "rest",
        description:
          "Return this node's live capability catalog (the generated + runtime-collected entries).",
        whenToUse: "When an agent or the UI enumerates available capabilities.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/capabilities/catalog",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const domain = c.req.query("domain") || undefined;
      const surface = c.req.query("surface") || undefined;
      const nodeId = c.req.query("nodeId") || undefined;
      const sessionId = c.req.query("sessionId") || undefined;
      const caller: Caller = {
        userId: c.get("userId"),
        namespace: c.get("namespace"),
      };

      // Build a context for `session` (may derive operator scope), or the
      // fail-closed user context when no factory is wired.
      const contextFor = (
        session: SessionLike | undefined,
        nodeVersion?: string
      ): AvailabilityContext =>
        options.getAvailabilityContext?.({ session, caller, nodeVersion }) ??
        USER_FALLBACK_CONTEXT;
      // R3a-d: any path without an owned session is filtered as `user`.
      const userContext = (nodeVersion?: string): AvailabilityContext => ({
        ...contextFor(undefined, nodeVersion),
        scope: "user",
      });

      if (nodeId) {
        const registry = options.getNodeRegistry?.();
        const node = registry
          ?.getNodeSummaries()
          .find(s => s.nodeId === nodeId);
        if (!node) {
          return c.json({ error: "unknown_node", nodeId }, 404);
        }
        const headers: Record<string, string> = {
          // #1097: forward the caller's namespace so the receiver re-asserts
          // session ownership when a `?sessionId=` is proxied.
          "X-Hapi-Caller-Namespace": caller.namespace,
        };
        if (options.federationApiToken) {
          headers["Authorization"] = `Bearer ${options.federationApiToken}`;
        }
        // Forward `?sessionId=` so the owning node builds the session context.
        const receiverUrl = new URL(
          `${node.url}/api/federation/capabilities/catalog`
        );
        if (sessionId) receiverUrl.searchParams.set("sessionId", sessionId);
        try {
          const resp = await fetch(receiverUrl.toString(), { headers });
          if (resp.ok) {
            // The receiver already annotated + hard-filtered with the owning
            // node's context (#3749 Task 4). Relay it verbatim, applying only the
            // local domain/surface narrowing.
            const peer = (await resp.json()) as AnnotatedLiveCatalog;
            return c.json(filterCatalog(peer, domain, surface));
          }
          if (resp.status === 404) {
            // Older binary with no receiver → the hub's own catalog, user-scope
            // filtered (fail closed — a cross-node query never leaks the hub's
            // operator surface), then stamped.
            const local = options.getCatalog() ?? emptyCatalog();
            const peerVersion = await fetchPeerVersion(node.url, headers);
            const stamped: CatalogResponse = {
              ...filterCatalog(
                annotateAndFilterCatalog(
                  local,
                  userContext(peerVersion ?? undefined)
                ),
                domain,
                surface
              ),
              nodeId,
              fallback: true,
              peerVersion,
            };
            return c.json(stamped);
          }
          // Any other non-2xx is a peer-side error, distinct from both fallback
          // (old binary) and unreachable (partition).
          return c.json(
            { error: "peer_error", nodeId, status: resp.status },
            502
          );
        } catch (err) {
          // Network/offline — a DISTINCT shape, never `fallback: true`.
          options.errorLogger?.error(
            "capability-catalog: peer proxy unreachable",
            {
              category: "capability-catalog",
              context: {
                nodeId,
                error: err instanceof Error ? err.message : String(err),
              },
            }
          );
          return c.json({ error: "peer_unreachable", nodeId }, 502);
        }
      }

      if (sessionId) {
        const engine = options.getSyncEngine?.();
        const localSession = engine?.getSession(sessionId);
        if (localSession) {
          // #1097 namespace guard: a cross-namespace hit 404s WITHOUT proxying and
          // without a 403/404 discriminator (no existence leak).
          if (localSession.namespace !== caller.namespace) {
            return c.json(SESSION_NOT_FOUND, 404);
          }
          const context = contextFor(localSession as SessionLike);
          const catalog = options.getCatalog() ?? emptyCatalog();
          return c.json(
            filterCatalog(
              annotateAndFilterCatalog(catalog, context),
              domain,
              surface
            )
          );
        }
        // Local resolve missed → proxy to the owning node's receiver, which
        // annotates + hard-filters with its own session context; relay verbatim.
        const registry = options.getNodeRegistry?.();
        const node = registry?.findNodeForSession(sessionId);
        if (node) {
          const headers: Record<string, string> = {
            "X-Hapi-Caller-Namespace": caller.namespace,
          };
          if (options.federationApiToken) {
            headers["Authorization"] = `Bearer ${options.federationApiToken}`;
          }
          const receiverUrl = new URL(
            `${node.url}/api/federation/capabilities/catalog`
          );
          receiverUrl.searchParams.set("sessionId", sessionId);
          try {
            const resp = await fetch(receiverUrl.toString(), { headers });
            if (resp.ok) {
              const peer = (await resp.json()) as AnnotatedLiveCatalog;
              return c.json(filterCatalog(peer, domain, surface));
            }
            // Non-2xx from the owning node → fall through to the 404 below.
          } catch {
            // Proxy failed (node offline / network) → fall through to the 404.
          }
        }
        return c.json(SESSION_NOT_FOUND, 404);
      }

      // No sessionId, no nodeId → serve the local catalog, filtered as `user`
      // (fail closed, R3a-d).
      const catalog = options.getCatalog() ?? emptyCatalog();
      return c.json(
        filterCatalog(
          annotateAndFilterCatalog(catalog, userContext()),
          domain,
          surface
        )
      );
    }
  );

  return app;
}
