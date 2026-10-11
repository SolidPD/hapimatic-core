// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";

import { BookmarkUpsertRequestSchema, defineCapability } from "@hapi/protocol";

import type { WebAppEnv } from "../middleware/auth";
import type { Store } from "../../store";
import { cataloged } from "../../capabilities/cataloged";

/**
 * Session-scoped chat-bookmark routes (issue #3115, epic #3133) — the
 * server-side, cross-device store that replaces per-device localStorage.
 *
 * ## 🔴 Auth comes from the MOUNT POSITION — do not add an inline middleware
 *
 * This factory takes NO `jwtSecret`. It is mounted in `web/server.ts` AFTER the
 * global `app.use("/api/*", createAuthMiddleware(...))` gate (beside
 * `createExtensionAdminRoutes`), so every route here is JWT-gated positionally —
 * `c.get("namespace")` is populated by that middleware. Do NOT mount it beside
 * `createExtensionPrefsRoutes` (pre-auth): these are MUTATION routes and would be
 * reachable unauthenticated there (Hono matches in registration order). See
 * `extensionAdmin.ts`'s header for the full rationale; `bookmarks.test.ts`'s
 * auth-differential test is the regression guard.
 *
 * ## Node-local (RULING D2=A) — no federation mirror
 *
 * Every handler reads/writes the LOCAL `store.bookmarks` only. A remote session
 * viewed through a federation hub stores its bookmarks on the SERVING node;
 * cross-node bookmark visibility is an explicit documented limitation and a
 * future follow-up. There is deliberately no `proxyToNode` forwarding here — the
 * real federation mechanism (for that follow-up) would be SessionService →
 * `proxyToNode` → explicit per-mutation receivers in
 * `web/routes/federation/sessionMutations.ts`, not an arbitrary session-route
 * forward.
 *
 * ## Cross-namespace guard (#1097)
 *
 * Every endpoint rejects a LOCAL cross-namespace request with 404 (no existence
 * leak), mirroring `sessions.ts` session-scoped mutations: if the session exists
 * locally under a DIFFERENT namespace than the caller's, return 404. A session
 * with no local row (unknown / peer-owned) passes the guard — bookmarks are
 * node-local convenience state keyed by session id, FK-less like
 * `session_file_claims`.
 */
export function createBookmarksRoutes(store: Store): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  /** #1097: true when the session exists locally under a different namespace. */
  const isCrossNamespace = (sessionId: string, namespace: string): boolean => {
    const local = store.sessions.getSession(sessionId);
    return local !== null && local.namespace !== namespace;
  };

  app.get(
    "/sessions/:id/bookmarks",
    cataloged(
      defineCapability({
        id: "session-introspection.list-bookmarks",
        domain: "session-introspection",
        surface: "rest",
        description:
          "List a session's chat bookmarks (message/block position markers). Returns positions only, not message content.",
        whenToUse: "When rendering a session's saved chat bookmarks.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/sessions/:id/bookmarks",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const sessionId = c.req.param("id");
      if (isCrossNamespace(sessionId, c.get("namespace"))) {
        return c.json({ error: "Session not found" }, 404);
      }
      return c.json({ bookmarks: store.bookmarks.list(sessionId) });
    }
  );

  app.put(
    "/sessions/:id/bookmarks",
    cataloged(
      defineCapability({
        id: "session-introspection.upsert-bookmark",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Create or update a chat bookmark for a session at a message/block position.",
        whenToUse: "When the user adds or moves a chat bookmark in a session.",
        invocation: {
          kind: "rest",
          method: "PUT",
          path: "/api/sessions/:id/bookmarks",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const sessionId = c.req.param("id");
      if (isCrossNamespace(sessionId, c.get("namespace"))) {
        return c.json({ error: "Session not found" }, 404);
      }

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json(
          { error: "Invalid request", details: "Body is not valid JSON" },
          400
        );
      }

      const parsed = BookmarkUpsertRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid request", details: parsed.error.issues },
          400
        );
      }

      const bookmark = store.bookmarks.upsert(
        sessionId,
        parsed.data.messageId,
        parsed.data.blockId ?? null,
        parsed.data.offsetPx ?? 0,
        undefined, // `now` — keep its default
        parsed.data.anchorHeightPx ?? null
      );
      return c.json({ bookmark });
    }
  );

  app.delete(
    "/sessions/:id/bookmarks/:bookmarkId",
    cataloged(
      defineCapability({
        id: "session-introspection.delete-bookmark",
        domain: "session-introspection",
        surface: "rest",
        description: "Delete a single chat bookmark from a session by id.",
        whenToUse: "When the user removes a specific chat bookmark.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/sessions/:id/bookmarks/:bookmarkId",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    c => {
      const sessionId = c.req.param("id");
      if (isCrossNamespace(sessionId, c.get("namespace"))) {
        return c.json({ error: "Session not found" }, 404);
      }
      const removed = store.bookmarks.deleteOne(
        sessionId,
        c.req.param("bookmarkId")
      );
      if (!removed) {
        return c.json({ error: "Bookmark not found" }, 404);
      }
      return c.json({ ok: true });
    }
  );

  app.delete(
    "/sessions/:id/bookmarks",
    cataloged(
      defineCapability({
        id: "session-introspection.clear-bookmarks",
        domain: "session-introspection",
        surface: "rest",
        description: "Delete all chat bookmarks for a session.",
        whenToUse: "When the user clears every chat bookmark in a session.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/sessions/:id/bookmarks",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    c => {
      const sessionId = c.req.param("id");
      if (isCrossNamespace(sessionId, c.get("namespace"))) {
        return c.json({ error: "Session not found" }, 404);
      }
      const cleared = store.bookmarks.clear(sessionId);
      return c.json({ ok: true, cleared });
    }
  );

  return app;
}
