// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { z } from "zod";

import { defineCapability, NOTIFICATION_PEER_LIST_MAX } from "@hapi/protocol";

import type { WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { NotificationService } from "../../../notifications/notificationService";
import { checkFederationToken, type FederationDeps } from "./shared";

/**
 * Peer-incoming notification receivers (issue #4913, epic #4912).
 *
 * A notification row lives on the node whose `notify()` wrote it. The hub's
 * client-facing `/api/notifications` routes fan out to these receivers so a hub
 * browser can list, count, read and dismiss rows that live on a peer (the hub's
 * event bridge already forwards the peer's `notification` events to it).
 *
 * Two auth layers, as for every per-session federation receiver (#1097): the
 * federation token authenticates the peer node, and `X-Hapi-Caller-Namespace`
 * names the end user. A missing namespace header fails closed with 404.
 *
 * 🔴 These receivers act on LOCAL rows only and never fan out further: the
 * peer-incoming surface does not re-proxy (server/CLAUDE.md "SessionService
 * Audience Boundary"), so a request can never loop between nodes and a row is
 * never counted twice.
 */

const listBodySchema = z
  .object({
    unreadOnly: z.boolean().optional(),
    // The hub's fan-out window (offset + limit), so derived from the hub caps.
    limit: z.number().int().min(1).max(NOTIFICATION_PEER_LIST_MAX),
    offset: z.number().int().min(0),
  })
  .strict();

const idBodySchema = z.object({ id: z.string().min(1) }).strict();

const emptyBodySchema = z.object({}).strict();

type ReceiverContext = {
  service: NotificationService;
  namespace: string;
  body: unknown;
};

/**
 * Shared guard: federation token → 401, no service → 503, missing caller
 * namespace → 404, unparseable JSON → 400. Returns either the response to send
 * or the resolved context.
 */
async function resolveReceiver(
  c: Context<WebAppEnv>,
  deps: FederationDeps
): Promise<Response | ReceiverContext> {
  if (!checkFederationToken(deps, c.req.header("authorization"))) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const service = deps.getNotificationService?.() ?? null;
  if (!service) {
    return c.json({ error: "Notifications unavailable" }, 503);
  }
  const namespace = c.req.header("x-hapi-caller-namespace");
  if (!namespace) {
    return c.json({ error: "Notification not found" }, 404);
  }
  let body: unknown = {};
  const text = await c.req.text();
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "Invalid request" }, 400);
    }
  }
  return { service, namespace, body };
}

/** Shared handler for the read / dismiss receivers (one id in, one row out). */
function idHandler(
  deps: FederationDeps,
  apply: (
    service: NotificationService,
    namespace: string,
    id: string
  ) => unknown
) {
  return async (c: Context<WebAppEnv>): Promise<Response> => {
    const r = await resolveReceiver(c, deps);
    if (r instanceof Response) return r;
    const parsed = idBodySchema.safeParse(r.body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request" }, 400);
    }
    const notification = apply(r.service, r.namespace, parsed.data.id);
    if (!notification) {
      return c.json({ error: "Notification not found" }, 404);
    }
    return c.json({ notification });
  };
}

// Capability entries are inline literals: `bun run gen:capabilities` reads them
// syntactically and rejects any computed value.
export function createFederationNotificationRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  app.post(
    "/federation/notifications/list",
    cataloged(
      defineCapability({
        id: "notifications.federation-list",
        domain: "notifications",
        surface: "rest",
        description:
          "List this node's notifications for the caller namespace, newest first, for a federation hub's merged inbox.",
        whenToUse:
          "When a federation hub lists notifications that live on this peer node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/notifications/list",
        },
        auth: "federation-token",
        // POST: never `readonly` (that tier is the generic-invoker promotion
        // value, and never-readonly.test.ts rejects it for any non-GET route).
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      const r = await resolveReceiver(c, deps);
      if (r instanceof Response) return r;
      const parsed = listBodySchema.safeParse(r.body);
      if (!parsed.success) {
        return c.json({ error: "Invalid request" }, 400);
      }
      return c.json({
        notifications: r.service.list(r.namespace, {
          unreadOnly: parsed.data.unreadOnly ?? false,
          limit: parsed.data.limit,
          offset: parsed.data.offset,
        }),
      });
    }
  );

  app.post(
    "/federation/notifications/unread-count",
    cataloged(
      defineCapability({
        id: "notifications.federation-unread-count",
        domain: "notifications",
        surface: "rest",
        description:
          "Count this node's unread notifications for the caller namespace, for a federation hub's merged badge.",
        whenToUse:
          "When a federation hub counts unread notifications that live on this peer node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/notifications/unread-count",
        },
        auth: "federation-token",
        // POST: never `readonly` (that tier is the generic-invoker promotion
        // value, and never-readonly.test.ts rejects it for any non-GET route).
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      const r = await resolveReceiver(c, deps);
      if (r instanceof Response) return r;
      if (!emptyBodySchema.safeParse(r.body).success) {
        return c.json({ error: "Invalid request" }, 400);
      }
      return c.json({ count: r.service.countUnread(r.namespace) });
    }
  );

  app.post(
    "/federation/notifications/read",
    cataloged(
      defineCapability({
        id: "notifications.federation-read",
        domain: "notifications",
        surface: "rest",
        description:
          "Mark one of this node's notifications read for the caller namespace; 404 when the id is not in that namespace here.",
        whenToUse:
          "When a federation hub marks read a notification that lives on this peer node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/notifications/read",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    idHandler(deps, (service, namespace, id) => service.markRead(namespace, id))
  );

  app.post(
    "/federation/notifications/dismiss",
    cataloged(
      defineCapability({
        id: "notifications.federation-dismiss",
        domain: "notifications",
        surface: "rest",
        description:
          "Dismiss one of this node's notifications for the caller namespace; 404 when the id is not in that namespace here.",
        whenToUse:
          "When a federation hub dismisses a notification that lives on this peer node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/notifications/dismiss",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    idHandler(deps, (service, namespace, id) => service.dismiss(namespace, id))
  );

  app.post(
    "/federation/notifications/dismiss-all",
    cataloged(
      defineCapability({
        id: "notifications.federation-dismiss-all",
        domain: "notifications",
        surface: "rest",
        description:
          "Dismiss every one of this node's notifications for the caller namespace.",
        whenToUse:
          "When a federation hub clears the inbox and this peer holds rows for the caller.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/notifications/dismiss-all",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      const r = await resolveReceiver(c, deps);
      if (r instanceof Response) return r;
      if (!emptyBodySchema.safeParse(r.body).success) {
        return c.json({ error: "Invalid request" }, 400);
      }
      return c.json({ dismissed: r.service.dismissAll(r.namespace) });
    }
  );

  return app;
}
