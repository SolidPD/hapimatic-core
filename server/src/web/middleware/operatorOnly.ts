// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from "hono";
import { markClosedGate } from "../../capabilities/cataloged";
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
 *
 * The gate also drives catalog visibility (issue #5571): a closed gate is marked
 * with `CLOSED_GATE_TAG`, so the capability collector omits the route from the
 * served catalog and `hapi_call` refuses it. A gated route therefore needs no
 * extra availability predicate — declare its entry `scope: "user"` (the gate is
 * per instance; `scope: "operator"` means the provisioner-host proof plus a
 * matching operator binding — `deriveScope`). Pass it as a route argument: an
 * `app.use` gate is not seen by the collector.
 */
export function operatorOnly(enabled: boolean): MiddlewareHandler<WebAppEnv> {
  const open = enabled === true;
  if (!open) return markClosedGate(async c => c.notFound());
  return async (_c, next) => next();
}
