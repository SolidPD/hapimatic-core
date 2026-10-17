// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import { jwtVerify } from "jose";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { CatalogEntry } from "@hapi/protocol";
import { COMPANION_TOKEN_PREFIX } from "@hapi/protocol/companion";

export type WebAppEnv = {
  Variables: {
    userId: number;
    namespace: string;
    // Issue #3742: the CatalogEntry a `cataloged()` route middleware set on the
    // context, so the route handler (and #3746/#3752 consumers) can read it via
    // `c.get("capability")`. Optional — most routes carry no capability entry.
    capability?: CatalogEntry;
  };
};

const jwtPayloadSchema = z.object({
  uid: z.number(),
  ns: z.string(),
});

export function createAuthMiddleware(
  jwtSecret: Uint8Array,
  errorLogger?: ErrorLogger | null
): MiddlewareHandler<WebAppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    // Issue #1003: the Google SSO handoff exchange authenticates via the handoff
    // token itself (GET serves the exchange page, POST exchanges the token), so
    // the JWT middleware must skip it — path-based (covers both methods).
    //
    // Issue #2617 (Config Porter Sub A / F1, D1=A): the porter public recipient
    // endpoint returns ONLY the instance's public age recipient (never the
    // prompt, never any secret) so a cold, unauthenticated extraction session
    // can re-fetch it to run its recipient consistency check. EXACT-match (not a
    // prefix) — this exempts ONLY this one path; the prompt-serving
    // `GET /api/porter/recipient` stays JWT-gated (see routes/porterKey.ts).
    if (
      path === "/api/auth" ||
      path === "/api/bind" ||
      path === "/api/auth/google/handoff" ||
      path === "/api/porter/recipient/public"
    ) {
      await next();
      return;
    }

    const authorization = c.req.header("authorization");
    const tokenFromHeader = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : undefined;
    // ── #1062 M-1: query-param token is allowed ONLY for two paths ──
    //   /api/events            — SSE (EventSource cannot set custom headers)
    //   /api/sessions/X/upload/ — binary file serving for <img>/<video> tags
    //                             which also cannot set custom headers
    // Every other path falls through to header-only auth. Query strings
    // leak into access logs, referer headers, and browser history, so the
    // exception is intentionally narrow.
    const allowQueryToken =
      path === "/api/events" || /^\/api\/sessions\/[^/]+\/upload\//.test(path);
    const tokenFromQuery = allowQueryToken ? c.req.query().token : undefined;
    const token = tokenFromHeader ?? tokenFromQuery;

    if (!token) {
      return c.json({ error: "Missing authorization token" }, 401);
    }

    // Issue #4352: a companion pairing token (`hcp_…`) is valid only on the
    // `/api/companion/helper/*` routes, which are mounted before this
    // middleware and check it themselves. Refuse it here explicitly, so a
    // leaked pairing token can never reach any JWT route — even if a future
    // change made such tokens verify as a JWT.
    if (token.startsWith(COMPANION_TOKEN_PREFIX)) {
      return c.json(
        { error: "Companion pairing tokens are not valid on this route" },
        401
      );
    }

    try {
      const verified = await jwtVerify(token, jwtSecret, {
        algorithms: ["HS256"],
      });
      const parsed = jwtPayloadSchema.safeParse(verified.payload);
      if (!parsed.success) {
        return c.json({ error: "Invalid token payload" }, 401);
      }

      c.set("userId", parsed.data.uid);
      c.set("namespace", parsed.data.ns);
      await next();
      return;
    } catch (error) {
      errorLogger?.warn("JWT verification failed", {
        category: "auth",
        requestPath: path,
        requestMethod: c.req.method,
        statusCode: 401,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return c.json({ error: "Invalid token" }, 401);
    }
  };
}
