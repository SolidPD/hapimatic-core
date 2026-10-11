// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  RecordFootprintRequestSchema,
  AddActiveClaimRequestSchema,
  ReleaseClaimQuerySchema,
  FileClaimQuerySchema,
  FileClaimHistoryQuerySchema,
  defineCapability,
} from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import type { Store } from "../../store";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { createRateLimiter } from "../middleware/rateLimit";
import { logAndJson } from "./routeErrorHelper";
import { filterClaimsToLiveSessions } from "../../store/fileClaimLifecycle";
import type {
  FileClaimSync,
  NodeTaggedClaim,
} from "../../federation/fileClaimSync";

/**
 * Epic #1965 (File Conflict Monitor) Sub B / #1967 — file-claim write/release/
 * query API over the #1966 `store.fileClaims` store.
 *
 * Store-direct (observe-first MVP, Key Decision D1) — no SyncEngine/SSE wiring
 * until the live-UI consumer (#1971) and federation sync (#1969) land. Claims
 * are node-global (D2): the route may read `c.get("namespace")` for logging but
 * MUST NOT filter by it — FCM's whole purpose is cross-session "who else claims
 * path X" visibility (#1966's table has no `namespace` column).
 *
 * Mounted under `/api` AFTER the JWT auth middleware in `server.ts`, so R6's 401
 * gating comes from the global middleware. The rate limiter is instantiated
 * INSIDE the factory so each call (including tests) gets a fresh bucket map.
 */
