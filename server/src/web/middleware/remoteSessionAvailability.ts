// SPDX-License-Identifier: AGPL-3.0-only
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SyncEngine } from "../../sync/syncEngine";
import { isFetchTransportError } from "../../federation/proxyFetchSignal";
import type { WebAppEnv } from "./auth";

/**
 * Remote-session availability guard (issue #5375).
 *
 * A live session owned by a federated peer must not read as "not found" while
 * that peer briefly restarts. Without this guard the hub answers such a
 * session's per-session routes with `HTTP 502 : null` (an empty upstream 502
 * relayed as a `null` body — Bun's `resp.json()` resolves `null` instead of
 * throwing) and then, once NodeRegistry marks the peer offline, `404 "Session
 * not found"`: `findNodeForSession()` returns `null` for an offline owner
 * exactly as for an unknown id, so ~59 proxy paths fall through to the local
 * 404.
 *
 * 🔴 RESPONSE-REWRITE ONLY — never answers early. The guard runs `await
 * next()` first and only then inspects the handler's response, so every
 * handler fallback still runs (notably the cached-summary fallback in `GET
 * /api/sessions/:id`, which keeps the session header loading while its node is
 * offline, and hub-local per-session routes such as bookmarks that answer 200
 * for a remote session). Answering early would skip those fallbacks — the
 * regression shape the CLAUDE.md Fallback Preservation Rule forbids.
 *
 * Rewrites (everything else passes through byte-for-byte):
 * - 404 session-not-found → 503 `node_offline`, ONLY when the session is not
 *   local and its cached owner was offline BEFORE and is still offline AFTER
 *   the handler ran. While a node is offline the hub cannot proxy to it, so a
 *   404 in that window is the hub's own fall-through; a peer's deliberate
 *   cross-namespace 404 (`federation/shared.ts` `checkCallerNamespace`) has the
 *   identical body but can only arrive while the node is reachable, so it is
 *   never relabeled.
 * - 5xx transport failure → same status, `node_unreachable`, ONLY on an
 *   unambiguous transport signal (a thrown fetch error in `c.error`, a null /
 *   non-object / error-less body, or a code-less hub transport message). A 5xx
 *   that carries a peer `code` (e.g. `reconnect`'s `cwd_missing`) or any other
 *   application error passes through. If the owner went offline while the call
 *   was in flight, the failure is labelled 503 `node_offline` instead. For
 *   `node_unreachable`, a GET or HEAD says the node is reconnecting and any
 *   other method says the action may not have been applied; `node_offline`
 *   wording is the same for every method (see `unavailableMessage`, #5405).
 * - 404 session-not-found for an id the hub has not cached → 503
 *   `node_offline` (nodeId null) ONLY while the hub, just started, has not
 *   yet polled every static peer successfully, bounded by
 *   `HUB_RESTART_GRACE_MS` (`NodeRegistry.isAwaitingInitialPoll`). After that,
 *   an unknown id is a plain 404 again.
 *
 * `findNodeForSession()` is deliberately unchanged: it is an "is remote"
 * predicate (autoRecoveryService, autoSwitchOnRateLimit, sessionService,
 * index.ts) and a URL source where the offline-null is load-bearing
 * (terminal proxy). `locateSession()` (#3815) supplies the offline/unknown
 * distinction instead.
 *
 * Matching: mounted on `/api/sessions/:id/*`, which in Hono also matches the
 * bare `/api/sessions/:id` and static siblings such as
 * `/api/sessions/bulk-abort` (id "bulk-abort"); those are harmless because
 * `locateSession()` returns null for them. Both fail-open catches report a
 * rate-limited `federation` warning (#5406).
 *
 * Namespace tier: the hub holds no namespace for remote sessions
 * (`SessionSummary` has none), and `/api/federation/all-sessions` plus the
 * cached GET fallback already disclose a remote session's existence and node
 * status to any JWT holder, so this guard adds no disclosure — the same
 * medium/permissive read tier as server/CLAUDE.md "Federation Authorization
 * Model".
 *
 * 🔴 Mounted at the composition root (`buildWebApp.ts`) immediately after the
 * JWT auth middleware and BEFORE the extension-route loop (git-rpc) and every
 * per-session route mount — Hono runs handlers in registration order, so a
 * route registered before this guard is not wrapped.
 */

/** Hint returned to clients; the registry's private poll backoff is not exposed. */
export const REMOTE_SESSION_RETRY_AFTER_SECONDS = 5;

/**
 * At most one fail-open warning per catch site per window (#5406). ErrorLogger's
 * own limit is per category, and `federation` is shared with other components,
 * so a guard failing on every request would spend their budget too.
 */
export const GUARD_FAILURE_LOG_INTERVAL_MS = 60_000;

/** Hub-written transport messages that carry no peer `code` (exact match). */
export const TRANSPORT_ERROR_MESSAGES: readonly string[] = [
  "Remote node unreachable",
  "Node is offline",
];

