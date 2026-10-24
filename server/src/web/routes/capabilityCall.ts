// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { SmartRouter } from "hono/router/smart-router";
import { RegExpRouter } from "hono/router/reg-exp-router";
import { TrieRouter } from "hono/router/trie-router";
import type { Router } from "hono/router";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { defineCapability, isDotSegment } from "@hapi/protocol";
import type { AvailabilityContext, CatalogEntry } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { createRateLimiter } from "../middleware/rateLimit";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import {
  readCapabilityTag,
  type LiveCatalog,
} from "../../capabilities/catalogCollector";
import type {
  Caller,
  SessionLike,
} from "../../capabilities/availabilityContext";
import { auditInvoke, isEntryInvocable } from "./capabilityPolicy";
import { CALLER_SESSION_HEADER } from "./agentEscalation";

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
 * header is never minted). The catalog router (`SmartRouter([RegExpRouter,
 * TrieRouter])`, as `new Hono()` uses) only filters the allowlist; the entry we GATE
 * is then chosen by asking the LIVE app router which route `app.fetch` will
 * DISPATCH (`dispatchedRoute`, #4011), because Hono runs routes in registration
 * order and the catalog is sorted by id. The gate is then bound to the dispatched
 * HANDLERS by a tag walk (#5596): the gated entry's id must be the `cataloged()`
 * tag of every tagged handler ahead of the first untagged one, in Hono's dispatch
 * order for the request. The walk deliberately crosses overlapping patterns, which
 * is how it catches a second tag registered on `/x/:name` behind `/x/:id`. A `query` object is validated up front and
 * set on the dispatch URL's `search` only after the bare path passed the gate.
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

/** The caller's own session id, stamped by the injected hapi MCP wrapper and
 *  copied onto the dispatched request (#3842 R5). The SAME constant the route
 *  floors read, so the two can never disagree. */
const SESSION_ID_HEADER = CALLER_SESSION_HEADER;

/** The single base every dispatch URL is built from, and the base the
 *  dispatch-agreement check parses against (#4316). */
export const DISPATCH_BASE = "http://capability-call.internal";

/**
 * Normalization / denylist (R8). Reject a path that could traverse, carry a query
 * or scheme/host, or target the capability/federation surfaces. The dispatched
 * request is built ONLY from a path that passes this AND resolves to exactly one
 * catalog entry — never a raw caller string.
 *
 * Dispatch agreement (#4316): together with `dispatchPathDiverges`, three rules
 * make the GATED path byte for byte the path Hono ROUTES — no `%` (Hono's
 * `getPath` decodes only when `%` is present), no `.`/`..` segment (the URL parser
 * collapses them), and the path must equal its own `new URL` pathname. Without
 * them `/ext-assets/.%2e/api/...` is gated as the readonly wildcard but dispatched
 * as the target route, and the prefix denies below never see the dispatched path.
 */
export function isRejectedPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return true;
  if (!path.startsWith("/")) return true; // must be an absolute in-app path
  const lower = path.toLowerCase();
  if (path.includes("%")) return true; // #4316: Hono decodes only when % is present, so no % ⇒ raw == routed
  if (path.includes("..")) return true; // traversal
  if (path.split("/").some(isDotSegment)) return true; // #4316: dot segments
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

/**
 * True when the URL parser would dispatch a different path than the one gated:
 * `new URL(path, DISPATCH_BASE).pathname !== path` (#4316). Catches every
 * remaining rewrite, including the characters the parser percent-encodes (space,
 * `{`, `}`, non-ASCII). Fails closed: a path `new URL` cannot parse diverges.
 */
export function dispatchPathDiverges(path: string): boolean {
  try {
    return new URL(path, DISPATCH_BASE).pathname !== path;
  } catch {
    return true;
  }
}

/** Resolve `method path` to the ONE catalog entry for the route Hono will actually
 *  dispatch (#4011 dispatch agreement). Returns that entry, or a refusal reason. */
type Resolution =
  | { ok: true; entry: CatalogEntry }
  | {
      ok: false;
      reason:
        | "none"
        | "ambiguous"
        | "matcher_error"
        | "not_dispatched"
        | "dispatch_tag_mismatch";
    };

/** A wildcard-suffixed path (`app.use("*" | "/api/*", mw)`) — the same rule as
 *  `isWildcardPath` in `capabilities/audit.ts`. */
function isWildcardPath(path: string): boolean {
  return path === "*" || path === "/*" || path.endsWith("/*");
}

/**
 * The route Hono will run for `method path` on the LIVE app (#4011). Hono
 * dispatches in REGISTRATION order (`#dispatch` composes `router.match()` in the
 * order it returns), so the first non-`ALL` match is the responding route. An
 * `ALL` match before it is accepted only as a wildcard middleware or an
 * exact-path companion of that same route (`app.use("/system-health", auth)`):
 * any other `ALL` (e.g. a responding `app.all("/api/x")`) would run first, so the
 * request is refused. `HEAD` is matched as `GET`, exactly as `#dispatch` does.
 * Returns `null` when no route agrees.
 */
export function dispatchedRoute(
  app: Hono<WebAppEnv>,
  method: string,
  path: string
): { method: string; path: string } | null {
  const match = dispatchedMatch(app, method, path);
  return match ? { method: match.method, path: match.path } : null;
}

/**
 * `dispatchedRoute` plus the HANDLERS Hono will run (#5596): the non-`ALL`
 * matches' handlers in dispatch order, starting at the responding route, `ALL`
 * entries skipped. `resolveEntry` reads both the agreement route and the tag walk
 * from this ONE `router.match()` result. Exported for tests.
 */
export function dispatchedMatch(
  app: Hono<WebAppEnv>,
  method: string,
  path: string
): { method: string; path: string; handlers: unknown[] } | null {
  const routed = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const [matches] = app.router.match(routed, path);
  const before: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const route = matches[i][0][1];
    if (route.method !== "ALL") {
      const ok = before.every(p => isWildcardPath(p) || p === route.path);
      if (!ok) return null;
      const handlers: unknown[] = [];
      for (const later of matches.slice(i)) {
        if (later[0][1].method !== "ALL") handlers.push(later[0][0]);
      }
      return { method: route.method, path: route.path, handlers };
    }
    before.push(route.path);
  }
  return null;
}

/**
 * The tag walk (#5596, D1=1): the `cataloged()` tag ids of `handlers`, in
 * dispatch order, up to the first UNTAGGED handler. `resolveEntry` gates only
 * when this is non-empty and every id is the gated entry's id, so an untagged
 * first handler (empty walk) fails closed. Exported so the composition-root
 * guard runs the same walk the invoker does.
 */
export function dispatchedTagIds(handlers: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const handler of handlers) {
    const tag = readCapabilityTag(handler);
    if (!tag) break;
    ids.push(tag.id);
  }
  return ids;
}

