// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import {
  defineCapability,
  type FederationTelemetryNodeStatus,
  type FederationTurnAggregate,
  LOCAL_NODE_ID,
  type NodeTurnAggregates,
  NodeTurnAggregatesSchema,
  type SessionTokenTotals,
} from "@hapi/protocol";
import { createAuthMiddleware, type WebAppEnv } from "../../middleware/auth";
import { cataloged } from "../../../capabilities/cataloged";
import type { FederationDeps } from "./shared";
import { checkFederationToken } from "./shared";

/**
 * Federation-wide turn/session aggregate read path (issue #1674, epic #1662 Sub L).
 *
 *   GET  /api/federation/telemetry/aggregate  (JWT)      — client-facing aggregator:
 *        reads THIS node's v_session_totals locally + fans out to every peer node,
 *        then CONCATENATES the per-node rows into one merged set with an explicit
 *        partial-results envelope. Mirrors the usage aggregation pattern
 *        (`usage.ts` GET /federation/accounts/usage), but the merge is a pure
 *        concat (R2) — rows are node-partitioned with UUIDv7 ids, so 2+ nodes
 *        never collide (the #1663 contract), unlike usage's account-dedup.
 *   POST /api/federation/turn-aggregates  (fed-token)    — peer-incoming receiver:
 *        returns THIS node's NodeTurnAggregates. POST (not GET) because the generic
 *        `NodeRegistry.proxyToNode` only issues POST (same convention as the usage
 *        receiver). The hub reaches it via `NodeRegistry.getTurnAggregatesOnNode`.
 *
 * The GET and POST differ by method AND path: the GET carries `jwtAuth` (end-user)
 * and the POST does its own `checkFederationToken` (peer node). Reads are node-global
 * (no namespace filter) — consistent with /federation/sessions and usage (DD6; the
 * bulk-read tier in server/CLAUDE.md's three-tier authorization model).
 */

/** A per-node fan-out result the aggregator folds into the envelope. */
type NodeOutcome =
  | { ok: true; data: NodeTurnAggregates }
  | { ok: false; nodeId: string; nodeLabel: string; error: string };

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

function numQuery(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build the hub aggregate envelope (R6) from the local + remote per-node outcomes.
 * Pure + exported for unit testing (mirrors `mergeAccountUsage` in usage.ts). The
 * merge is a CONCATENATION — v_session_totals rows are node-partitioned with UUIDv7
 * ids, so 2+ nodes never collide (R2, the #1663 UUIDv7 + node_id contract).
 */
export function buildTurnAggregateEnvelope(
  outcomes: NodeOutcome[]
): FederationTurnAggregate {
  const sessionTotals: SessionTokenTotals[] = [];
  const nodes: FederationTelemetryNodeStatus[] = [];
  let answeredNodeCount = 0;
  let lastFetchedAt: number | null = null;

  for (const o of outcomes) {
    if (o.ok) {
      answeredNodeCount++;
      sessionTotals.push(...o.data.sessionTotals);
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
    sessionTotals,
    nodes,
    nodeCount: outcomes.length,
    answeredNodeCount,
    partial: answeredNodeCount < outcomes.length,
    lastFetchedAt,
  };
}

export function createFederationTelemetryRoutes(
  deps: FederationDeps
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const jwtAuth = createAuthMiddleware(deps.jwtSecret);

  // ─── Node-to-node receiver: POST /federation/turn-aggregates (fed-token) ──
  app.post(
    "/federation/turn-aggregates",
    cataloged(
      defineCapability({
        id: "telemetry.federation-turn-aggregates",
        domain: "telemetry",
        surface: "rest",
        description:
          "Return this node's per-session turn/token aggregate rows (POST because the node proxy only issues POST).",
        whenToUse:
          "When the hub gathers a peer node's telemetry aggregates for the cross-node totals view.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/federation/turn-aggregates",
        },
        auth: "federation-token",
        riskTier: "mutating",
        availability: { scope: "operator" },
        telemetry: "off",
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
      const opts = {
        fromMs: typeof body.fromMs === "number" ? body.fromMs : undefined,
        toMs: typeof body.toMs === "number" ? body.toMs : undefined,
        limit: typeof body.limit === "number" ? body.limit : undefined,
      };

      const result: NodeTurnAggregates = {
        nodeId: config.nodeId,
        nodeLabel: config.nodeLabel,
        sessionTotals: engine.getSessionTotalsAggregate(opts),
        fetchedAt: Date.now(),
      };
      return c.json(result);
    }
  );

  // ─── Web client endpoint: GET /federation/telemetry/aggregate (JWT, HUB) ──
  app.get(
    "/federation/telemetry/aggregate",
    cataloged(
      defineCapability({
        id: "telemetry.federation-aggregate",
        domain: "telemetry",
        surface: "rest",
        description:
          "Aggregate per-session turn/token totals across the whole mesh: reads this node's rows and fans out to every peer, returning a merged partial-results set.",
        whenToUse:
          "When the web UI shows token or turn analytics spanning all federation nodes.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/federation/telemetry/aggregate",
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
      const opts = {
        fromMs: numQuery(c.req.query("from")),
        toMs: numQuery(c.req.query("to")),
        limit: numQuery(c.req.query("limit")),
      };
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
              sessionTotals: engine.getSessionTotalsAggregate(opts),
              fetchedAt: Date.now(),
            },
          });
        } catch (err) {
          // Local failure is non-fatal — degrade to remote-only (R3).
          outcomes.push({
            ok: false,
            nodeId: localId,
            nodeLabel: localLabel,
            error: errMsg(err),
          });
        }
      }

      // Remote nodes — concurrent, partial-success (R3).
      if (registry) {
        const summaries = registry.getNodeSummaries();
        const results = await Promise.allSettled(
          summaries.map(s => registry.getTurnAggregatesOnNode(s.nodeId, opts))
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
          const parsed = NodeTurnAggregatesSchema.safeParse(v);
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

      return c.json(buildTurnAggregateEnvelope(outcomes));
    }
  );

  return app;
}
