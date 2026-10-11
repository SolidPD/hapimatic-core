// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { SmartRouter } from "hono/router/smart-router";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { TrieRouter } from "hono/router/trie-router";
import type { Router } from "hono/router";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { defineCapability } from "@hapi/protocol";
import type { AvailabilityContext, CatalogEntry } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { createRateLimiter } from "../middleware/rateLimit";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { LiveCatalog } from "../../capabilities/catalogCollector";
import type {
  Caller,
  SessionLike,
} from "../../capabilities/availabilityContext";
import { auditInvoke, isEntryInvocable } from "./capabilityPolicy";

/**
 * The generic tier-gated REST invoker (issue #3751, epic #3740 Sub-Issue K —
 * TRUST-CRITICAL, expert-review gated). `POST /api/capabilities/call` dispatches a
 * catalogued REST capability by `{method, path}` — the catalog IS the allowlist,
 * so a path with no entry is REFUSED (no free-form proxy → no eval port).
 *
 * The gate is a NEW sibling core (D11 / KD-2). `runCapabilityInvoke` in
 * `capabilityPolicy.ts` CANNOT dispatch REST — its `isValidMethodName` rejects
 * every `/`-bearing path and every dotted catalog id, its engine is the socket RPC
 * registry, and the tier it reads is client-declared — so this core REUSES
 * `auditInvoke` + `isEntryInvocable` VERBATIM and mirrors the gate ORDER (hygiene →
 * resolve → tier/trust/scope → dispatch → audit). It does NOT satisfy
 * `CapabilityInvokeEngine`; the adapter shim is BANNED (R5).
 *
 * Dispatch is IN-PROCESS `app.fetch` re-entry (KD-6 / D11): the FULL middleware
 * chain runs (the global JWT gate, every per-prefix `app.use` guard, every route's
 * own rate limiter and body validation), so the invoker adds *discovery
 * convenience*, never *authority*. The caller's OWN `Authorization` header is copied
 * through VERBATIM — the invoker never substitutes a credential (R2), so a
 * `federation-token` entry is never reachable (`isEntryInvocable` denies it, and the
 * header is never minted). Resolution uses the SAME router config `new Hono()` uses
 * (`SmartRouter([RegExpRouter, TrieRouter])`), so the entry we GATE is exactly the
 * route `app.fetch` DISPATCHES — no match/dispatch divergence.
 *
 * Federation (`--node`) is HELD pending an identity design (R6): the CLI verb
 * returns `node_unsupported`; no receiver is built here.
 */

/** Refusal with NO existence oracle — resolution miss, ambiguity, normalization/
 *  prefix rejection, and every scope/trusted/auth refusal collapse to this ONE
 *  shape, so a caller cannot tell "exists but you can't reach it" from "no such
 *  capability" (V1). */
const REFUSED: { status: ContentfulStatusCode; body: Record<string, unknown> } =
  {
    status: 403,
    body: {
      ok: false,
      error: "No invocable capability for this request",
      code: "not_invocable",
    },
  };

/** Tier refusal — the entry IS user-visible in the caller's catalog, so revealing
 *  `tier_not_invocable` leaks nothing new (mirrors the RPC path's constant). */
const TIER_REFUSED: {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
} = {
  status: 403,
  body: {
    ok: false,
    error: "Method is not invocable",
    code: "tier_not_invocable",
  },
};

/** The HTTP methods a catalogued REST entry may carry (Hono's supported set). */
const ALLOWED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "HEAD",
]);

/** Re-entrancy marker: set on every dispatched request; refused on the way IN so a
 *  transitive catalogued route can never loop back into the invoker. */
const DEPTH_HEADER = "X-Hapi-Capability-Depth";

/**
 * Normalization / denylist (R8). Reject a path that could traverse, carry a query
 * or scheme/host, or target the capability/federation surfaces. The dispatched
 * request is built ONLY from a path that passes this AND resolves to exactly one
 * catalog entry — never a raw caller string.
 */
function isRejectedPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return true;
  if (!path.startsWith("/")) return true; // must be an absolute in-app path
  const lower = path.toLowerCase();
  if (path.includes("..") || lower.includes("%2e%2e")) return true; // traversal
  if (path.includes("//")) return true; // empty segment / protocol-relative
  if (path.includes("?") || path.includes("#")) return true; // query / fragment
  if (path.includes("\\") || /[\x00-\x1f]/.test(path)) return true; // ctrl / backslash
  if (lower.includes("://")) return true; // scheme/host
  // Deny the capability + federation surfaces by prefix (R8): no self-invocation,
  // no re-entrancy loop, no reaching a federation receiver through the generic path.
  if (path.startsWith("/api/capabilities/")) return true;
  if (path.startsWith("/api/federation/")) return true;
  return false;
}

