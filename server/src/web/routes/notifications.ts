// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { z } from "zod";

import {
  defineCapability,
  NOTIFICATION_LIST_MAX_LIMIT,
  NOTIFICATION_LIST_MAX_OFFSET,
  type StoredNotification,
} from "@hapi/protocol";

import type { WebAppEnv } from "../middleware/auth";
import type {
  NodeRegistry,
  NotificationIdActionResult,
} from "../../federation/nodeRegistry";
import type { NotificationService } from "../../notifications/notificationService";
import { cataloged } from "../../capabilities/cataloged";

/**
 * The notifications inbox REST surface (issue #4913, epic #4912).
 *
 * ## 🔴 Auth comes from the MOUNT POSITION
 *
 * This factory takes no `jwtSecret`. It is mounted in `buildWebApp.ts` BELOW the
 * global `/api/*` JWT gate (beside `createBookmarksRoutes`), so every route is
 * JWT-gated and `c.get("namespace")` is the caller's namespace. Every query and
 * mutation is scoped to that namespace; an id from another namespace reads as
 * not found (404, no existence leak — #1097).
 *
 * ## Federation
 *
 * A row lives on the node whose `notify()` wrote it, and the hub's event bridge
 * forwards a peer's `notification` events to the hub's browsers. So when this
 * node has a `NodeRegistry`, the routes also fan out to every peer's
 * `/api/federation/notifications/*` receiver (local rows only there, so nothing
 * loops or double-counts). Peer rows come back stamped with `nodeId`, which
 * read / dismiss accept to route straight to the owning node. On the reads
 * (list, unread count) a down, slow or older peer contributes nothing rather
 * than failing the request; the writes (read, dismiss, dismiss-all) answer 502
 * with `failedNodes` instead of reporting success or "not found". The hub never
 * emits an event for a peer row: the peer's own service does, and the bridge
 * forwards it.
 */

export type NotificationsRoutesOptions = {
  getNotificationService: () => NotificationService | null;
  getNodeRegistry?: () => NodeRegistry | null;
};

const DEFAULT_LIMIT = 50;

const mutationBodySchema = z.object({ nodeId: z.string().min(1).optional() });

