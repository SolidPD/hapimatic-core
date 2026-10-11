// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import {
  CreateInitiativeRequestSchema,
  UpdateInitiativeRequestSchema,
  AttachSessionRequestSchema,
  InitiativeQuerySchema,
  QueueDrainQuerySchema,
  type QueueHealth,
  defineCapability,
} from "@hapi/protocol";
import type { Store } from "../../store";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { WebhookGapDetector } from "../../workflow/webhookGapDetector";
import { createRateLimiter } from "../middleware/rateLimit";
import { logAndJson } from "./routeErrorHelper";
import { cataloged } from "../../capabilities/cataloged";

/**
 * The `epic:owner/repo#N` scope's repo (`owner/repo`), or `null` for scopes
 * with no repo-unique prefix (`milestone:` / `project:`). #2157's drain
 * queue-health is keyed by repo (the webhook-health / gap-detection unit).
 */
function repoFromScopeRef(scopeRef: string): string | null {
  if (scopeRef.startsWith("epic:")) {
    return scopeRef.slice("epic:".length).split("#")[0] || null;
  }
  return null;
}

/** Conservative default when no gap detector is wired (or the repo is unknown):
 * poll is the trusted freshness path. R8 means this never changes a gate. */
const DEFAULT_QUEUE_HEALTH: QueueHealth = {
  webhooksHealthy: false,
  lastDeliveryAtMs: null,
  gapDetected: false,
  mode: "poll-fallback",
};

/**
 * Skill-revamp 3.1 (#2156, epic rp1-home#1319) — CRUD + roster/phase/event API
 * over the `store.initiatives` store. The initiative is a CACHE over GitHub label
 * truth (reconcile-on-read; GitHub wins on every conflict), never authoritative.
 *
 * Store-direct (like fileClaims/predictionAccuracy) — no SyncEngine/SSE wiring
 * for this MVP. Initiatives are node-global (an initiative spans sessions by
 * definition), so the route MUST NOT filter by `c.get("namespace")` — same
 * reasoning as file-claims.
 *
 * Mounted under `/api` AFTER the JWT auth middleware in `server.ts`, so auth
 * gating comes from the global middleware. The rate limiter is instantiated
 * INSIDE the factory so each call (including tests) gets a fresh bucket map.
 *
 * 🔴 R4 (append-only) is enforced by ABSENCE: there is deliberately NO
 * `PATCH /initiatives/:id/events/:eventId` and NO `DELETE …/events/:eventId`
 * route. Recorded events cannot be mutated or deleted through the API surface;
 * this is covered by the route test asserting 404 on those verbs. The store has
 * no `updateEvent`/`deleteEvent` method either, so the invariant is structural.
 */
