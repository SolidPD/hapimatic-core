// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Health-read auth (issue #5444).
 *
 * The monitoring sweep reads `/api/system-health` with a read-only health
 * token (`hhr_…`, `config/healthReadToken.ts`) instead of an owner session.
 * This middleware accepts that token on the health-read routes only, and only
 * on GET or HEAD (any other method gets 401 before the token is checked); any
 * other bearer falls through to the ordinary JWT middleware, so the web System
 * Health modal's owner JWT keeps working unchanged.
 *
 * The JWT-verifying surfaces refuse an `hhr_` token by name: the JWT middleware
 * (`middleware/auth.ts`) and the `/terminal` and `/claude-pty` sockets
 * (`socket/webSocketAuth.ts`). The desktop proxy refuses it as a non-JWT, and
 * `/cli/*`, `/api/auth` and `/api/bind` compare against `cliApiToken`, which an
 * `hhr_` token never equals.
 */
import type { MiddlewareHandler } from "hono";
import type { ErrorLogger } from "../../logging/errorLogger";
import {
  HEALTH_READ_TOKEN_PREFIX,
  type HealthReadTokenVerifier,
} from "../../config/healthReadToken";
import { createAuthMiddleware, type WebAppEnv } from "./auth";

/**
 * The routes that accept a health read token. Every entry must be a READ-ONLY
 * route that is mounted BEFORE the global `/api/*` JWT middleware
 * (`web/buildWebApp.ts`) with `createHealthReadAuthMiddleware`. The next entry
 * is #5922's counts-only metering read.
 */
export const HEALTH_READ_PATHS = ["/api/system-health"] as const;

export function createHealthReadAuthMiddleware(options: {
  jwtSecret: Uint8Array;
  errorLogger?: ErrorLogger | null;
  verifier: HealthReadTokenVerifier;
}): MiddlewareHandler<WebAppEnv> {
  const jwtAuth = createAuthMiddleware(options.jwtSecret, options.errorLogger);

  return async (c, next) => {
    const authorization = c.req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;

    // Header-only: a query-string token never authenticates a health read
    // (the JWT middleware's query exception covers only SSE and uploads).
    if (bearer !== undefined && bearer.startsWith(HEALTH_READ_TOKEN_PREFIX)) {
      // Read-only by method too: a later route mounted on the same path
      // could otherwise see a non-GET request this middleware let through.
      if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        return c.json({ error: "Health read tokens are read-only" }, 401);
      }
      if (await options.verifier.verify(bearer)) {
        await next();
        return;
      }
      options.errorLogger?.warn("Health read token rejected", {
        category: "auth",
        requestPath: c.req.path,
        requestMethod: c.req.method,
        statusCode: 401,
      });
      return c.json({ error: "Invalid health read token" }, 401);
    }

    return jwtAuth(c, next);
  };
}
