// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { FederationTelemetryNodeStatusSchema } from "./federationTelemetry";

// Admin session-metadata query surface (issue #1675, epic #1662 Sub M).
//
// M is a read-only query/browse surface over the per-turn telemetry DB (#1663),
// rendered as the `?section=session-metadata` admin-drawer section. This module
// is the shared contract between M's node-local query endpoint (server) and the
// admin section component (web):
//
//   1. SessionMetadataQuery       — the six filter dimensions + pagination, parsed
//      from the query string of `GET /api/session-metadata/turns`.
//   2. SessionMetadataTurn        — the curated per-turn display row the endpoint
//      returns (a stable subset of the server-internal TurnRow — NOT all 40+
//      columns). Mirrors TurnRow's nullability (NULLable SQLite columns surface
//      as `<type> | null`).
//   3. SessionMetadataFilterOptions — distinct filter values for the dropdowns
//      (`GET /api/session-metadata/filter-options`).
//
// The CROSS-NODE view of M consumes Sub L's federation aggregate
// (`FederationTurnAggregate` / `SessionTokenTotals` in ./federationTelemetry),
// NOT this module — L's substrate carries only session rollups (no turn_events),
// so the event-kind filter is node-local only. See the issue #1675 directive.

/**
 * The six filter dimensions of M's node-local query + pagination. Every field is
 * optional; an empty query returns the newest `limit` turns. `eventKind` is served
 * via an EXISTS subquery against `turn_events` (a turn matches when it contains
 * at least one event of that kind).
 */
export const SessionMetadataQuerySchema = z
  .object({
    /** Exact match on turns.hapi_session_id. */
    sessionId: z.string().optional(),
    /** Lower bound (inclusive) on turns.started_at_ms (epoch ms). */
    fromMs: z.number().int().optional(),
    /** Upper bound (inclusive) on turns.started_at_ms (epoch ms). */
    toMs: z.number().int().optional(),
    /** Exact match on turns.repo. */
    repo: z.string().optional(),
    /** Exact match on turns.model_id. */
    modelId: z.string().optional(),
    /** Exact match on turns.account_id. */
    accountId: z.string().optional(),
    /** Restrict to turns containing ≥1 turn_events row of this kind. */
    eventKind: z.string().optional(),
    /** Row cap (default 500, max 2000); newest-started-first. */
    limit: z.number().int().min(1).max(2000).optional(),
    /** Pagination offset (default 0). */
    offset: z.number().int().min(0).optional(),
  })
  .passthrough();
export type SessionMetadataQuery = z.infer<typeof SessionMetadataQuerySchema>;

/**
 * One per-turn display row. A curated subset of the server-internal TurnRow
 * (server/src/store/turns/types.ts) — the columns the grid + CSV export show.
 * NULLable SQLite columns surface as `<type> | null` to match TurnRow.
 */
export const SessionMetadataTurnSchema = z
  .object({
    id: z.string(),
    hapiSessionId: z.string(),
    seq: z.number(),
    status: z.string(),
    startedAtMs: z.number(),
    endedAtMs: z.number().nullable(),
    durationMs: z.number().nullable(),
    nodeId: z.string(),
    namespace: z.string().nullable(),
    sessionName: z.string().nullable(),
    linkedIssue: z.string().nullable(),
    repo: z.string().nullable(),
    modelProvider: z.string().nullable(),
    modelId: z.string().nullable(),
    accountId: z.string().nullable(),
    tokIn: z.number().nullable(),
    tokOut: z.number().nullable(),
    tokCacheRead: z.number().nullable(),
    tokCacheWrite: z.number().nullable(),
    costTotal: z.number().nullable(),
    /** Issue #4824: the binding the turn ran under and, for an `api-key` turn,
     *  the vault key id — so cost can be reported per key. Optional so an older
     *  federation peer's rows still parse. */
    authBindingKind: z.string().nullable().optional(),
    apiKeyId: z.string().nullable().optional(),
  })
  .passthrough();
export type SessionMetadataTurn = z.infer<typeof SessionMetadataTurnSchema>;

/** Distinct filter values for the filter-form dropdowns. */
export const SessionMetadataFilterOptionsSchema = z
  .object({
    repos: z.array(z.string()),
    models: z.array(z.string()),
    accounts: z.array(z.string()),
    eventKinds: z.array(z.string()),
  })
  .passthrough();
export type SessionMetadataFilterOptions = z.infer<
  typeof SessionMetadataFilterOptionsSchema
>;

// ── PM spawn-roster (issue #1936, producer for rp1-home#1054) ───────────────
//
// Per-SPAWN ledger the /project-manager-role PM writes to durably, queryably,
// federation-awarely track every session it spawns + that session's
// reconciliation status. Backed by the `pm_spawn_roster` table
// (server/src/store/turns/schema.ts). This is the cross-package contract for:
//   - node-local CRUD:  POST/PATCH/GET /api/session-metadata/spawn-roster
//   - hub aggregate:    GET /api/federation/session-metadata/spawn-roster
//
// API shapes are camelCase; the store maps to the snake_case DB columns (same
// split as SessionMetadataTurn vs the snake_case TurnRow). The node-payload +
// hub-envelope shapes model NodeTurnAggregates / FederationTurnAggregate in
// ./federationTelemetry (Sub L), reusing FederationTelemetryNodeStatus for the
// per-node liveness array.

