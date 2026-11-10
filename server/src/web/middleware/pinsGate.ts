// SPDX-License-Identifier: AGPL-3.0-only
import type { MiddlewareHandler } from "hono";
import { markClosedGate } from "../../capabilities/cataloged";
import type { WebAppEnv } from "./auth";

/**
 * The route gate for every Pins route (issue #6447). Pass the returned middleware
 * as a route ARGUMENT after `cataloged(...)`, never through `app.use`, because the
 * capability collector does not see an `app.use` gate, and the invoker refuses a
 * route whose first handler is untagged. See `operatorOnly`, whose shape this is.
 * It is a separate function because that name asserts an operator-only surface.
 *
 * Closed answers 404, and the mark removes the route from the served catalog, so
 * nothing advertises a tab that does not exist yet. Only a literal `true` opens.
 */
export function pinsGate(enabled: boolean): MiddlewareHandler<WebAppEnv> {
  const open = enabled === true;
  if (!open) return markClosedGate(async c => c.notFound());
  return async (_c, next) => next();
}