/** `SessionService.proxyToNode`'s message for a code-less upstream 5xx. */
const UPSTREAM_5XX_MESSAGE = /^Remote node returned 5\d\d$/;

/** Bodies the hub's per-session routes answer when a session cannot be resolved. */
const SESSION_NOT_FOUND_ERRORS = new Set([
  "Session not found",
  // The queue PATCH/DELETE routes relabel `proxyToNode`'s not-found this way.
  "Queued message not found",
]);

export type RemoteSessionAvailabilityDeps = {
  getSyncEngine: () => Pick<SyncEngine, "getSession"> | null;
  getNodeRegistry: () => Pick<
    NodeRegistry,
    "locateSession" | "getNodeSummaries" | "isAwaitingInitialPoll"
  > | null;
  /** #5406: where a fail-open catch reports. Absent = silent (pre-#5406 behavior). */
  errorLogger?: Pick<ErrorLogger, "warn"> | null;
  /** Injectable clock for the failure-log rate window (tests). */
  getNow?: () => number;
};

type FailOpenSite = "locate" | "rewrite";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when a 404 body says the session could not be resolved. */
export function isSessionNotFoundBody(body: unknown): boolean {
  if (!isJsonObject(body)) return false;
  if (body.code === "session_not_found") return true;
  return (
    typeof body.error === "string" && SESSION_NOT_FOUND_ERRORS.has(body.error)
  );
}

/**
 * True when a 5xx is an unambiguous transport failure rather than an
 * application error relayed from the peer.
 */
export function isTransportFailure(error: unknown, body: unknown): boolean {
  // Bun's fetch network errors (TypeErrors carrying a string `code` such as
  // "ConnectionRefused") and fetch timeouts/aborts — the same predicate the
  // proxy routes use (#5404). A code-less TypeError or an `ERR_INVALID_*`
  // validation error (a malformed node URL) is a hub bug, which must not be
  // dressed up as a restarting node.
  if (isFetchTransportError(error)) return true;
  if (!isJsonObject(body)) return true; // null, non-JSON, array, primitive
  if (typeof body.code === "string") return false; // peer application code
  const message = body.error;
  if (message === undefined || message === null) return true;
  if (typeof message !== "string") return false;
  return (
    TRANSPORT_ERROR_MESSAGES.includes(message) ||
    UPSTREAM_5XX_MESSAGE.test(message) ||
    // A peer whose own sync engine is still starting answers this; the hub's
    // own `requireSyncEngine` 503 is excluded earlier by the engine-null check.
    message === "Not connected"
  );
}

/**
 * Build the replacement response from the previous one's headers. Hono's c.res
 * setter would copy every previous header — including a stale Content-Length
 * — onto a new response, so the replacement is built here and assigned after
 * clearing c.res. CORS headers (set by the outer CORS middleware on the
 * initial response) and every Set-Cookie survive; Content-Length and
 * Content-Type are dropped and the JSON type set fresh.
 */