/** Reconciliation lifecycle of a spawned session. Plain TEXT in the DB (no CHECK,
 *  K1 house rule) — this enum is the validation boundary at the API layer. */
export const PmSpawnReconciliationStatusSchema = z.enum([
  "spawned",
  "complete",
  "re-driving",
]);
export type PmSpawnReconciliationStatus = z.infer<
  typeof PmSpawnReconciliationStatusSchema
>;

/** A full pm_spawn_roster row (camelCase API shape). NULLable columns surface as
 *  `<type> | null` to match the DB row. */
export const PmSpawnRosterRecordSchema = z
  .object({
    id: z.string(),
    completionToken: z.string(),
    pmSessionId: z.string(),
    hapiSessionId: z.string().nullable(),
    ccSessionId: z.string().nullable(),
    issue: z.string().nullable(),
    repo: z.string().nullable(),
    nodeId: z.string(),
    worktreePath: z.string().nullable(),
    reconciliationStatus: PmSpawnReconciliationStatusSchema,
    spawnedAtMs: z.number(),
    updatedAtMs: z.number().nullable(),
  })
  .passthrough();
export type PmSpawnRosterRecord = z.infer<typeof PmSpawnRosterRecordSchema>;

/** POST body — register a spawn (R1). `reconciliationStatus` defaults to "spawned"
 *  server-side when omitted. A duplicate `completionToken` upserts in place. */
export const PmSpawnRosterUpsertSchema = z
  .object({
    completionToken: z.string().min(1),
    pmSessionId: z.string().min(1),
    nodeId: z.string().min(1),
    spawnedAtMs: z.number().int(),
    hapiSessionId: z.string().optional(),
    ccSessionId: z.string().optional(),
    issue: z.string().optional(),
    repo: z.string().optional(),
    worktreePath: z.string().optional(),
    reconciliationStatus: PmSpawnReconciliationStatusSchema.optional(),
  })
  .passthrough();
export type PmSpawnRosterUpsert = z.infer<typeof PmSpawnRosterUpsertSchema>;

/** PATCH body — enrich ids and/or transition status (R2, R3). At least one field
 *  must be present (a no-op PATCH is rejected with 400). */
export const PmSpawnRosterPatchSchema = z
  .object({
    ccSessionId: z.string().optional(),
    hapiSessionId: z.string().optional(),
    reconciliationStatus: PmSpawnReconciliationStatusSchema.optional(),
  })
  .passthrough()
  .refine(
    v =>
      v.ccSessionId !== undefined ||
      v.hapiSessionId !== undefined ||
      v.reconciliationStatus !== undefined,
    {
      message:
        "PATCH requires at least one of ccSessionId, hapiSessionId, reconciliationStatus",
    }
  );
export type PmSpawnRosterPatch = z.infer<typeof PmSpawnRosterPatchSchema>;

/** GET query — node-local roster filtered by PM (+ optional status) (R4). */
export const PmSpawnRosterQuerySchema = z
  .object({
    pmSessionId: z.string().min(1),
    status: PmSpawnReconciliationStatusSchema.optional(),
  })
  .passthrough();
export type PmSpawnRosterQuery = z.infer<typeof PmSpawnRosterQuerySchema>;

/** Per-node payload returned by the fed-token POST receiver. Models
 *  NodeTurnAggregates (node-tagged rows + fetchedAt). */
export const NodePmSpawnRosterSchema = z
  .object({
    nodeId: z.string(),
    nodeLabel: z.string(),
    records: z.array(PmSpawnRosterRecordSchema),
    /** Epoch ms when this node read its roster (staleness signal). */
    fetchedAt: z.number(),
  })
  .passthrough();
export type NodePmSpawnRoster = z.infer<typeof NodePmSpawnRosterSchema>;

/** Hub aggregate envelope (R5). Models FederationTurnAggregate; the cross-node
 *  merge is a pure concatenation (rows are node-partitioned with UUIDv7 ids, zero
 *  collision by construction). `partial` is true ⟺ answeredNodeCount < nodeCount. */
export const FederationPmSpawnRosterSchema = z
  .object({
    /** Merged pm_spawn_roster rows across every answering node (pure concat). */
    records: z.array(PmSpawnRosterRecordSchema),
    nodes: z.array(FederationTelemetryNodeStatusSchema),
    /** Total nodes consulted (including the local hub node). */
    nodeCount: z.number().int(),
    /** Nodes that returned data. */
    answeredNodeCount: z.number().int(),
    /** True ⟺ at least one consulted node did not answer. */
    partial: z.boolean(),
    /** Most recent fetchedAt across answering nodes; null if none answered. */
    lastFetchedAt: z.number().nullable(),
  })
  .passthrough();
export type FederationPmSpawnRoster = z.infer<
  typeof FederationPmSpawnRosterSchema
>;