/** Query-channel limits (#4011 R3). Validated BEFORE resolution, appended only
 *  AFTER the bare path passed hygiene, resolution and the gate. */
const QUERY_MAX_KEYS = 32;
const QUERY_KEY_RE = /^[A-Za-z0-9_.\-[\]]{1,64}$/;
const QUERY_MAX_VALUE = 1024;
const QUERY_MAX_ENCODED = 4096;

/** Parse the optional `query` field: a plain object of string values within the
 *  limits above. Returns the encoded search string ("" when empty/absent) or
 *  `null` when the shape is invalid. */
export function encodeQuery(query: unknown): string | null {
  if (query === undefined) return "";
  if (typeof query !== "object" || query === null || Array.isArray(query)) {
    return null;
  }
  const proto = Object.getPrototypeOf(query) as unknown;
  if (proto !== Object.prototype && proto !== null) return null;
  const entries = Object.entries(query as Record<string, unknown>);
  if (entries.length > QUERY_MAX_KEYS) return null;
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (!QUERY_KEY_RE.test(key)) return null;
    if (typeof value !== "string" || value.length > QUERY_MAX_VALUE) {
      return null;
    }
    params.append(key, value);
  }
  const encoded = params.toString();
  return encoded.length > QUERY_MAX_ENCODED ? null : encoded;
}

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
      // The catalog router is the ALLOWLIST filter only: its match order is the
      // catalog's id sort, not Hono's dispatch order (#4011).
      const [matches] = cachedRouter!.match(method.toUpperCase(), path);
      if (matches.length === 0) return { ok: false, reason: "none" };
      // Dispatch agreement (#4011 R2) and the tag walk (#5596) hold in layers:
      // - method+path agreement (applied to a single match too) stops an
      //   uncatalogued route on a DIFFERENT path from being gated as the
      //   catalogued one;
      // - the tag walk stops a SAME-path handler registered ahead of the tag (a
      //   duplicate registration, an extension route, an in-call limiter), and a
      //   second tag of a different id behind it, same group or an overlapping
      //   pattern;
      // - in-tree route files are lint-guarded against untagged registrations
      //   (`hapi/no-uncataloged-route`), which already reports a tag-only
      //   registration followed by a separate untagged one.
      // Residuals: that tag-only-then-untagged shape outside lint scope
      // (filesystem extensions), which the router cannot tell from one
      // `app.get(p, cataloged(e), h)` call; a RESPONDING exact-path
      // `app.use(p, h)` ahead of the route, admitted by `dispatchedMatch`'s
      // companion rule (all 4 today are auth middleware, pinned by a
      // buildWebApp.test.ts guard); and a catalogued handler that itself calls
      // `next()` (none today). Extension-declared REST entries are refused
      // unless their route is tagged.
      const route = dispatchedMatch(options.getApp(), method, path);
      if (!route) return { ok: false, reason: "not_dispatched" };
      const agreeing = matches.filter(([entry]) => {
        const inv = entry.invocation;
        return (
          inv.kind === "rest" &&
          inv.method.toUpperCase() === route.method &&
          inv.path === route.path
        );
      });
      if (agreeing.length === 0) return { ok: false, reason: "not_dispatched" };
      if (agreeing.length > 1) return { ok: false, reason: "ambiguous" };
      const entry = agreeing[0][0];
      // Tag walk (#5596, D1=1). Compare by `id` (the catalog's primary key):
      // fixture and extension-merged entries need not be the tag objects.
      const ids = dispatchedTagIds(route.handlers);
      if (ids.length === 0 || !ids.every(id => id === entry.id)) {
        return { ok: false, reason: "dispatch_tag_mismatch" };
      }
      return { ok: true, entry };
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
          "Invoke a catalogued REST capability by METHOD+path (+ optional query object) through the tier-gated generic invoker.",
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
        | { method?: unknown; path?: unknown; body?: unknown; query?: unknown }
        | undefined;
      const method =
        typeof reqBody?.method === "string"
          ? reqBody.method.toUpperCase()
          : undefined;
      const path = typeof reqBody?.path === "string" ? reqBody.path : undefined;
      const dispatchBody = reqBody?.body;
      // #4011 R3: validated here, appended only after the bare path is gated.
      const search = encodeQuery(reqBody?.query);

      if (!method || !path || !ALLOWED_METHODS.has(method)) {
        return c.json(
          {
            ok: false,
            error:
              "Request must be { method, path, body?, query? } with a valid HTTP method",
            code: "invalid_request",
          },
          400
        );
      }
      if (search === null) {
        return c.json(
          {
            ok: false,
            error:
              "query must be an object of at most 32 string values (keys [A-Za-z0-9_.-[]], 1-64 chars; values up to 1024 chars; 4096 encoded)",
            code: "invalid_request",
          },
          400
        );
      }
      if (
        dispatchBody !== undefined &&
        (method === "GET" || method === "HEAD")
      ) {
        // Previously dropped silently, which hid a missing query parameter
        // behind the target route's own validation error (#4011).
        return c.json(
          {
            ok: false,
            error: `A ${method} request cannot carry a body; pass parameters in query`,
            code: "invalid_request",
          },
          400
        );
      }

      const auditMethodPath = `${method} ${path}`;

      // Normalization / denylist (R8) + dispatch agreement (#4316) — the no-oracle
      // refusal covers a rejected path and one the URL parser would rewrite.
      if (isRejectedPath(path) || dispatchPathDiverges(path)) {
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
      // verbatim — no credential substitution (R2). The query (#4011 R3) is set on
      // `search` only, so it cannot change the gated pathname; Hono routes on the
      // pathname alone, and `getPath` stops scanning at `?`.
      const url = new URL(path, DISPATCH_BASE);
      if (search) url.search = search;
      const headers = new Headers();
      const authHeader = c.req.header("Authorization");
      if (authHeader) headers.set("Authorization", authHeader);
      // #3842 R5: copy the caller's own session id verbatim, when present, so
      // the target route sees agent provenance (`deriveClientOrigin` stamps a
      // send `cli-api`; the permission, spawn and schedule floors key on it).
      // A provenance hint, not a credential: never invented, never logged.
      const callerSessionId = c.req.header(SESSION_ID_HEADER);
      if (callerSessionId) headers.set(SESSION_ID_HEADER, callerSessionId);
      headers.set(DEPTH_HEADER, "1");
      const init: RequestInit = { method: inv.method, headers };
      if (dispatchBody !== undefined) {
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
