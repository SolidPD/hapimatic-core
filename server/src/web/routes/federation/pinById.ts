// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability, normalizePinId } from "@hapi/protocol";

import { cataloged } from "../../../capabilities/cataloged";
import { findLocalPinById, neutralizePinText } from "../../../sync/pinById";
import type { WebAppEnv } from "../../middleware/auth";
import { pinsGate } from "../../middleware/pinsGate";
import { withPinErrors } from "../pinRouteHelpers";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Peer-incoming read of a pin by its ID (issue #6574, epic #6446): this node's
 * half of the hub's by-ID fan-out. It answers from this node's own store only and
 * never asks another node (server/CLAUDE.md "SessionService Audience Boundary"), so
 * a lookup cannot loop.
 *
 * Checks, in order, before anything is read: the Pins gate, the federation token
 * (401), the engine (503), the STRICT caller namespace (absent → 404, as a receiver
 * added after #6224 must), then the ID's shape (400). A hit whose session is in the
 * caller's namespace answers 200 `{found: true, pin, openPinCount, timeZone}` with
 * every approval token in the pin blanked (SEC1); every other case, an unknown ID or
 * another namespace's pin, answers the same 200 `{found: false}`. Never a 404 for a
 * miss: the hub's peer read maps a 404 to "this node does not support it". POST
 * because that read only POSTs.
 */
export function createFederationPinByIdRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const gate = pinsGate(deps.pinsEnabled === true);
  const errors = deps.errorLogger ?? null;

  app.post(
    "/federation/pins/by-id/:pinId",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-pin-by-id",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return the pin with this ID if this node holds it in the caller's namespace, with approval tokens blanked (POST because the node proxy only issues POST).",
        whenToUse:
          "When the hub looks a pin up by its ID across the federation for a session or the Pins search.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/pins/by-id/:pinId",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    gate,
    c =>
      withPinErrors(c, errors, "federation-pin-by-id", async () => {
        if (!checkFederationToken(deps, c.req.header("authorization"))) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        const engine = deps.getSyncEngine();
        if (!engine) {
          return c.json({ error: "Not connected" }, 503);
        }
        const namespace = c.req.header("x-hapi-caller-namespace");
        if (!namespace) {
          return c.json({ error: "Not found" }, 404);
        }
        const pinId = normalizePinId(c.req.param("pinId"));
        if (!pinId) {
          return c.json(
            { error: "That is not a pin ID", code: "invalid_pin_id" },
            400
          );
        }
        const hit = await findLocalPinById(
          {
            getByPinId: id => engine.pins.getByPinId(id),
            getSessionByNamespace: (sessionId, ns) =>
              engine.getSessionByNamespace(sessionId, ns),
            getTimeZone: async () =>
              (await deps.getPinPreferenceTimeZone?.()) ?? null,
          },
          namespace,
          pinId
        );
        if (!hit) return c.json({ found: false });
        return c.json({
          found: true,
          pin: neutralizePinText(hit.pin),
          openPinCount: hit.openPinCount,
          timeZone: hit.timeZone,
        });
      })
  );

  return app;
}