function parseIntParam(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function readMutationBody(
  c: Context<WebAppEnv>
): Promise<{ nodeId?: string } | null> {
  const text = await c.req.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed = mutationBodySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createNotificationsRoutes(
  options: NotificationsRoutesOptions
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const peers = (): { registry: NodeRegistry; nodeIds: string[] } | null => {
    const registry = options.getNodeRegistry?.() ?? null;
    if (!registry) return null;
    const nodeIds = registry
      .getNodeSummaries()
      .filter(s => s.status !== "offline")
      .map(s => s.nodeId);
    return nodeIds.length > 0 ? { registry, nodeIds } : null;
  };

  /**
   * Sum one numeric field across every reachable peer's response. A rejected
   * call, an error-shaped response or a missing field contributes 0 and puts
   * the peer in `failedNodes`, so a read can degrade quietly while a write can
   * report the peers it did not reach.
   */
  const sumPeerField = async (
    field: "count" | "dismissed",
    call: (registry: NodeRegistry, nodeId: string) => Promise<unknown>
  ): Promise<{ total: number; failedNodes: string[] }> => {
    const fanout = peers();
    if (!fanout) return { total: 0, failedNodes: [] };
    const results = await Promise.allSettled(
      fanout.nodeIds.map(nodeId => call(fanout.registry, nodeId))
    );
    let total = 0;
    const failedNodes: string[] = [];
    results.forEach((settled, i) => {
      const value =
        settled.status === "fulfilled"
          ? (settled.value as Record<string, unknown> | null)?.[field]
          : undefined;
      if (typeof value === "number") total += value;
      else failedNodes.push(fanout.nodeIds[i]);
    });
    return { total, failedNodes };
  };

  /** Try the local row, then the named node, then every peer. */
  const resolveIdAction = async (
    c: Context<WebAppEnv>,
    local: (
      service: NotificationService,
      ns: string,
      id: string
    ) => StoredNotification | null,
    remote: (
      registry: NodeRegistry,
      nodeId: string,
      ns: string,
      id: string
    ) => Promise<NotificationIdActionResult>
  ): Promise<Response> => {
    const service = options.getNotificationService();
    if (!service) {
      return c.json({ error: "Notifications unavailable" }, 503);
    }
    const body = await readMutationBody(c);
    if (body === null) {
      return c.json({ error: "Invalid request" }, 400);
    }
    const namespace = c.get("namespace");
    const id = c.req.param("id") ?? "";
    const fanout = peers();

    if (body.nodeId && fanout?.nodeIds.includes(body.nodeId)) {
      const result = await remote(fanout.registry, body.nodeId, namespace, id);
      if ("notification" in result) {
        return c.json({
          notification: { ...result.notification, nodeId: body.nodeId },
        });
      }
      if ("notFound" in result) {
        return c.json({ error: "Notification not found" }, 404);
      }
      console.warn(
        `[notifications] node ${body.nodeId} did not apply ${c.req.path}: ${result.message}`
      );
      return c.json(
        { error: "Node did not answer", failedNodes: [body.nodeId] },
        502
      );
    }

    const row = local(service, namespace, id);
    if (row) return c.json({ notification: row });

    if (fanout) {
      const results = await Promise.allSettled(
        fanout.nodeIds.map(nodeId =>
          remote(fanout.registry, nodeId, namespace, id)
        )
      );
      const failedNodes: string[] = [];
      for (const [i, settled] of results.entries()) {
        const nodeId = fanout.nodeIds[i];
        if (settled.status === "fulfilled" && "notification" in settled.value) {
          return c.json({
            notification: { ...settled.value.notification, nodeId },
          });
        }
        if (settled.status !== "fulfilled" || !("notFound" in settled.value)) {
          failedNodes.push(nodeId);
        }
      }
      // A peer that did not answer may hold the row, so "not found" would be a
      // guess: report the unreached peers instead (a client must not drop it).
      if (failedNodes.length > 0) {
        console.warn(
          `[notifications] ${c.req.path}: no answer from ${failedNodes.join(", ")}`
        );
        return c.json({ error: "Some nodes did not answer", failedNodes }, 502);
      }
    }
    return c.json({ error: "Notification not found" }, 404);
  };

  app.get(
    "/notifications",
    cataloged(
      defineCapability({
        id: "notifications.list",
        domain: "notifications",
        surface: "rest",
        description:
          "List the caller's notifications from the last 48 hours, newest first, across federated nodes; supports unread=1, limit (max 200) and offset (max 1000; deeper answers 400).",
        whenToUse:
          "When rendering the notifications inbox or checking recent session, account and node events.",
        invocation: { kind: "rest", method: "GET", path: "/api/notifications" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const service = options.getNotificationService();
      if (!service) {
        return c.json({ error: "Notifications unavailable" }, 503);
      }
      const namespace = c.get("namespace");
      const unreadOnly = c.req.query("unread") === "1";
      const limit = parseIntParam(
        c.req.query("limit"),
        DEFAULT_LIMIT,
        1,
        NOTIFICATION_LIST_MAX_LIMIT
      );
      // Rejected rather than clamped: a clamped offset would silently return a
      // different page. The cap keeps the peer window (offset + limit) inside
      // NOTIFICATION_PEER_LIST_MAX, which every peer's list receiver accepts.
      const offset = parseIntParam(c.req.query("offset"), 0, 0, Infinity);
      if (offset > NOTIFICATION_LIST_MAX_OFFSET) {
        return c.json(
          {
            error: "offset too deep",
            maxOffset: NOTIFICATION_LIST_MAX_OFFSET,
          },
          400
        );
      }

      const fanout = peers();
      if (!fanout) {
        return c.json({
          notifications: service.list(namespace, { unreadOnly, limit, offset }),
        });
      }

      // Each node returns its own top (offset + limit); merge, then slice.
      const window = offset + limit;
      const merged: StoredNotification[] = service.list(namespace, {
        unreadOnly,
        limit: window,
        offset: 0,
      });
      const results = await Promise.allSettled(
        fanout.nodeIds.map(nodeId =>
          fanout.registry
            .listNotificationsOnNode(nodeId, namespace, {
              unreadOnly,
              limit: window,
              offset: 0,
            })
            .then(r => ({ nodeId, r }))
        )
      );
      for (const settled of results) {
        if (settled.status !== "fulfilled") continue;
        const { nodeId, r } = settled.value;
        if ("notifications" in r && Array.isArray(r.notifications)) {
          for (const row of r.notifications) merged.push({ ...row, nodeId });
        }
      }
      merged.sort((a, b) =>
        b.lastAt !== a.lastAt ? b.lastAt - a.lastAt : b.id.localeCompare(a.id)
      );
      return c.json({ notifications: merged.slice(offset, offset + limit) });
    }
  );

  app.get(
    "/notifications/unread-count",
    cataloged(
      defineCapability({
        id: "notifications.unread-count",
        domain: "notifications",
        surface: "rest",
        description:
          "Count the caller's notifications that are neither read nor dismissed, across federated nodes.",
        whenToUse: "When rendering the unread badge on the settings gear.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/notifications/unread-count",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const service = options.getNotificationService();
      if (!service) {
        return c.json({ error: "Notifications unavailable" }, 503);
      }
      const namespace = c.get("namespace");
      // A read: a peer that fails contributes nothing to the badge.
      const peer = await sumPeerField("count", (registry, nodeId) =>
        registry.countUnreadNotificationsOnNode(nodeId, namespace)
      );
      return c.json({ count: service.countUnread(namespace) + peer.total });
    }
  );

  app.post(
    "/notifications/dismiss-all",
    cataloged(
      defineCapability({
        id: "notifications.dismiss-all",
        domain: "notifications",
        surface: "rest",
        description:
          "Dismiss the caller's notifications from the last 48 hours on this node and its federated peers; 502 with failedNodes when a peer did not answer.",
        whenToUse: "When the user clears the notifications inbox.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/notifications/dismiss-all",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const service = options.getNotificationService();
      if (!service) {
        return c.json({ error: "Notifications unavailable" }, 503);
      }
      const namespace = c.get("namespace");
      const local = service.dismissAll(namespace);
      const peer = await sumPeerField("dismissed", (registry, nodeId) =>
        registry.dismissAllNotificationsOnNode(nodeId, namespace)
      );
      const dismissed = local + peer.total;
      // A write: a peer that did not dismiss keeps its rows, so never report
      // success — the client sees which nodes to retry.
      if (peer.failedNodes.length > 0) {
        console.warn(
          `[notifications] dismiss-all: no answer from ${peer.failedNodes.join(", ")}`
        );
        return c.json(
          {
            error: "Some nodes did not dismiss their notifications",
            dismissed,
            failedNodes: peer.failedNodes,
          },
          502
        );
      }
      return c.json({ dismissed });
    }
  );

  app.post(
    "/notifications/:id/read",
    cataloged(
      defineCapability({
        id: "notifications.mark-read",
        domain: "notifications",
        surface: "rest",
        description:
          "Mark one of the caller's notifications read (404 for an id outside the caller's namespace, 502 when a peer that may hold it did not answer); accepts an optional nodeId for a federated row.",
        whenToUse: "When the user opens a notification's detail.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/notifications/:id/read",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    c =>
      resolveIdAction(
        c,
        (service, ns, id) => service.markRead(ns, id),
        (registry, nodeId, ns, id) =>
          registry.markNotificationReadOnNode(nodeId, ns, id)
      )
  );

  app.post(
    "/notifications/:id/dismiss",
    cataloged(
      defineCapability({
        id: "notifications.dismiss",
        domain: "notifications",
        surface: "rest",
        description:
          "Dismiss one of the caller's notifications (404 for an id outside the caller's namespace, 502 when a peer that may hold it did not answer); accepts an optional nodeId for a federated row.",
        whenToUse: "When the user dismisses a notification from the inbox.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/notifications/:id/dismiss",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    c =>
      resolveIdAction(
        c,
        (service, ns, id) => service.dismiss(ns, id),
        (registry, nodeId, ns, id) =>
          registry.dismissNotificationOnNode(nodeId, ns, id)
      )
  );

  return app;
}
