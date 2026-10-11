// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  defineCapability,
  type FederationPmSpawnRoster,
  type FederationTelemetryNodeStatus,
  LOCAL_NODE_ID,
  type NodePmSpawnRoster,
  NodePmSpawnRosterSchema,
  type PmSpawnReconciliationStatus,
  type PmSpawnRosterRecord,
  PmSpawnRosterUpsertSchema,
} from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";

/**
 * Federation-wide PM spawn-roster read path (issue #1936, producer for rp1-home#1054).
 *
 *   GET  /api/federation/session-metadata/spawn-roster  (JWT) — hub aggregator:
 *        reads THIS node's roster locally + fans out to every peer node, then
 *        CONCATENATES the per-node rows into one merged set with an explicit
 *        partial-results envelope. Models federation/telemetry.ts's
 *        GET /federation/telemetry/aggregate (Sub L, #1674).
 *   POST /api/federation/spawn-roster-query  (fed-token) — peer-incoming receiver:
 *        returns THIS node's roster rows for the queried PM. POST (not GET) because
 *        the generic NodeRegistry.proxyToNode only issues POST. The hub reaches it
 *        via NodeRegistry.getSpawnRosterOnNode.
 *
 * The GET carries jwtAuth (end-user); the POST does its own checkFederationToken
 * (peer node). Reads are node-global (no namespace filter) — consistent with
 * /federation/telemetry/aggregate and the documented bulk-read authorization tier.
 *
 * Collision-free merge (D2): a given completion_token's row lives on exactly one
 * node (the PM writes to its own node; node_id tags the SPAWNED session's node).
 * Each row carries a per-node-minted UUIDv7 id, so the cross-node merge is a pure
 * CONCATENATION with zero id collisions — simpler than usage's account-dedup.
 */

/** A per-node fan-out result the aggregator folds into the envelope. */
type NodeOutcome =
  | { ok: true; data: NodePmSpawnRoster }
  | { ok: false; nodeId: string; nodeLabel: string; error: string };

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Build the hub aggregate envelope from the local + remote per-node outcomes.
 * Pure + exported for unit testing (mirrors buildTurnAggregateEnvelope). The
 * merge is a CONCATENATION — pm_spawn_roster rows are node-partitioned with
 * UUIDv7 ids, so 2+ nodes never collide.
 */
export function buildSpawnRosterEnvelope(
  outcomes: NodeOutcome[]
): FederationPmSpawnRoster {
  const records: PmSpawnRosterRecord[] = [];
  const nodes: FederationTelemetryNodeStatus[] = [];
  let answeredNodeCount = 0;
  let lastFetchedAt: number | null = null;

  for (const o of outcomes) {
    if (o.ok) {
      answeredNodeCount++;
      records.push(...o.data.records);
      lastFetchedAt =
        lastFetchedAt === null
          ? o.data.fetchedAt
          : Math.max(lastFetchedAt, o.data.fetchedAt);
      nodes.push({
        nodeId: o.data.nodeId,
        nodeLabel: o.data.nodeLabel,
        answered: true,
        fetchedAt: o.data.fetchedAt,
      });
    } else {
      nodes.push({
        nodeId: o.nodeId,
        nodeLabel: o.nodeLabel,
        answered: false,
        fetchedAt: null,
        error: o.error,
      });
    }
  }

  return {
    records,
    nodes,
    nodeCount: outcomes.length,
    answeredNodeCount,
    partial: answeredNodeCount < outcomes.length,
    lastFetchedAt,
  };
}

