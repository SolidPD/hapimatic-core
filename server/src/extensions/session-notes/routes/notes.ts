// SPDX-License-Identifier: AGPL-3.0-only
/**
 * REST CRUD for `builtin.session-notes` (issue #1284, Sub-Issue T of epic #1264).
 *
 * ## Route prefix — why NOT `/sessions/:id/notes`
 *
 * Core already owns `PUT /api/sessions/:id/notes` (`web/routes/sessions.ts`) for
 * the unrelated single-string `sessions.notes` column. Extension route factories
 * mount at `web/server.ts:382`; `createSessionsRoutes` mounts at `:405`. Hono
 * resolves FIRST-REGISTERED-WINS, so an extension route at that path would
 * silently shadow core's and break a working feature with every test still
 * green. This extension therefore takes a top-level prefix — the same shape
 * `builtin.scheduler` (`/schedules`), `builtin.github-issues` (`/github/*`), and
 * `builtin.git-rpc` (`/git/*`) use:
 *
 *   GET    /api/session-notes/:sessionId           → list
 *   POST   /api/session-notes/:sessionId           → create
 *   PUT    /api/session-notes/:sessionId/:noteId   → update
 *   DELETE /api/session-notes/:sessionId/:noteId   → delete
 *
 * ## Auth
 *
 * The loader mounts these under `/api` AFTER the JWT middleware, so every
 * request already carries an authenticated `namespace`. Each handler then
 * re-asserts that the target session belongs to that namespace.
 *
 * Cross-namespace and not-found both return **404**, never 403 — matching issue
 * #1097's no-existence-leak convention as applied by the adjacent core notes
 * route. A 403 would confirm "this session exists, but is not yours".
 *
 * ## Why the store is a late-bound getter
 *
 * `register()` builds the store eagerly (the raw DB exists by then), but
 * `SyncEngine` may still be null while extensions load. Both are resolved
 * per-request through getters so a slow boot yields a clean 503 rather than a
 * captured null.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import type { WebAppEnv } from "../../../web/middleware/auth";
import type { SyncEngine } from "../../../sync/syncEngine";
import { MAX_NOTE_LENGTH } from "../tableNames";
import type { SessionNotesStore } from "../store/notesStore";

const contentSchema = z.object({
  content: z.string().trim().min(1).max(MAX_NOTE_LENGTH),
});

export interface SessionNotesRouteDeps {
  getStore: () => SessionNotesStore | null;
  getSyncEngine: () => SyncEngine | null;
}

export function createSessionNotesRoutes(
  deps: SessionNotesRouteDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();

  /**
   * Resolve the store and assert the caller's namespace owns `:sessionId`.
   * Returns the store on success, or the Response to return verbatim.
   *
   * Centralizing this is what keeps the four handlers from each re-deriving the
   * ownership rule — the failure mode where one endpoint silently omits the
   * check is exactly how cross-namespace leaks ship.
   */
  const requireOwnedSession = (
    c: Context<WebAppEnv>
  ): { store: SessionNotesStore; sessionId: string } | Response => {
    const store = deps.getStore();
    const engine = deps.getSyncEngine();
    if (!store || !engine) {
      return c.json({ error: "Not connected" }, 503);
    }

    const sessionId = c.req.param("sessionId");
    if (sessionId === undefined) {
      return c.json({ error: "Session not found" }, 404);
    }
    const session = engine.getSession(sessionId);
    // Missing session and cross-namespace session are deliberately
    // indistinguishable to the caller (#1097).
    if (!session || session.namespace !== c.get("namespace")) {
      return c.json({ error: "Session not found" }, 404);
    }

    return { store, sessionId };
  };

  /**
   * Parse and validate a note-content body. Returns the validated content, or
   * the 400 Response to return verbatim.
   *
   * Paired with {@link requireOwnedSession} so both mutating handlers read as
   * "guard ownership → guard input → act". Keeping the rejection in ONE place
   * also keeps the error message and `MAX_NOTE_LENGTH` from drifting between
   * POST and PUT — two copies of a user-facing limit is how an API ends up
   * advertising 5000 on one verb and something else on the other.
   */
  const requireContent = async (
    c: Context<WebAppEnv>
  ): Promise<string | Response> => {
    const body = await c.req.json().catch(() => null);
    const parsed = contentSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: `content must be a non-empty string of at most ${MAX_NOTE_LENGTH} characters`,
        },
        400
      );
    }
    return parsed.data.content;
  };

  /** GET /session-notes/:sessionId — all notes for the session, oldest first. */
  app.get("/session-notes/:sessionId", c => {
    const owned = requireOwnedSession(c);
    if (owned instanceof Response) return owned;
    const notes = owned.store.list(owned.sessionId);
    return c.json({ notes, count: notes.length });
  });

  /** POST /session-notes/:sessionId — create a note. */
  app.post("/session-notes/:sessionId", async c => {
    const owned = requireOwnedSession(c);
    if (owned instanceof Response) return owned;

    const content = await requireContent(c);
    if (content instanceof Response) return content;

    const note = owned.store.create(owned.sessionId, content);
    return c.json({ note }, 201);
  });

  /** PUT /session-notes/:sessionId/:noteId — replace a note's content. */
  app.put("/session-notes/:sessionId/:noteId", async c => {
    const owned = requireOwnedSession(c);
    if (owned instanceof Response) return owned;

    const content = await requireContent(c);
    if (content instanceof Response) return content;

    const note = owned.store.update(
      owned.sessionId,
      c.req.param("noteId"),
      content
    );
    if (!note) {
      return c.json({ error: "Note not found" }, 404);
    }
    return c.json({ note });
  });

  /** DELETE /session-notes/:sessionId/:noteId — remove a note. */
  app.delete("/session-notes/:sessionId/:noteId", c => {
    const owned = requireOwnedSession(c);
    if (owned instanceof Response) return owned;

    const deleted = owned.store.delete(owned.sessionId, c.req.param("noteId"));
    if (!deleted) {
      return c.json({ error: "Note not found" }, 404);
    }
    return c.json({ success: true });
  });

  return app;
}
