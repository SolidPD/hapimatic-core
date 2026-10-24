// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  isFetchTransportError,
  readProxyJson,
} from "../../federation/proxyFetchSignal";
import type { ErrorLogger } from "../../logging/errorLogger";

/**
 * Helper for catch-blocks in route handlers (#1059 silent-failure sweep).
 *
 * Routes silent-pattern catches (`catch (e) { return c.json({error}, status) }`)
 * through `errorLogger` so they land in Sentry, the SQLite error_logs table,
 * and journalctl — not just the client response.
 *
 * Mirrors the existing pattern at `server/src/web/server.ts:130` and
 * `server/src/sse/sseManager.ts:73` so call-site shape is consistent.
 *
 * When `errorLogger` is null/undefined the helper degrades to `console.error`
 * so it can be safely dropped into routes whose factories don't yet plumb
 * errorLogger — observability is best-effort either way, never throws.
 *
 * Usage:
 * ```ts
 * try {
 *   await engine.renameSession(...);
 *   return c.json({ ok: true });
 * } catch (error) {
 *   return logAndJson(c, error, 500, {
 *     errorLogger,
 *     category: "sessions",
 *     fallbackMessage: "Failed to rename session",
 *   });
 * }
 * ```
 */
export function logAndJson<T extends ContentfulStatusCode>(
  c: Context,
  error: unknown,
  status: T,
  options: {
    errorLogger?: ErrorLogger | null;
    category: string;
    /** Fallback when `error` is not an Error instance. */
    fallbackMessage?: string;
    /** Default `"warn"`. Use `"error"` for genuinely unexpected internal failures. */
    severity?: "warn" | "error";
    /** Extra structured context — e.g. `{ sessionId, peerId }`. */
    context?: Record<string, unknown> | null;
    /** Optional override; defaults to `c.req.path`. */
    requestPath?: string | null;
  }
): Response {
  const message =
    error instanceof Error
      ? error.message
      : (options.fallbackMessage ?? "Request failed");
  const stack = error instanceof Error ? error.stack : null;
  const severity = options.severity ?? "warn";
  const requestPath = options.requestPath ?? c.req.path;
  const requestMethod = c.req.method;
  const userAgent = c.req.header("user-agent") ?? null;

  if (options.errorLogger) {
    options.errorLogger[severity](message, {
      category: options.category,
      stack,
      requestPath,
      requestMethod,
      userAgent,
      statusCode: status,
      context: options.context ?? null,
    });
  } else {
    // Fallback so the helper is safe to use in routes whose factories don't
    // yet plumb errorLogger. Better than swallowing entirely.
    const prefix = `[${options.category}]`;
    if (severity === "error") {
      console.error(prefix, message);
    } else {
      console.warn(prefix, message);
    }
  }

  return c.json({ error: message }, status);
}

/**
 * Catch-block helper for the hub's peer-proxy `fetch` calls (#5404).
 *
 * A genuine transport failure (`isFetchTransportError`: a network TypeError or
 * an abort/timeout) is logged at `warn` — a peer restart is routine, and `error`
 * would page Sentry — under category `federation` with the target node, and
 * answered with the byte-identical 502 body the web client and the
 * remote-session guard key on. Every other error (a malformed node URL, a
 * disturbed request body, a programming bug, a malformed peer JSON body) is
 * rethrown so `app.onError` logs it as a 500 instead of it being dressed up as
 * an unreachable node.
 *
 * Usage:
 * ```ts
 * try {
 *   const resp = await fetch(`${node.url}/api/federation/...`, { ... });
 *   return c.json(await resp.json(), resp.status as ContentfulStatusCode);
 * } catch (error) {
 *   return proxyTransportFailure(c, error, {
 *     errorLogger: options?.errorLogger,
 *     nodeId: node.nodeId,
 *   });
 * }
 * ```
 */
export function proxyTransportFailure(
  c: Context,
  error: unknown,
  options: {
    errorLogger?: ErrorLogger | null;
    nodeId: string;
    /** Defaults to `{ error: "Remote node unreachable" }`. */
    body?: Record<string, unknown>;
  }
): Response {
  if (!isFetchTransportError(error)) throw error;
  const body = options.body ?? { error: "Remote node unreachable" };

  // A read proxy's signal also aborts when the browser goes away. That is the
  // client leaving, not the peer failing: logging it would blame a healthy node
  // and spend the shared `federation` log budget on navigation.
  if (
    (error as { name?: unknown }).name === "AbortError" &&
    c.req.raw.signal?.aborted
  ) {
    return c.json(body, 502);
  }

  const detail = error instanceof Error ? error.message : String(error);
  const message = `federation proxy: peer unreachable (${detail})`;
  const rawCode = (error as { code?: unknown }).code;
  const code =
    typeof rawCode === "string"
      ? rawCode
      : ((error as { name?: unknown }).name ?? null);

  if (options.errorLogger) {
    options.errorLogger.warn(message, {
      category: "federation",
      stack: error instanceof Error ? error.stack : null,
      requestPath: c.req.path,
      requestMethod: c.req.method,
      userAgent: c.req.header("user-agent") ?? null,
      statusCode: 502,
      context: { nodeId: options.nodeId, code },
    });
  } else {
    console.warn("[federation]", message, { nodeId: options.nodeId });
  }

  return c.json(body, 502);
}

/**
 * The read-or-502 step every request proxy shares (#5408, #5433, #5487).
 *
 * Reads the peer body with readProxyJson, so an empty or unparseable non-OK
 * body reads as {} and the caller keeps the peer's real status. A body cut off
 * mid-read becomes `failure`: the logged transport-failure 502 from
 * proxyTransportFailure. Any other error (an unparseable OK body, a hub bug)
 * is rethrown, so app.onError logs a 500 instead of an empty success.
 *
 * Usage:
 * ```ts
 * const read = await readProxyBodyOr502(c, resp, { errorLogger, nodeId });
 * if (read.failure) return read.failure;
 * return c.json(read.body, resp.status as 400 | 404 | 500 | 503);
 * ```
 */
export async function readProxyBodyOr502(
  c: Context,
  resp: Response,
  options: Parameters<typeof proxyTransportFailure>[2]
): Promise<
  | { body: Record<string, unknown>; failure?: undefined }
  | { body?: undefined; failure: Response }
> {
  try {
    return {
      body: ((await readProxyJson(resp)) ?? {}) as Record<string, unknown>,
    };
  } catch (error) {
    return { failure: proxyTransportFailure(c, error, options) };
  }
}
