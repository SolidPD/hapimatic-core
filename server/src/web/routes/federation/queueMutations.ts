// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../middleware/auth";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";
import { cataloged } from "../../../capabilities/cataloged";
import { logAndJson } from "../routeErrorHelper";

/**
 * Issue #1325: federation receivers for /federation/sessions/:id/queue/*.
 *
 * Mirrors the emoji/linked-issue receiver pattern in sessionMutations.ts:
 *   1. checkFederationToken — 401 if missing/invalid
 *   2. engine = deps.getSyncEngine() — 503 if null
 *   3. session = engine.getSession(...) — 404 if null
 *   4. checkCallerNamespace — 404 on mismatch (R5, #1097 strict pattern)
 *   5. Zod-validate body
 *   6. Call engine.* queue method
 *   7. Return {ok: true, ...payload} or 404/500
 *
 * The queue lives on the OWNING PEER NODE (R4). Hub callers reach these
 * routes via SessionService.proxyToNode. Drain is NEVER federated — each
 * peer's QueueDrainObserver runs locally on the row's owning node.
 */

// Local copy of checkCallerNamespace — intentionally NOT importing from
// sessionMutations.ts to keep the file unmodified (directive scope: only
// queueMutations.ts and federation/index.ts get edits in Task 12).
function checkCallerNamespace(
  c: Context<WebAppEnv>,
  session: { namespace: string }
): Response | null {
  const callerNamespace = c.req.header("x-hapi-caller-namespace");
  if (!callerNamespace || session.namespace !== callerNamespace) {
    return c.json({ error: "Session not found" }, 404);
  }
  return null;
}

