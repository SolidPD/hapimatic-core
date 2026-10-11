// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { Store } from "../../store";
import type { WebAppEnv } from "../middleware/auth";

const subscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

export function createPushRoutes(
  store: Store,
  vapidPublicKey: string
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.get(
    "/push/vapid-public-key",
    cataloged(
      defineCapability({
        id: "messaging.push-vapid-key",
        domain: "messaging",
        surface: "rest",
        description:
          "Return the server's Web Push VAPID public key needed to create a browser push subscription.",
        whenToUse: "When a client sets up Web Push notifications.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/push/vapid-public-key",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      return c.json({ publicKey: vapidPublicKey });
    }
  );

  app.post(
    "/push/subscribe",
    cataloged(
      defineCapability({
        id: "messaging.push-subscribe",
        domain: "messaging",
        surface: "rest",
        description:
          "Register a Web Push subscription (endpoint plus p256dh/auth keys) for the caller's namespace.",
        whenToUse:
          "When the user enables push notifications in a browser or PWA.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/push/subscribe",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const json = await c.req.json().catch(() => null);
      const parsed = subscriptionSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const namespace = c.get("namespace");
      const { endpoint, keys } = parsed.data;
      store.push.addPushSubscription(namespace, {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      });

      return c.json({ ok: true });
    }
  );

  app.delete(
    "/push/subscribe",
    cataloged(
      defineCapability({
        id: "messaging.push-unsubscribe",
        domain: "messaging",
        surface: "rest",
        description:
          "Remove a Web Push subscription for the caller's namespace by endpoint.",
        whenToUse: "When the user disables push notifications.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/push/subscribe",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const json = await c.req.json().catch(() => null);
      const parsed = unsubscribeSchema.safeParse(json);
      if (!parsed.success) {
        return c.json({ error: "Invalid body" }, 400);
      }

      const namespace = c.get("namespace");
      store.push.removePushSubscription(namespace, parsed.data.endpoint);
      return c.json({ ok: true });
    }
  );

  return app;
}