/** Resolve `method path` against the live catalog's REST entries using the SAME
 *  router `new Hono()` uses, so the gated entry is the dispatched route. Returns
 *  the single matched entry, or a refusal reason (0 / >1 / matcher error). */
type Resolution =
  | { ok: true; entry: CatalogEntry }
  | { ok: false; reason: "none" | "ambiguous" | "matcher_error" };

export function createCapabilityCallRoutes(options: {
  /** Lazy accessor for the fully-mounted app — the `app.fetch` re-entry target. */
  getApp: () => Hono<WebAppEnv>;
  /** The boot-time live catalog provider (its `rest` array is the allowlist). */
  getCatalog: () => LiveCatalog | null;
  /** #3749 context factory; the invoker forces user-scope (fail-closed) over it. */
  getAvailabilityContext?: (args: {
    session?: SessionLike;
    caller: Caller;
    nodeVersion?: string;
  }) => AvailabilityContext;
  errorLogger?: ErrorLogger | null;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // Fresh bucket map per mount (test isolation) — a requirement, not a "consider":
  // this is a broader dispatch path than the RPC invoke route (capabilities.ts).
  const callLimiter = createRateLimiter({ name: "capability-call" });

  // Resolver router, rebuilt only when the (static) `rest` array reference changes.
  let cachedRouter: Router<CatalogEntry> | null = null;
  let cachedRestRef: readonly CatalogEntry[] | null = null;

  function resolveEntry(
    catalog: LiveCatalog,
    method: string,
    path: string
  ): Resolution {
    if (cachedRestRef !== catalog.rest) {
      const router: Router<CatalogEntry> = new SmartRouter<CatalogEntry>({
        routers: [
          new RegExpRouter<CatalogEntry>(),
          new TrieRouter<CatalogEntry>(),
        ],
      });
      for (const entry of catalog.rest) {
        if (entry.invocation.kind !== "rest") continue;
        try {
          router.add(
            entry.invocation.method.toUpperCase(),
            entry.invocation.path,
            entry
          );
        } catch {
          // An un-addable pattern (RegExpRouter throws on some shapes) is skipped:
          // an unreachable entry is safer than a partial router. It will simply
          // never resolve → refuse (fail-closed).
        }
      }
      cachedRouter = router;
      cachedRestRef = catalog.rest;
    }
    try {
      const [matches] = cachedRouter!.match(method.toUpperCase(), path);
      if (matches.length === 0) return { ok: false, reason: "none" };
      if (matches.length > 1) return { ok: false, reason: "ambiguous" };
      return { ok: true, entry: matches[0][0] };
    } catch {
      return { ok: false, reason: "matcher_error" };
    }
  }

  app.post(
    "/capabilities/call",
    cataloged(
      defineCapability({
        id: "mcp.capabilities-call",
        domain: "mcp",
        surface: "rest",
        description:
          "Invoke a catalogued REST capability by METHOD+path through the tier-gated generic invoker.",
        whenToUse:
          "When invoking a catalogued REST capability the catalog marks invocable.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/capabilities/call",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    callLimiter,
    async c => {
      const logger = options.errorLogger ?? null;
      const caller: Caller = {
        userId: c.get("userId"),
        namespace: c.get("namespace"),
      };
      const auditCaller = {
        userId: caller.userId,
        namespace: caller.namespace,
      };

      // Re-entrancy guard (R8): a request that arrived via `app.fetch` re-entry is
      // never allowed to invoke again. Belt to the prefix-deny suspenders.
      if (c.req.header(DEPTH_HEADER)) {
        auditInvoke(logger, {
          method: "call",
          caller: auditCaller,
          outcome: "denied_resolution",
        });
        return c.json(REFUSED.body, REFUSED.status);
      }

      const reqBody = (await c.req.json().catch(() => undefined)) as
        | { method?: unknown; path?: unknown; body?: unknown }
        | undefined;
      const method =
        typeof reqBody?.method === "string"
          ? reqBody.method.toUpperCase()
          : undefined;
      const path = typeof reqBody?.path === "string" ? reqBody.path : undefined;
      const dispatchBody = reqBody?.body;

      if (!method || !path || !ALLOWED_METHODS.has(method)) {
        return c.json(
          {
            ok: false,
            error:
              "Request must be { method, path, body? } with a valid HTTP method",
            code: "invalid_request",
          },
          400
        );
      }

      const auditMethodPath = `${method} ${path}`;

      // Normalization / denylist (R8) — the no-oracle refusal covers a rejected path.
      if (isRejectedPath(path)) {
        auditInvoke(logger, {
          method: auditMethodPath,
          caller: auditCaller,
          outcome: "denied_resolution",
        });
        return c.json(REFUSED.body, REFUSED.status);
      }

      const catalog = options.getCatalog();
      if (!catalog) {
        return c.json(
          {
            ok: false,
            error: "Capability catalog unavailable",
            code: "unknown",
          },
          503
        );
      }

      // Resolve to EXACTLY ONE catalog entry (R8) — no existence oracle otherwise.
      const resolution = resolveEntry(catalog, method, path);
      if (!resolution.ok) {
        auditInvoke(logger, {
          method: auditMethodPath,
          caller: auditCaller,
          outcome: "denied_resolution",
        });
        return c.json(REFUSED.body, REFUSED.status);
      }
      const entry = resolution.entry;
      const inv = entry.invocation;
      if (inv.kind !== "rest") {
        // Impossible: the resolver router only holds `rest` entries. Fail closed if
        // the invariant is ever violated (a non-rest entry cannot be dispatched).
        auditInvoke(logger, {
          method: auditMethodPath,
          entryId: entry.id,
          caller: auditCaller,
          outcome: "denied_resolution",
        });
        return c.json(REFUSED.body, REFUSED.status);
      }

      // Fail-closed user-scope context (R8 / NEW-3751-23): a REST invoke has no
      // session, so the generic path never derives operator scope — operator-scope
      // entries are refused BY CONSTRUCTION.
      const baseContext: AvailabilityContext = options.getAvailabilityContext
        ? options.getAvailabilityContext({ caller })
        : { scope: "user", nodeCapabilities: [] };
      const context: AvailabilityContext = { ...baseContext, scope: "user" };

      // The single catalog-side gate (R4 / R5): trusted → auth → scope/availability
      // → tier/promotion, fail-closed and in that order.
      const decision = isEntryInvocable(entry, context);
      if (!decision.invocable) {
        auditInvoke(logger, {
          method: auditMethodPath,
          entryId: entry.id,
          caller: auditCaller,
          outcome: decision.outcome,
        });
        // Only a tier refusal reveals the entry (it is user-visible in the catalog);
        // trusted/auth/scope refusals share the no-oracle shape.
        return decision.outcome === "denied_tier"
          ? c.json(TIER_REFUSED.body, TIER_REFUSED.status)
          : c.json(REFUSED.body, REFUSED.status);
      }

      // Dispatch: in-process `app.fetch` re-entry (D11 / KD-6). Method comes from the
      // MATCHED ENTRY; the path passed normalization AND resolved to exactly this
      // entry, so it is validated, not raw. The caller's OWN Authorization is copied
      // verbatim — no credential substitution (R2).
      const url = new URL(path, "http://capability-call.internal");
      const headers = new Headers();
      const authHeader = c.req.header("Authorization");
      if (authHeader) headers.set("Authorization", authHeader);
      headers.set(DEPTH_HEADER, "1");
      const init: RequestInit = { method: inv.method, headers };
      if (dispatchBody !== undefined && inv.method.toUpperCase() !== "GET") {
        headers.set("Content-Type", "application/json");
        init.body = JSON.stringify(dispatchBody);
      }

      try {
        const resp = await options
          .getApp()
          .fetch(new Request(url.toString(), init));
        auditInvoke(logger, {
          method: auditMethodPath,
          entryId: entry.id,
          caller: auditCaller,
          outcome: "allowed",
        });
        // Relay the target route's response verbatim — it owns its `{ok, data|error}`
        // envelope. (Any 4xx/5xx from the target is the target's business; the gate
        // ALLOWED the invoke, so the audit line is `allowed`.)
        const status = resp.status as ContentfulStatusCode;
        const contentType = resp.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
          const data = (await resp.json().catch(() => null)) as unknown;
          return c.json(data as Record<string, unknown>, status);
        }
        const text = await resp.text();
        return c.body(text, status);
      } catch (err) {
        auditInvoke(logger, {
          method: auditMethodPath,
          entryId: entry.id,
          caller: auditCaller,
          outcome: "transport_error",
        });
        return c.json(
          {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            code: "transport_failed",
          },
          409
        );
      }
    }
  );

  return app;
}
