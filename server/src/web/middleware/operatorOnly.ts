// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from "hono";
import type { WebAppEnv } from "./auth";

/**
 * Operator-instance route gate (issue #2910, epic #2909 Sub A). Pass the
 * returned middleware as a route ARGUMENT — `app.get("/feedback", gate, …)` —
 * never as `app.use(path, …)`: Hono middleware matches on path regardless of
 * method, so a path guard on `/feedback` would also 404 the public
 * `POST /feedback` that every user must keep reaching.
 *
 * Closed answers 404 (never 403) so a customer binary never advertises that the
 * route exists — the #2469/#2470 invariant. Only a literal `true` opens the
 * gate: a truthy non-boolean that slipped through a loosely typed call site
 * stays closed. The flag is resolved once per server process
 * (`resolveOperatorInstanceEnabled`). Reused by #2912's inbox proxy routes —
 * keep the name and signature stable.
 */
export function operatorOnly(enabled: boolean): MiddlewareHandler<WebAppEnv> {
  const open = enabled === true;
  return async (c, next) => {
    if (!open) return c.notFound();
    return next();
  };
}