export function createFileClaimsRoutes(
  getStore: () => Store | null,
  options?: {
    errorLogger?: ErrorLogger | null;
    /**
     * #1968 (R4): returns the set of live session ids/tags, or null when the
     * SyncEngine is unavailable (startup/degraded → fail-open, skip the filter).
     * An EMPTY set means "engine present, no live sessions" → filter to [].
     */
    getLiveSessionIds?: () => Set<string> | null;
    /**
     * #1969 (R1): fired after every successful claim mutation (footprint /
     * active-add / active-release). Wired to `SyncEngine.emitFileClaimDelta()` so
     * a local claim change publishes a `file-claim-delta` to peers. Fail-soft — a
     * null engine at startup simply skips the emit (the anti-entropy poll backs
     * it up). This callback is the route's ONLY sync coupling (it stays
     * store-direct otherwise).
     */
    onClaimsChanged?: () => void;
    /**
     * #1969 (R5): the federation claim-sync replica, for the cross-node "who
     * claims (repo, path)" union. Null / absent → local-only results (standalone
     * node or startup). Optional per the `getLeaseStore?` convention so it never
     * breaks the route's test stubs.
     */
    getFileClaimSync?: () => FileClaimSync | null;
  }
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const errorLogger = options?.errorLogger ?? null;
  const getLiveSessionIds = options?.getLiveSessionIds;
  const onClaimsChanged = options?.onClaimsChanged;
  const getFileClaimSync = options?.getFileClaimSync;
  const limiter = createRateLimiter({ name: "file-claims" }); // env default 100/60s

  function requireStore(c: {
    json: (data: unknown, status?: number) => Response;
  }): Store | Response {
    const store = getStore();
    if (!store) return c.json({ error: "Store not available" }, 503);
    return store;
  }

  // R1 — POST /file-claims/footprint : replace this session's `expected` set for `repo`.
  app.post(
    "/file-claims/footprint",
    cataloged(
      defineCapability({
        id: "files-git.file-claims-footprint",
        domain: "files-git",
        surface: "rest",
        description:
          "Replace this session's predicted file-claim footprint (the expected set) for a repo.",
        whenToUse: "When a skill declares which files it is about to touch.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/file-claims/footprint",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = RecordFootprintRequestSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      try {
        const { sessionId, repo, claims: incoming } = parsed.data;
        // Replace = release this session's prior live `expected` claims for the
        // repo (leaving `active` claims untouched), then insert the submitted set.
        store.fileClaims.releaseClaims(sessionId, {
          claimType: "expected",
          repo,
        });
        const claims = incoming.map(cl =>
          store.fileClaims.insertClaim({
            sessionId,
            repo,
            path: cl.path,
            changeKind: cl.changeKind,
            claimType: "expected",
          })
        );
        onClaimsChanged?.(); // #1969 (R1): publish the new snapshot to peers.
        return c.json({ claims }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "file-claims",
          fallbackMessage: "Failed to record footprint",
        });
      }
    }
  );

  // R2 — POST /file-claims/active : add one active claim.
  app.post(
    "/file-claims/active",
    cataloged(
      defineCapability({
        id: "files-git.file-claims-active-set",
        domain: "files-git",
        surface: "rest",
        description:
          "Register one in-flight active file claim for the session.",
        whenToUse: "When a worker begins editing a specific file.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/file-claims/active",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    limiter,
    async c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = AddActiveClaimRequestSchema.safeParse(
        await c.req.json().catch(() => null)
      );
      if (!parsed.success)
        return c.json(
          { error: "Invalid body", details: parsed.error.issues },
          400
        );
      try {
        const claim = store.fileClaims.insertClaim({
          ...parsed.data,
          claimType: "active",
        });
        onClaimsChanged?.(); // #1969 (R1): publish the new snapshot to peers.
        return c.json({ claim }, 201);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "file-claims",
          fallbackMessage: "Failed to add active claim",
        });
      }
    }
  );

  // R3 — DELETE /file-claims/active : release this session's active claims (± path).
  app.delete(
    "/file-claims/active",
    cataloged(
      defineCapability({
        id: "files-git.file-claims-active-release",
        domain: "files-git",
        surface: "rest",
        description:
          "Release the session's active file claims (optionally one path).",
        whenToUse: "When a worker finishes editing and drops its claims.",
        invocation: {
          kind: "rest",
          method: "DELETE",
          path: "/api/file-claims/active",
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
      const parsed = ReleaseClaimQuerySchema.safeParse({
        sessionId: c.req.query("sessionId"),
        path: c.req.query("path"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const released = store.fileClaims.releaseClaims(parsed.data.sessionId, {
          claimType: "active",
          ...(parsed.data.path ? { path: parsed.data.path } : {}),
        });
        onClaimsChanged?.(); // #1969 (R1): publish the new snapshot to peers.
        return c.json({ released }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "file-claims",
          fallbackMessage: "Failed to release claim",
        });
      }
    }
  );

  // #2815 — GET /file-claims/history : historical overlapping-window conflict
  // pairs. SIBLING of the live-only R4 GET below (KD1) — released claims are
  // the whole point here, so there is deliberately NO live-session filter
  // (history is about ended sessions) and NO churn filter (constraint-C
  // symmetry: the web client churn-filters, mirroring the live GET's
  // contract). Rate-limited with an EXPLICIT 30/60s bucket — a documented
  // deviation from the mutating-only convention (#1099): this is the costliest
  // query on the table, and an explicit limit resists env-var loosening.
  const historyLimiter = createRateLimiter({
    name: "file-claims-history",
    limit: 30,
    windowMs: 60_000,
  });
  app.get(
    "/file-claims/history",
    cataloged(
      defineCapability({
        id: "files-git.file-claims-history",
        domain: "files-git",
        surface: "rest",
        description:
          "Return the recent file-claim history for conflict analysis.",
        whenToUse: "When the conflict monitor renders who touched a path.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/file-claims/history",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    historyLimiter,
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = FileClaimHistoryQuerySchema.safeParse({
        days: c.req.query("days"),
        limit: c.req.query("limit"),
        repo: c.req.query("repo"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const { days, limit, repo } = parsed.data;
        const sinceMs = Date.now() - days * 86_400_000;
        const conflicts = store.fileClaims.getConflictHistory({
          sinceMs,
          limit,
          ...(repo !== undefined ? { repo } : {}),
        });
        return c.json({ conflicts }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "file-claims",
          fallbackMessage: "Failed to query conflict history",
        });
      }
    }
  );

  // R4 — GET /file-claims?repo&path | repo | sessionId : LIVE claims only.
  app.get(
    "/file-claims",
    cataloged(
      defineCapability({
        id: "files-git.file-claims-list",
        domain: "files-git",
        surface: "rest",
        description:
          "List the current active + expected file claims across live sessions.",
        whenToUse: "When a session checks who else is about to touch a file.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/file-claims",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const store = requireStore(c);
      if (store instanceof Response) return store;
      const parsed = FileClaimQuerySchema.safeParse({
        path: c.req.query("path"),
        repo: c.req.query("repo"),
        sessionId: c.req.query("sessionId"),
      });
      if (!parsed.success)
        return c.json(
          { error: "Invalid query", details: parsed.error.issues },
          400
        );
      try {
        const { path, repo, sessionId } = parsed.data;
        // All modes return LIVE claims only (released_at IS NULL):
        //  - repo + path → getClaimsByPath (live-only default; index-backed on (repo,path))
        //  - repo alone  → getLiveClaims filtered by repo (no repo-only store index)
        //  - sessionId   → getClaimsBySession with includeReleased:false (its default is TRUE!)
        const claims =
          repo && path
            ? store.fileClaims.getClaimsByPath(repo, path)
            : repo
              ? store.fileClaims.getLiveClaims().filter(cl => cl.repo === repo)
              : store.fileClaims.getClaimsBySession(sessionId!, {
                  includeReleased: false,
                });
        // #1968 (R4): filter out claims whose OWNING SESSION is not live. A
        // crashed session's unreleased claims are still `released_at IS NULL`, so
        // "live" (not-released) is NOT enough — the owning session must also be
        // live. null live-set → engine unavailable → fail-open (return as-is); an
        // empty set correctly filters everything out.
        const liveIds = getLiveSessionIds?.() ?? null;
        const visible = liveIds
          ? filterClaimsToLiveSessions(claims, liveIds)
          : claims;

        // #1969 (R5): for the mesh "who claims (repo, path)" query, union the local
        // live claims with every live peer's replicated claims for that (repo, path),
        // de-duped by claim id (ids are globally unique per node, so local ∪ replica
        // are disjoint — the de-dup is defensive). Each claim is tagged with its
        // source nodeId (local claims with THIS node's id, replica claims by their
        // owner) so #1971 can render a "sessions + node" column. The repo-alone and
        // sessionId-alone modes stay local-only for v1 (the mesh query is (repo,
        // path)-scoped, matching #1971's consumer).
        const sync = repo && path ? (getFileClaimSync?.() ?? null) : null;
        if (sync) {
          const ownNodeId = sync.getOwnNodeId();
          const byId = new Map<string, NodeTaggedClaim>();
          for (const cl of visible)
            byId.set(cl.id, { ...cl, nodeId: ownNodeId });
          for (const cl of sync.getClaimsByPath(repo!, path!)) {
            if (!byId.has(cl.id)) byId.set(cl.id, cl);
          }
          return c.json({ claims: [...byId.values()] }, 200);
        }
        return c.json({ claims: visible }, 200);
      } catch (error) {
        return logAndJson(c, error, 500, {
          errorLogger,
          category: "file-claims",
          fallbackMessage: "Failed to query claims",
        });
      }
    }
  );

  return app;
}
