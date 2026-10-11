// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { SessionTokenTotalsSchema } from "./schemas";

// Federation-wide turn/session aggregate read path (issue #1674, epic #1662 Sub L).
//
// Two contracts live here:
//   1. NodeTurnAggregates — the per-node payload. The fed-token receiver
//      POST /api/federation/turn-aggregates returns it; the hub aggregator
//      GET /api/federation/telemetry/aggregate fans these in. Models the
//      node-receiver shape of /federation/sessions (node-tagged rows + fetchedAt),
//      but carries v_session_totals rollups instead of session summaries.
//   2. FederationTurnAggregate — the hub envelope. Its field shape is modeled on
//      FederationHealthAggregate (nodeCount / answeredNodeCount / lastFetchedAt)
//      PLUS a request-scoped partial-results indicator + per-node liveness array,
//      because — unlike the poll-cached health aggregate — this is a query-time
//      fan-out with no prior partial-results precedent (R6).
//
// Collision-free merge (R2): v_session_totals rows are node-partitioned (each row
// carries node_id) with UUIDv7 ids, and a hapi_session_id lives on exactly one node.
// So the cross-node merge is a pure CONCATENATION — there are zero id collisions by
// construction (the #1663 UUIDv7 + node_id contract, cited as a hard dependency, not
// assumed). This is simpler than federationTelemetry's sibling federation/usage.ts,
// where the same account can appear on multiple nodes and must be deduped.

/**
 * Per-node turn/session aggregate payload (the receiver's response body).
 * `sessionTotals` are this node's full v_session_totals rows; each already carries
 * its own `nodeId`, so the hub never re-tags them.
 */
export const NodeTurnAggregatesSchema = z
  .object({
    nodeId: z.string(),
    nodeLabel: z.string(),
    sessionTotals: z.array(SessionTokenTotalsSchema),
    /** Epoch ms when this node read its view (staleness signal for R3/R6). */
    fetchedAt: z.number(),
  })
  .passthrough();
export type NodeTurnAggregates = z.infer<typeof NodeTurnAggregatesSchema>;

/**
 * Per-node liveness entry in the hub envelope (R3/R6 — names which nodes answered
 * and each node's data staleness). `answered=false` ⟹ offline / timeout / error.
 */
export const FederationTelemetryNodeStatusSchema = z.object({
  nodeId: z.string(),
  nodeLabel: z.string(),
  answered: z.boolean(),
  /** Node's read time when it answered; null when it didn't. */
  fetchedAt: z.number().nullable(),
  /** Failure reason when answered=false. */
  error: z.string().optional(),
});
export type FederationTelemetryNodeStatus = z.infer<
  typeof FederationTelemetryNodeStatusSchema
>;

/**
 * Hub aggregate envelope (R6 — the versioned, specified shape AC#2 is tested
 * against). `partial` is true exactly when `answeredNodeCount < nodeCount`.
 */
export const FederationTurnAggregateSchema = z
  .object({
    /** Merged v_session_totals rows across every answering node (R2 — pure concat). */
    sessionTotals: z.array(SessionTokenTotalsSchema),
    nodes: z.array(FederationTelemetryNodeStatusSchema),
    /** Total nodes consulted (including the local hub node). */
    nodeCount: z.number().int(),
    /** Nodes that returned data. */
    answeredNodeCount: z.number().int(),
    /** True ⟺ at least one consulted node did not answer (R3). */
    partial: z.boolean(),
    /** Most recent fetchedAt across answering nodes; null if none answered. */
    lastFetchedAt: z.number().nullable(),
  })
  .passthrough();
export type FederationTurnAggregate = z.infer<
  typeof FederationTurnAggregateSchema
>;

/**
 * Query bounds shared by the node receiver + hub aggregator. Bounding the query
 * keeps a heavy node under the 10s federation fan-out budget (FETCH_TIMEOUT_MS),
 * so one slow node can't time out the whole fan-out.
 */
export const TurnAggregateQuerySchema = z
  .object({
    /** Include sessions whose activity window ends at/after this epoch-ms bound. */
    fromMs: z.number().int().optional(),
    /** Include sessions whose activity window starts at/before this epoch-ms bound. */
    toMs: z.number().int().optional(),
    /** Row cap (default 500, max 2000); newest-activity-first. */
    limit: z.number().int().min(1).max(2000).optional(),
  })
  .passthrough();
export type TurnAggregateQuery = z.infer<typeof TurnAggregateQuerySchema>;
