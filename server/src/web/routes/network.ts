// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { TailscaleJoinService } from "../../services/tailscaleJoinService";
import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";

const JOIN_LIMIT_PER_MINUTE = 10;

const STATUS_BY_CODE = {
  invalid_key: 400,
  unavailable: 409,
  busy: 409,
  join_failed: 502,
} as const;

/**
 * `GET /network/tailscale` and `POST /network/tailscale/join` — join this VM to the
 * user's tailnet from inside the instance (#6211 R23). The auth key travels only in
 * the POST body and is never logged (see `tailscaleJoinService.ts`).
 *
 * Mounted after the global JWT gate in `buildWebApp.ts`.
 */
export function createNetworkRoutes(opts: {
  getTailscaleJoinService: () => TailscaleJoinService;
}): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const joinLimiter = createRateLimiter({
    name: "network-tailscale-join",
    limit: JOIN_LIMIT_PER_MINUTE,
  });

  app.get(
    "/network/tailscale",
    cataloged(
      defineCapability({
        id: "ui.network-tailscale-status",
        domain: "ui",
        surface: "rest",
        description:
          "Read whether this VM is on a tailnet, its tailnet IP and name, and whether it can join one from here. Never the tailnet owner's identity.",
        whenToUse:
          "When the Network settings page or the first-run wizard shows the VM's tailnet state.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/network/tailscale",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    async c => c.json(await opts.getTailscaleJoinService().status())
  );

  app.post(
    "/network/tailscale/join",
    cataloged(
      defineCapability({
        id: "ui.network-tailscale-join",
        domain: "ui",
        surface: "rest",
        description:
          "Join this VM to the user's tailnet with an auth key, through the privileged broker. The key goes only into a 0600 file that is removed afterwards.",
        whenToUse:
          "When the user pastes a Tailscale auth key on the Network settings page.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/network/tailscale/join",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    joinLimiter,
    async c => {
      const body = (await c.req.json().catch(() => null)) as {
        authKey?: unknown;
      } | null;
      if (typeof body?.authKey !== "string" || !body.authKey) {
        return c.json(
          { ok: false, code: "invalid_key", error: "authKey is required" },
          400
        );
      }
      const result = await opts.getTailscaleJoinService().join(body.authKey);
      if (result.ok) return c.json(result);
      return c.json(result, STATUS_BY_CODE[result.code]);
    }
  );

  return app;
}