export function createQueueMutationRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  // ─── Schemas ───
  const enqueueSchema = z.object({
    body: z.string().min(1).max(50_000),
    clientGeneratedId: z.string().min(1).max(200).nullable().optional(),
  });
  const updateSchema = z.object({
    body: z.string().min(1).max(50_000),
  });

  // ─── POST /federation/sessions/:id/queue/enqueue ───
  app.post(
    "/federation/sessions/:id/queue/enqueue",
    cataloged(
      defineCapability({
        id: "messaging.api-federation-sessions-queue-enqueue",
        domain: "messaging",
        surface: "rest",
        description:
          "Append a message to a session's send queue on the node that owns it. Peer-incoming receiver; the hub proxies here for a remote-owned session.",
        whenToUse:
          "When enqueuing a message for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/queue/enqueue",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      const body = await c.req.json().catch(() => null);
      const parsed = enqueueSchema.safeParse(body);
      if (!parsed.success) {
        const message =
          parsed.error.issues[0]?.message ?? "Invalid enqueue body";
        return c.json({ error: message }, 400);
      }

      try {
        const result = engine.enqueueQueuedMessage({
          sessionId,
          namespace: session.namespace,
          body: parsed.data.body,
          clientGeneratedId: parsed.data.clientGeneratedId ?? null,
        });
        return c.json({ ok: true, result: result.result, row: result.row });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-queue-enqueue",
          fallbackMessage: "Failed to enqueue message",
        });
      }
    }
  );

  // ─── GET /federation/sessions/:id/queue ───
  app.get(
    "/federation/sessions/:id/queue",
    cataloged(
      defineCapability({
        id: "messaging.api-federation-sessions-queue-list",
        domain: "messaging",
        surface: "rest",
        description:
          "List a session's queued messages from the node that owns it. Peer-incoming receiver behind namespace ownership; returns queue contents, so never a safe generic read.",
        whenToUse:
          "When the hub needs the queued messages for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/sessions/:id/queue",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      try {
        const messages = engine.listQueuedMessages(
          sessionId,
          session.namespace
        );
        return c.json({ ok: true, messages });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-queue-list",
          fallbackMessage: "Failed to list queued messages",
        });
      }
    }
  );

  // ─── PATCH /federation/sessions/:id/queue/:position ───
  app.patch(
    "/federation/sessions/:id/queue/:position",
    cataloged(
      defineCapability({
        id: "messaging.api-federation-sessions-queue-update",
        domain: "messaging",
        surface: "rest",
        description:
          "Edit the body of a queued message at a given position on the node that owns the session. Peer-incoming receiver for a remote-owned session.",
        whenToUse:
          "When editing a queued message for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/federation/sessions/:id/queue/:position",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      const positionParam = c.req.param("position");
      const position = Number.parseInt(positionParam, 10);
      if (!Number.isInteger(position) || position < 0) {
        return c.json({ error: "Invalid position" }, 400);
      }

      const body = await c.req.json().catch(() => null);
      const parsed = updateSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: "Invalid update body" }, 400);
      }

      try {
        const row = engine.updateQueuedMessageAt(
          sessionId,
          session.namespace,
          position,
          parsed.data.body
        );
        if (!row) {
          return c.json({ error: "Queued message not found" }, 404);
        }
        return c.json({ ok: true, row });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-queue-update",
          fallbackMessage: "Failed to update queued message",
        });
      }
    }
  );

  // ─── DELETE /federation/sessions/:id/queue/:position ───
  app.delete(
    "/federation/sessions/:id/queue/:position",
    cataloged(
      defineCapability({
        id: "messaging.api-federation-sessions-queue-remove",
        domain: "messaging",
        surface: "rest",
        description:
          "Remove a queued message at a given position on the node that owns the session. Peer-incoming receiver; the removed message is discarded.",
        whenToUse:
          "When removing a queued message for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/federation/sessions/:id/queue/:position",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      const positionParam = c.req.param("position");
      const position = Number.parseInt(positionParam, 10);
      if (!Number.isInteger(position) || position < 0) {
        return c.json({ error: "Invalid position" }, 400);
      }

      try {
        const removed = engine.removeQueuedMessageAt(
          sessionId,
          session.namespace,
          position
        );
        if (!removed) {
          return c.json({ error: "Queued message not found" }, 404);
        }
        return c.json({ ok: true, removed: true });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-queue-remove",
          fallbackMessage: "Failed to remove queued message",
        });
      }
    }
  );

  // ─── DELETE /federation/sessions/:id/queue ───
  app.delete(
    "/federation/sessions/:id/queue",
    cataloged(
      defineCapability({
        id: "messaging.api-federation-sessions-queue-clear",
        domain: "messaging",
        surface: "rest",
        description:
          "Clear a session's entire send queue on the node that owns it. Peer-incoming receiver; all queued messages are discarded.",
        whenToUse:
          "When clearing the whole queue for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/federation/sessions/:id/queue",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      try {
        const count = engine.clearQueuedMessages(sessionId, session.namespace);
        return c.json({ ok: true, count });
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-queue-clear",
          fallbackMessage: "Failed to clear queue",
        });
      }
    }
  );

  // ─── POST /federation/sessions/:id/queue/drain (Task 17) ───
  app.post(
    "/federation/sessions/:id/queue/drain",
    cataloged(
      defineCapability({
        id: "messaging.api-federation-sessions-queue-drain",
        domain: "messaging",
        surface: "rest",
        description:
          "Send the head of a session's queue and remove it, on the node that owns the session. Peer-incoming receiver; the send is irreversible.",
        whenToUse:
          "When draining the queue head for a session whose process lives on a remote federation node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/sessions/:id/queue/drain",
        },
        auth: "federation-token",
        riskTier: "destructive",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!checkFederationToken(deps, c.req.header("authorization"))) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const sessionId = c.req.param("id");
      const session = engine.getSession(sessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const nsCheck = checkCallerNamespace(c, session);
      if (nsCheck) return nsCheck;

      try {
        const result = await engine.drainQueueHead(
          sessionId,
          session.namespace
        );
        return c.json({
          ok: true,
          sent: result.sent,
          remaining: result.remaining,
        });
      } catch (error) {
        // Issue #1362: fallbackMessage only fires when the thrown value
        // isn't an Error instance. drainQueueHead's failure paths always
        // throw Error instances with explicit "preserved" / "data lost"
        // text, so this branch is defensive — the message now expresses
        // uncertainty rather than asserting "drain failed" without
        // preservation context.
        return logAndJson(c, error, 500, {
          errorLogger: deps.errorLogger ?? null,
          category: "federation-queue-drain",
          fallbackMessage: "Send failed — message preservation status unknown",
        });
      }
    }
  );

  return app;
}