export function createInitiativesRoutes(
  getStore: () => Store | null,
  options?: {
    errorLogger?: ErrorLogger | null;
    /**
     * Skill-revamp 3.2 (#2157): the drain endpoint's queue-health source. When
     * absent (feature off / not wired / tests), the drain returns a conservative
     * poll-fallback verdict. Late-bound so index.ts wires it after construction.
     */
    getWebhookGapDetector?: () => WebhookGapDetector | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = options?.errorLogger ?? null;
  const getWebhookGapDetector = options?.getWebhookGapDetector;
  const limiter = createRateLimiter({ name: "initiatives" }); // env default 100/60s

  function requireStore(c: {
    json: (data: unknown, status?: number) => Response;
  }): Store | Response {
    const store = getStore();
    if (!store) return c.json({ error: "Store not available" }, 503);
    return store;
  }

  // Read-side query: `limit` bounds the one-call read's events; `staleAfterMs` is
  // the freshness bound (omitted ⇒ no staleness computed → stale: null).
  const ReadQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
    staleAfterMs: z.coerce.number().optional(),
  });
  const EventsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).optional(),
  });

  // POST /initiatives — create (R1).
  app.post(
    "/initiatives",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-create",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Create a long-horizon initiative record (an orchestrator's roster, token budget, and phase) that caches PM state over GitHub label truth.",
        whenToUse:
          "When starting a multi-session initiative that needs roster, budget, and phase tracking.",
        invocation: { kind: "rest", method: "POST", path: "/api/initiatives" },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example:
          '{"scopeRef":"epic:owner/repo#123","phase":"planning","tokenBudget":500000}',
      })
    ),
    limiter,
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = CreateInitiativeRequestSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      try {
        const initiative = store.initiatives.create(parsed.data);
        return c.json({ initiative }, 201);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to create initiative",
        });
      }
    }
  );

  // GET /initiatives — list, optionally filtered by scopeRef / phase.
  app.get(
    "/initiatives",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-list",
        domain: "harness-admin",
        surface: "rest",
        description:
          "List initiative records, optionally filtered by scope reference or phase.",
        whenToUse: "When the user wants to see the active initiatives.",
        invocation: { kind: "rest", method: "GET", path: "/api/initiatives" },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = InitiativeQuerySchema.safeParse({
        scopeRef: c.req.query("scopeRef"),
        phase: c.req.query("phase"),
        staleAfterMs: c.req.query("staleAfterMs"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const initiatives = store.initiatives.list({
          ...(parsed.data.scopeRef ? { scopeRef: parsed.data.scopeRef } : {}),
          ...(parsed.data.phase ? { phase: parsed.data.phase } : {}),
        });
        return c.json({ initiatives }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to list initiatives",
        });
      }
    }
  );

  // GET /initiatives/:id — R3 ONE-CALL READ: roster + budget + phase + the N most
  // recent events + staleness, in a single response.
  app.get(
    "/initiatives/:id",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-get",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Read one initiative in a single call: its roster, token budget, phase, the most recent events, and staleness.",
        whenToUse: "When the user opens an initiative's detail view.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/initiatives/:id",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = ReadQuerySchema.safeParse({
        limit: c.req.query("limit"),
        staleAfterMs: c.req.query("staleAfterMs"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const id = c.req.param("id");
        const initiative = store.initiatives.get(id);
        if (!initiative) return c.json({ error: "Initiative not found" }, 404);
        const events = store.initiatives.recentEvents(
          id,
          parsed.data.limit ?? 50
        );
        const stale =
          parsed.data.staleAfterMs === undefined
            ? null
            : store.initiatives.isStale(initiative, parsed.data.staleAfterMs);
        return c.json({ initiative, events, stale }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to read initiative",
        });
      }
    }
  );

  // PATCH /initiatives/:id — phase and/or budget ONLY. Never events (R4): these
  // route to setPhase / setBudget so the corresponding events fire.
  app.patch(
    "/initiatives/:id",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-update",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Update an initiative's phase and/or token budget; each change fires its own event. Never edits the event log.",
        whenToUse:
          "When advancing an initiative's phase or adjusting its token budget.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/initiatives/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"phase":"active","tokenBudget":800000}',
      })
    ),
    limiter,
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = UpdateInitiativeRequestSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      try {
        const id = c.req.param("id");
        if (!store.initiatives.get(id))
          return c.json({ error: "Initiative not found" }, 404);
        if (parsed.data.phase !== undefined) {
          store.initiatives.setPhase(id, parsed.data.phase);
        }
        if (
          parsed.data.tokenBudget !== undefined ||
          parsed.data.tokensSpent !== undefined
        ) {
          // Preserve the existing cap when only tokensSpent is supplied.
          const current = store.initiatives.get(id)!;
          const budget =
            parsed.data.tokenBudget !== undefined
              ? parsed.data.tokenBudget
              : current.tokenBudget;
          store.initiatives.setBudget(id, budget, parsed.data.tokensSpent);
        }
        return c.json({ initiative: store.initiatives.get(id) }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to update initiative",
        });
      }
    }
  );

  // DELETE /initiatives/:id — remove the initiative + its roster + its events.
  app.delete(
    "/initiatives/:id",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-delete",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Delete an initiative together with its roster and its entire event log. Irreversible.",
        whenToUse: "When permanently removing an initiative.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/initiatives/:id",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      try {
        const deleted = store.initiatives.delete(c.req.param("id"));
        if (!deleted) return c.json({ error: "Initiative not found" }, 404);
        return c.json({ deleted: true }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to delete initiative",
        });
      }
    }
  );

  // POST /initiatives/:id/sessions — attach a session (R2: roster + event).
  app.post(
    "/initiatives/:id/sessions",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-attach-session",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Attach a session to an initiative's roster and record the attach event.",
        whenToUse: "When enrolling a running session into an initiative.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/initiatives/:id/sessions",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
        example: '{"sessionId":"hapi-1789740033133-81qd8bse"}',
      })
    ),
    limiter,
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = AttachSessionRequestSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      try {
        const id = c.req.param("id");
        if (!store.initiatives.get(id))
          return c.json({ error: "Initiative not found" }, 404);
        store.initiatives.attachSession(id, parsed.data.sessionId);
        return c.json({ initiative: store.initiatives.get(id) }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to attach session",
        });
      }
    }
  );

  // DELETE /initiatives/:id/sessions/:sessionId — detach a session (R2: roster + event).
  app.delete(
    "/initiatives/:id/sessions/:sessionId",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-detach-session",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Remove a session from an initiative's roster and record the detach event.",
        whenToUse: "When removing a session from an initiative.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/initiatives/:id/sessions/:sessionId",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      try {
        const id = c.req.param("id");
        if (!store.initiatives.get(id))
          return c.json({ error: "Initiative not found" }, 404);
        store.initiatives.detachSession(id, c.req.param("sessionId"));
        return c.json({ initiative: store.initiatives.get(id) }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to detach session",
        });
      }
    }
  );

  // POST /initiatives/:id/reconcile — mark reconciled against GitHub truth (R5).
  app.post(
    "/initiatives/:id/reconcile",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-reconcile",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Mark an initiative reconciled against GitHub's authoritative label state and stamp the reconcile time.",
        whenToUse: "After syncing an initiative's cached state with GitHub.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/initiatives/:id/reconcile",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      try {
        const id = c.req.param("id");
        if (!store.initiatives.get(id))
          return c.json({ error: "Initiative not found" }, 404);
        store.initiatives.markReconciled(id);
        return c.json({ initiative: store.initiatives.get(id) }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to reconcile initiative",
        });
      }
    }
  );

  // GET /initiatives/:id/events — read-only paginated event log. (There is NO
  // PATCH/DELETE counterpart — R4 append-only is enforced by that absence.)
  app.get(
    "/initiatives/:id/events",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-events",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Read an initiative's append-only event log, most recent first, bounded by an optional limit.",
        whenToUse: "When reviewing what has happened on an initiative.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/initiatives/:id/events",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = EventsQuerySchema.safeParse({
        limit: c.req.query("limit"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const id = c.req.param("id");
        if (!store.initiatives.get(id))
          return c.json({ error: "Initiative not found" }, 404);
        const events = store.initiatives.recentEvents(
          id,
          parsed.data.limit ?? 50
        );
        return c.json({ events }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to read events",
        });
      }
    }
  );

  // GET /initiatives/:id/drain — Skill-revamp 3.2 (#2157) — the PM tick's ONE
  // call (R5): events newer than the cursor + the next cursor + the queue-health
  // verdict, together. R5's cheap no-op tick is `events: []` PLUS a healthy
  // `queueHealth`, reached WITHOUT any transcript read or (when webhooks are
  // healthy) any GitHub poll — the store drain is an indexed `id > cursor` query
  // and the queue-health read is in-process. On a GENUINE gap the detector
  // fire-and-forgets a reconcile (R6) — never awaited here, so the drain stays
  // cheap. 🔴 R8: `queueHealth` is a FRESHNESS hint, never a gate verdict.
  app.get(
    "/initiatives/:id/drain",
    cataloged(
      defineCapability({
        id: "harness-admin.initiatives-drain",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return initiative events newer than a cursor plus the next cursor and a queue-health hint; fire-and-forgets a reconcile on a detected webhook gap.",
        whenToUse:
          "When a PM tick polls an initiative for new events and queue health.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/initiatives/:id/drain",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        probe: "skip",
      })
    ),
    limiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = QueueDrainQuerySchema.safeParse({
        sinceEventId: c.req.query("sinceEventId"),
        limit: c.req.query("limit"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const id = c.req.param("id");
        const initiative = store.initiatives.get(id);
        if (!initiative) return c.json({ error: "Initiative not found" }, 404);

        const { events, nextCursor } = store.initiatives.drain(
          id,
          parsed.data.sinceEventId,
          parsed.data.limit ?? 100
        );

        // Queue-health verdict (R6) — evaluate() fire-and-forgets a reconcile on a
        // genuine gap. Falls back to the conservative default when no detector is
        // wired or the scope has no repo-unique prefix.
        const detector = getWebhookGapDetector?.() ?? null;
        const repo = repoFromScopeRef(initiative.scopeRef);
        const queueHealth: QueueHealth =
          detector && repo ? detector.evaluate(repo) : DEFAULT_QUEUE_HEALTH;

        return c.json({ events, nextCursor, queueHealth }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "initiatives",
          fallbackMessage: "Failed to drain initiative queue",
        });
      }
    }
  );

  return app;
}