function buildReplacement(
  previous: Response,
  body: JsonObject,
  status: ContentfulStatusCode
): Response {
  const headers = new Headers();
  for (const [key, value] of previous.headers.entries()) {
    if (key === "content-length" || key === "content-type") continue;
    if (key === "set-cookie") continue; // appended individually below
    headers.set(key, value);
  }
  for (const cookie of previous.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }
  headers.set("Content-Type", "application/json");
  headers.set("Retry-After", String(REMOTE_SESSION_RETRY_AFTER_SECONDS));
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJsonBody(res: Response): Promise<unknown> {
  try {
    const text = await res.clone().text();
    if (text === "") return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The user-facing text for a node-unavailable rewrite (issue #5405). Reads
 * issued through the web's default query retry (`queryRetry`) are retried
 * quietly, so "reconnecting" is accurate for them. The web client never
 * resends a non-GET request — TanStack mutations default to `retry: 0`
 * (`web/src/lib/query-client.ts`) and direct `ApiClient` calls such as
 * `approvePermission` have no 5xx retry — so a failed POST/PUT/PATCH/DELETE
 * must tell the user the action may not have landed and to try again. A failed
 * permission approval that said "reconnecting" left the agent waiting for an
 * answer nobody would resend.
 */
export function unavailableMessage(
  nodeLabel: string | null,
  code: "node_offline" | "node_unreachable",
  method: string
): string {
  if (code === "node_offline") {
    return `${nodeLabel ?? "The session's node"} is offline or restarting — try again in a moment`;
  }
  const isRead = method === "GET" || method === "HEAD";
  return isRead
    ? `${nodeLabel ?? "The session's node"} is not responding — reconnecting`
    : `Couldn't reach ${nodeLabel ?? "the session's node"} — your action may not have been applied. Try again.`;
}

/** Replace the handler's response with the labelled node-unavailable body. */
function replaceResponse(
  c: Context<WebAppEnv>,
  nodeId: string | null,
  nodeLabel: string | null,
  code: "node_offline" | "node_unreachable",
  status: ContentfulStatusCode,
  original: unknown
): void {
  const shape: JsonObject = {};
  if (isJsonObject(original) && original.ok === false) shape.ok = false;
  if (isJsonObject(original) && original.success === false) {
    shape.success = false;
  }
  const rewritten: JsonObject = {
    ...shape,
    error: unavailableMessage(nodeLabel, code, c.req.method),
    code,
    nodeId,
    nodeLabel,
    retryAfterSeconds: REMOTE_SESSION_RETRY_AFTER_SECONDS,
  };
  const replacement = buildReplacement(c.res, rewritten, status);
  c.res = undefined;
  c.res = replacement;
}

export function createRemoteSessionAvailabilityGuard(
  deps: RemoteSessionAvailabilityDeps
): MiddlewareHandler<WebAppEnv> {
  // Per guard instance: when each site last logged, and how many failures it
  // has suppressed since.
  const getNow = deps.getNow ?? (() => Date.now());
  const lastLoggedAt = new Map<FailOpenSite, number>();
  const suppressed = new Map<FailOpenSite, number>();
  const reportFailOpen = (
    site: FailOpenSite,
    err: unknown,
    c: Context<WebAppEnv>,
    sessionId: string | undefined
  ): void => {
    try {
      const logger = deps.errorLogger;
      if (!logger) return;
      const now = getNow();
      const last = lastLoggedAt.get(site);
      if (last !== undefined && now - last < GUARD_FAILURE_LOG_INTERVAL_MS) {
        suppressed.set(site, (suppressed.get(site) ?? 0) + 1);
        return;
      }
      lastLoggedAt.set(site, now);
      const suppressedSinceLastLog = suppressed.get(site) ?? 0;
      suppressed.set(site, 0);
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        `remote-session availability guard failed open (${site}): ${message}`,
        {
          category: "federation",
          stack: err instanceof Error ? (err.stack ?? null) : null,
          sessionId: sessionId ?? null,
          requestPath: c.req.path,
          requestMethod: c.req.method,
          context: { site, suppressedSinceLastLog },
        }
      );
    } catch {
      // The reporter must never change the guard's fail-open outcome: an
      // escaping throw would 500 at either site (skipping the handler at
      // locate, replacing the handler's response at rewrite).
    }
  };

  return async (c, next) => {
    const sessionId = c.req.param("id");
    let before: ReturnType<NodeRegistry["locateSession"]> = null;
    if (sessionId) {
      try {
        // Memory-only cache scan. Deliberately NOT engine.getSession() here: on a
        // miss that falls back to a SQLite read, and a remote id always misses.
        before = deps.getNodeRegistry()?.locateSession(sessionId) ?? null;
      } catch (err) {
        before = null;
        reportFailOpen("locate", err, c, sessionId);
      }
    }

    await next();

    if (!sessionId) return;
    const status = c.res.status;
    if (status !== 404 && status < 500) return; // bodies of 2xx/3xx are never read

    try {
      const engine = deps.getSyncEngine();
      if (!engine) return; // the hub's own 503 "Not connected" is not a node problem
      if (!before) {
        // An id the hub has never cached for a peer passes through — unless the
        // hub has just started and has not yet polled every static peer
        // successfully (bounded by `HUB_RESTART_GRACE_MS`), when a peer's live
        // session reads as unknown too.
        if (status !== 404) return;
        const registry = deps.getNodeRegistry();
        if (!registry?.isAwaitingInitialPoll()) return;
        // A poll that lands while this request runs makes the session findable;
        // the 503 then sends the client to a retry that succeeds.
        if (engine.getSession(sessionId)) return; // local session
        const unknownBody = await readJsonBody(c.res);
        if (!isSessionNotFoundBody(unknownBody)) return;
        replaceResponse(c, null, null, "node_offline", 503, unknownBody);
        return;
      }
      if (engine.getSession(sessionId)) return; // local session
      const registry = deps.getNodeRegistry();
      const after = registry?.locateSession(sessionId) ?? null;
      if (!registry || !after) return;

      const body = await readJsonBody(c.res);
      let code: "node_offline" | "node_unreachable";
      let newStatus: ContentfulStatusCode;
      if (status === 404) {
        if (before.status !== "offline" || after.status !== "offline") return;
        if (!isSessionNotFoundBody(body)) return;
        code = "node_offline";
        newStatus = 503;
      } else {
        if (!isTransportFailure(c.error, body)) return;
        // The node can go offline while the proxy call was in flight; the
        // failure is then the outage itself.
        if (after.status === "offline") {
          code = "node_offline";
          newStatus = 503;
        } else {
          code = "node_unreachable";
          newStatus = status as ContentfulStatusCode;
        }
      }

      const nodeLabel =
        registry.getNodeSummaries().find(s => s.nodeId === after.nodeId)
          ?.nodeLabel ?? after.nodeId;
      replaceResponse(c, after.nodeId, nodeLabel, code, newStatus, body);
    } catch (err) {
      // Fail-open to today's behavior: never turn a response into a 500, but
      // leave a rate-limited trace (#5406).
      reportFailOpen("rewrite", err, c, sessionId);
    }
  };
}
