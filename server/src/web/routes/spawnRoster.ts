// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  PmSpawnRosterPatchSchema,
  PmSpawnRosterQuerySchema,
  PmSpawnRosterUpsertSchema,
  defineCapability,
} from "@hapi/protocol";
import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";
import { cataloged } from "../../capabilities/cataloged";
import { logAndJson } from "./routeErrorHelper";

/**
 * PM spawn-roster node-local CRUD routes (issue #1936, producer for rp1-home#1054).
 *
 * Node-local write+read surface over the `pm_spawn_roster` table (#1936). Mounted
 * under `/api` AFTER the global JWT middleware in `server.ts`, so all three
 * endpoints are JWT-gated (R8). The cross-node (all-nodes) view is served
 * separately by the federation aggregate route
 * (`GET /api/federation/session-metadata/spawn-roster`).
 *
 * Dedicated route file (Decision D5): keeps `sessionMetadata.ts` read-only and
 * groups the whole `/session-metadata/spawn-roster` surface in one place, rather
 * than splitting writes into `sessions.ts` (session mutations + federation proxy) —
 * a spawn-roster row is not a session mutation.
 *
 * Fail-open (R6): each handler wraps the engine call in try/catch and returns a
 * soft 500 on failure rather than throwing — a roster write failure never crashes
 * the route or blocks the caller (at the consumer the PM's `curl` is best-effort,
 * so a 5xx never blocks a spawn). The store is synchronous + low-volume + off the
 * prompt/reply path (Decision D1), so no `TurnWriteService`-style queue is needed.
 */
