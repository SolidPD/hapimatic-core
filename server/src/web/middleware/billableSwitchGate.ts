// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from "hono";
import type { BillableSwitchMode } from "@hapi/protocol";
import { markClosedGate } from "../../capabilities/cataloged";
import type { WebAppEnv } from "./auth";

/**
 * The route gate for every billable switch route and receiver (issue #6646),
 * on the shape of `pinsGate`. Pass the returned middleware as a route ARGUMENT
 * after `cataloged(...)`, never through `app.use` and never by a path prefix
 * (`/api/billable*` would also close #6586's `/api/billable-time/*`). The route
 * stays mounted in every state, because the catalog ratchet treats an unmounted
 * cataloged route as drift.
 *
 * `off` answers the bare `c.notFound()` (not a JSON body), and the mark drops
 * the route from the served catalog so the agents' tool refuses it. `on` and
 * `closed` pass: in `closed` each handler refuses the on direction itself with
 * 409 `billable_feature_closed`.
 */
export function billableSwitchGate(
  mode: BillableSwitchMode
): MiddlewareHandler<WebAppEnv> {
  if (mode !== "on" && mode !== "closed") {
    return markClosedGate(async c => c.notFound());
  }
  return async (_c, next) => next();
}
