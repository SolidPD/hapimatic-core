// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