export function createSpawnRosterRoutes(
  getSyncEngine: () => SyncEngine | null,
  options?: {
    errorLogger?: ErrorLogger | null;
    // Issue #2010 (Option B): federation-aware WRITE. When supplied AND the
    // spawn's nodeId is a REMOTE node, the POST proxies the upsert to that node
    // so the row lands on the spawned session's OWN node. Omitted in tests /
    // non-federated deployments → local-only write (byte-identical prior behavior).
    getNodeRegistry?: () => NodeRegistry | null;
    getLocalNodeId?: () => string | null;
  }
): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const getNodeRegistry = options?.getNodeRegistry;
  const getLocalNodeId = options?.getLocalNodeId;
  const app = new Hono<WebAppEnv>();

  function requireSyncEngine(c: {
    json: (data: unknown, status?: number) => Response;
  }): SyncEngine | Response {
    const engine = getSyncEngine();
    if (!engine) return c.json({ error: "Sync engine not available" }, 503);
    return engine;
  }

  // POST /session-metadata/spawn-roster — register a spawn (R1). Idempotent on
  // completion_token (a duplicate upserts in place).
  app.post(
    "/session-metadata/spawn-roster",
    cataloged(
      defineCapability({
        id: "session-lifecycle.register-spawn",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Register or update a PM spawn-roster row for a session spawn; idempotent on the completion token.",
        whenToUse:
          "When a project-manager session records a spawn it initiated.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/session-metadata/spawn-roster",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c);
      if (engine instanceof Response) return engine;

      const body = await c.req.json().catch(() => null);
      const parsed = PmSpawnRosterUpsertSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid spawn-roster body", details: parsed.error.issues },
          400
        );
      }

      // Issue #2010 (Option B): federation-aware WRITE. When the spawn's nodeId is a
      // REMOTE federation node, proxy the upsert there so the row lands on the
      // spawned session's OWN node — where its finalize pmReconcileStep reconciles it
      // node-locally and the hub reads completion via the existing federation
      // aggregate. Same-node (nodeId == this node) AND non-federated (no registry /
      // no local nodeId) spawns fall through to the local write below (unchanged).
      const localNodeId = getLocalNodeId?.() ?? null;
      const registry = getNodeRegistry?.() ?? null;
      if (registry && localNodeId && parsed.data.nodeId !== localNodeId) {
        // Issue #2018: membership-gate the proxy. `proxyToNode` collapses an
        // UNKNOWN nodeId (a machine UUID, a typo, any non-federation id) and a
        // KNOWN-but-offline node into the same "Node is offline" error, so an
        // unrecognized id would proxy to a phantom node → soft 500 → dropped row,
        // silently breaking V2 spawn-roster reconciliation. Decide membership here
        // (Option (i), user-approved): KNOWN remote → proxy (unchanged); UNKNOWN id
        // → warn + local-fallback write below.
        if (registry.hasNode(parsed.data.nodeId)) {
          // KNOWN remote node → proxy (R3 online; R4 known-offline → fail-open soft
          // 500, no local fallback — the row legitimately belongs on that node).
          try {
            const result = await registry.upsertSpawnRosterOnNode(
              parsed.data.nodeId,
              parsed.data
            );
            if (
              result &&
              typeof result === "object" &&
              "type" in result &&
              result.type === "error"
            ) {
              // Proxy failed (node offline / error) — fail-open soft 500. The PM's
              // curl is best-effort, so the spawn still proceeds; the row is simply
              // not registered until a later (idempotent) POST succeeds.
              return logAndJson(c, new Error(result.message), 500, {
                errorLogger,
                category: "spawn-roster",
                fallbackMessage: "spawn-roster cross-node write failed",
                severity: "error",
              });
            }
            // Receiver returns { record } — mirror the local-write response shape.
            return c.json(result, 201);
          } catch (err) {
            return logAndJson(c, err, 500, {
              errorLogger,
              category: "spawn-roster",
              fallbackMessage: "spawn-roster cross-node write failed",
              severity: "error",
            });
          }
        }
        // UNRECOGNIZED nodeId (issue #2018, R1): not localNodeId and not a known
        // federation node. Do NOT proxy to a phantom node. Warn so a genuine
        // misroute stays observable, then fall through to the local write below
        // (fail-open: capture the row rather than 500-and-drop it).
        errorLogger?.warn(
          "spawn-roster: unrecognized nodeId — writing locally (defense-in-depth #2018)",
          {
            category: "spawn-roster",
            context: {
              nodeId: parsed.data.nodeId,
              localNodeId,
              completionToken: parsed.data.completionToken,
            },
          }
        );
        // intentional fall-through to the local engine.upsertPmSpawn write below
      }

      try {
        const record = engine.upsertPmSpawn(parsed.data);
        return c.json({ record }, 201);
      } catch (err) {
        // Fail-open (R6): route through the canonical errorLogger sink (Sentry +
        // error_logs + journalctl), never throw (issue #1941, Finding 1).
        return logAndJson(c, err, 500, {
          errorLogger,
          category: "spawn-roster",
          fallbackMessage: "spawn-roster write failed",
          severity: "error",
        });
      }
    }
  );

  // PATCH /session-metadata/spawn-roster/:token — enrich ids (R2) and/or transition
  // reconciliation status (R3). At least one field is required (enforced by schema).
  app.patch(
    "/session-metadata/spawn-roster/:token",
    cataloged(
      defineCapability({
        id: "session-lifecycle.update-spawn",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "Update an existing PM spawn-roster row, keyed by its completion token.",
        whenToUse:
          "When a project-manager session revises the state of a spawn it recorded.",
        invocation: {
          kind: "rest",
          method: "PATCH",
          path: "/api/session-metadata/spawn-roster/:token",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const engine = requireSyncEngine(c);
      if (engine instanceof Response) return engine;

      const completionToken = c.req.param("token");
      const body = await c.req.json().catch(() => null);
      const parsed = PmSpawnRosterPatchSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid spawn-roster patch", details: parsed.error.issues },
          400
        );
      }

      try {
        // Accumulate affected rows across the (up to two) updates. The PATCH schema
        // requires at least one field, so at least one update always runs — a
        // combined count of 0 unambiguously means the token matched no row.
        let affected = 0;
        if (
          parsed.data.ccSessionId !== undefined ||
          parsed.data.hapiSessionId !== undefined
        ) {
          affected += engine.enrichPmSpawn({
            completionToken,
            ccSessionId: parsed.data.ccSessionId,
            hapiSessionId: parsed.data.hapiSessionId,
          });
        }
        if (parsed.data.reconciliationStatus !== undefined) {
          affected += engine.setPmSpawnStatus({
            completionToken,
            status: parsed.data.reconciliationStatus,
          });
        }
        if (affected === 0) {
          // Token matched zero rows — observable 404 instead of a green no-op
          // (issue #1941, Finding 2). Surface via errorLogger (warn: a
          // reconciliation anomaly, not an internal crash). A direct c.json keeps
          // `completionToken` in the body, which logAndJson's fixed {error} cannot.
          errorLogger?.warn("spawn-roster PATCH matched zero rows", {
            category: "spawn-roster",
            context: { completionToken },
          });
          return c.json(
            { error: "spawn-roster row not found", completionToken },
            404
          );
        }
        return c.json({ ok: true });
      } catch (err) {
        // Fail-open (R6): canonical errorLogger sink, never throw (issue #1941).
        return logAndJson(c, err, 500, {
          errorLogger,
          category: "spawn-roster",
          fallbackMessage: "spawn-roster write failed",
          severity: "error",
        });
      }
    }
  );

  // GET /session-metadata/spawn-roster?pmSessionId=&status= — node-local query (R4).
  app.get(
    "/session-metadata/spawn-roster",
    cataloged(
      defineCapability({
        id: "session-lifecycle.list-spawn-roster",
        domain: "session-lifecycle",
        surface: "rest",
        description:
          "List this node's PM spawn-roster rows for one PM session (pmSessionId query parameter, required), optionally filtered by status.",
        whenToUse:
          "When a project-manager session reviews the spawns it registered on this node.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/session-metadata/spawn-roster",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        // probe: needs ?pmSessionId= (#5212)
        probe: "skip",
      })
    ),
    c => {
      const engine = requireSyncEngine(c);
      if (engine instanceof Response) return engine;

      const parsed = PmSpawnRosterQuerySchema.safeParse({
        pmSessionId: c.req.query("pmSessionId"),
        // Empty string → undefined (no status filter), matching sessionMetadata.ts.
        status: c.req.query("status") || undefined,
      });
      if (!parsed.success) {
        return c.json(
          { error: "Invalid spawn-roster query", details: parsed.error.issues },
          400
        );
      }

      try {
        const records = engine.queryPmSpawnRoster(
          parsed.data.pmSessionId,
          parsed.data.status
        );
        return c.json({ records });
      } catch (err) {
        // Fail-open (R6): canonical errorLogger sink, never throw (issue #1941).
        return logAndJson(c, err, 500, {
          errorLogger,
          category: "spawn-roster",
          fallbackMessage: "spawn-roster query failed",
          severity: "error",
        });
      }
    }
  );

  return app;
}
