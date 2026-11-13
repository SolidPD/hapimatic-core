// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability, normalizePinId } from "@hapi/protocol";

import { cataloged } from "../../capabilities/cataloged";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { enginePinByIdDeps, lookupPinById } from "../../sync/pinById";
import type { SyncEngine } from "../../sync/syncEngine";
import type { WebAppEnv } from "../middleware/auth";
import { pinsGate } from "../middleware/pinsGate";
import {
  invalidPinIdResponse,
  pinByIdLimiters,
  pinByIdResponse,
  withPinErrors,
} from "./pinRouteHelpers";

/**
 * `GET /api/pins/by-id/:pinId` (issue #6574, epic #6446): read a pin by its ID,
 * on this node or a peer. A separate path, so it can never collide with
 * `/pins/dashboards` or a session's `/pins/:key`.
 *
 * ## 🔴 Auth comes from the MOUNT POSITION
 *
 * Mounted below the global JWT gate in `buildWebApp.ts`, beside the dashboards
 * route, so `namespace` is the caller's. The route arguments are ordered
 * `cataloged, gate, limiters`, so with Pins off the route answers 404 (never 429)
 * and is absent from the served catalog.
 *
 * The read rule is ruling D3 (Matt's SEC1): any caller in the namespace may read
 * any pin of a session in it, read-only. `riskTier: "readonly"` makes the route
 * reachable by every agent through `hapi_call`, which that ruling allows; a pin read
 * this way carries no "read it as data" note (only `pin_get` adds one). Every hit
 * has its approval tokens blanked; the existing key reads stay as they are (ruling
 * DB). The lookup and its federation fan-out are `sync/pinById.ts`.
 */
export type PinByIdRoutesOptions = {
  pinsEnabled: boolean;
  getNodeRegistry?: () => NodeRegistry | null;
  localNode: () => { nodeId: string; nodeLabel: string };
  /** This node's pin time zone, for a local hit. */
  getPreferenceTimeZone?: () => Promise<string | null>;
  errorLogger?: ErrorLogger | null;
};

export function createPinByIdRoutes(
  getSyncEngine: () => SyncEngine | null,
  options: PinByIdRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = pinsGate(options.pinsEnabled);
  const errorLogger = options.errorLogger ?? null;
  const [namespaceLimiter, sessionLimiter] = pinByIdLimiters(
    "pins-by-id",
    getSyncEngine
  );

  app.get(
    "/pins/by-id/:pinId",
    cataloged(
      defineCapability({
        id: "session-introspection.get-pin-by-id",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Read a pin by its ID (pin- and ten characters), read-only, wherever its session lives in the caller's namespace across federated nodes. Approval tokens in the pin are blanked.",
        whenToUse:
          "When a session or the operator names a pin by its ID and needs its title, options, answers or owner.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/pins/by-id/:pinId",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    gate,
    namespaceLimiter,
    sessionLimiter,
    c =>
      withPinErrors(c, errorLogger, "pin-by-id", async () => {
        const pinId = normalizePinId(c.req.param("pinId"));
        if (!pinId) return invalidPinIdResponse(c);
        const engine = getSyncEngine();
        if (!engine) {
          return c.json({ error: "Not connected" }, 503);
        }
        const outcome = await lookupPinById(
          enginePinByIdDeps(engine, {
            registry: options.getNodeRegistry?.() ?? null,
            getTimeZone: options.getPreferenceTimeZone,
            localNode: options.localNode(),
          }),
          c.get("namespace"),
          pinId
        );
        return pinByIdResponse(c, outcome);
      })
  );

  return app;
}