export function createFederationSpawnRosterRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);

  // ─── Node-to-node receiver: POST /federation/spawn-roster-query (fed-token) ──
  app.post(
    "/federation/spawn-roster-query",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-spawn-roster-query",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Return this node's PM spawn-roster rows for a queried manager session (POST because the node proxy only issues POST).",
        whenToUse:
          "When the hub gathers a manager's spawn-roster rows from a specific peer node.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/spawn-roster-query",
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
      const config = deps.federationConfig;
      if (!config) {
        return c.json({ error: "Federation not enabled" }, 503);
      }
      const engine = deps.getSyncEngine();
      if (!engine) {
        return c.json({ error: "Not connected" }, 503);
      }

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const pmSessionId =
        typeof body.pmSessionId === "string" ? body.pmSessionId : "";
      const status =
        typeof body.status === "string"
          ? (body.status as PmSpawnReconciliationStatus)
          : undefined;

      if (!pmSessionId) {
        return c.json({ error: "pmSessionId required" }, 400);
      }

      const result: NodePmSpawnRoster = {
        nodeId: config.nodeId,
        nodeLabel: config.nodeLabel,
        records: engine.queryPmSpawnRoster(pmSessionId, status),
        fetchedAt: Date.now(),
      };
      return c.json(result);
    }
  );

  // ─── Node-to-node receiver: POST /federation/spawn-roster-upsert (fed-token) ──
  // Issue #2010 (Option B — federation-aware WRITE). The hub proxies a cross-node
  // spawn registration here (NodeRegistry.upsertSpawnRosterOnNode) so the row lands
  // on the spawned session's OWN node, where its finalize pmReconcileStep reconciles
  // it node-locally. Writes via engine.upsertPmSpawn (the LOCAL write) — NOT the
  // federation-aware POST route — so there is no re-proxy loop. Returns { record },
  // mirroring the node-local POST route's response shape.
  app.post(
    "/federation/spawn-roster-upsert",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-spawn-roster-upsert",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Upsert a PM spawn-roster row on this node (the spawned session's own node) so it reconciles node-locally.",
        whenToUse:
          "When the hub registers a cross-node spawn on the node that owns the spawned session.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/spawn-roster-upsert",
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

      const body = await c.req.json().catch(() => null);
      const parsed = PmSpawnRosterUpsertSchema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          { error: "Invalid spawn-roster body", details: parsed.error.issues },
          400
        );
      }

      try {
        const record = engine.upsertPmSpawn(parsed.data);
        return c.json({ record }, 201);
      } catch (err) {
        // Fail-open: a roster write failure never crashes the receiver (mirrors the
        // node-local POST route's contract). The proxying hub maps a non-2xx to its
        // own soft 500.
        return c.json(
          {
            error:
              err instanceof Error ? err.message : "spawn-roster upsert failed",
          },
          500
        );
      }
    }
  );

  // ─── Web client endpoint: GET /federation/session-metadata/spawn-roster (JWT, HUB) ──
  app.get(
    "/federation/session-metadata/spawn-roster",
    cataloged(
      defineCapability({
        id: "session-introspection.federation-spawn-roster-aggregate",
        domain: "session-introspection",
        surface: "rest",
        description:
          "Aggregate a manager session's PM spawn-roster across the whole mesh: reads this node's rows and fans out to every peer, returning a merged partial-results set.",
        whenToUse:
          "When the web UI shows a project-manager session's spawn roster spanning all federation nodes.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/session-metadata/spawn-roster",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
        telemetry: "off",
      })
    ),
    jwtAuth,
    async c => {
      const engine = deps.getSyncEngine();
      const registry = deps.getNodeRegistry();
      const config = deps.federationConfig;

      const pmSessionId = c.req.query("pmSessionId") ?? "";
      if (!pmSessionId) {
        return c.json({ error: "pmSessionId required" }, 400);
      }
      const statusRaw = c.req.query("status");
      const status =
        statusRaw && statusRaw.length > 0
          ? (statusRaw as PmSpawnReconciliationStatus)
          : undefined;

      const outcomes: NodeOutcome[] = [];

      // Local node first (the hub is itself a node; NOT in getNodeSummaries()).
      if (engine) {
        const localId = config?.nodeId ?? LOCAL_NODE_ID;
        const localLabel = config?.nodeLabel ?? LOCAL_NODE_ID;
        try {
          outcomes.push({
            ok: true,
            data: {
              nodeId: localId,
              nodeLabel: localLabel,
              records: engine.queryPmSpawnRoster(pmSessionId, status),
              fetchedAt: Date.now(),
            },
          });
        } catch (err) {
          // Local failure is non-fatal — degrade to remote-only.
          outcomes.push({
            ok: false,
            nodeId: localId,
            nodeLabel: localLabel,
            error: errMsg(err),
          });
        }
      }

      // Remote nodes — concurrent, partial-success.
      if (registry) {
        const summaries = registry.getNodeSummaries();
        const results = await Promise.allSettled(
          summaries.map(s =>
            registry.getSpawnRosterOnNode(s.nodeId, { pmSessionId, status })
          )
        );
        results.forEach((r, i) => {
          const s = summaries[i]!;
          if (r.status === "rejected") {
            outcomes.push({
              ok: false,
              nodeId: s.nodeId,
              nodeLabel: s.nodeLabel,
              error: errMsg(r.reason),
            });
            return;
          }
          const v = r.value;
          if (v && typeof v === "object" && "type" in v) {
            // proxyToNode error shape: { type: "error", message }
            outcomes.push({
              ok: false,
              nodeId: s.nodeId,
              nodeLabel: s.nodeLabel,
              error:
                typeof (v as { message?: unknown }).message === "string"
                  ? (v as { message: string }).message
                  : "Node returned an error",
            });
            return;
          }
          // Re-parse the cross-boundary payload as a defense-in-depth shape guard.
          const parsed = NodePmSpawnRosterSchema.safeParse(v);
          if (parsed.success) {
            outcomes.push({ ok: true, data: parsed.data });
          } else {
            outcomes.push({
              ok: false,
              nodeId: s.nodeId,
              nodeLabel: s.nodeLabel,
              error: "Malformed node response",
            });
          }
        });
      }

      return c.json(buildSpawnRosterEnvelope(outcomes));
    }
  );

  return app;
}
