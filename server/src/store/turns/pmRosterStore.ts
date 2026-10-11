// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type {
  PmSpawnReconciliationStatus,
  PmSpawnRosterRecord,
  PmSpawnRosterUpsert,
} from "@hapi/protocol";

import { newUuidV7 } from "./ids";

/** Enrich cc/hapi session ids on a roster row (R2). */
export interface PmRosterEnrichInput {
  completionToken: string;
  ccSessionId?: string;
  hapiSessionId?: string;
}

/** Transition a roster row's reconciliation status (R3). */
export interface PmRosterSetStatusInput {
  completionToken: string;
  status: PmSpawnReconciliationStatus;
}

/**
 * Raw synchronous CRUD for the `pm_spawn_roster` table (issue #1936, producer for
 * rp1-home#1054).
 *
 * Per-SPAWN ledger for the `/project-manager-role` PM: one row per session the PM
 * spawns. Like `TurnStore`, methods are SYNCHRONOUS and MAY THROW (constraint
 * violations, locked DB).
 *
 * Fail-open (R6) is upheld at the ROUTE layer (route-level try/catch returning a
 * soft 5xx) rather than via a `TurnWriteService`-style FIFO queue. The queue exists
 * because per-turn writes are HIGH-volume and sit ON the prompt/reply request path
 * (a synchronous write could block the caller up to 5s on `busy_timeout` WAL
 * contention). The spawn roster is LOW-volume (a handful of writes per PM run) and
 * OFF the request path (driven by the PM's out-of-band `curl`), so a synchronous
 * store + try/catch routes is the right weight (Decision D1).
 *
 * Every inserted row mints a UUIDv7 `id` (time-ordered, coordination-free across
 * nodes — so the federation aggregate's cross-node merge is a pure concat with no
 * id collisions). `node_id` is the node where the SPAWNED session runs (federation
 * source of truth). The upsert is idempotent on `UNIQUE(completion_token)`. Mirrors
 * the named-`@field` INSERT style of `turnStore.ts` under bun:sqlite `{ strict: true }`.
 */
export class PmRosterStore {
  constructor(
    private readonly db: Database,
    /** Injectable clock for deterministic tests (mirrors TurnWriteService). */
    private readonly getNow: () => number = Date.now
  ) {}

  /**
   * Register a spawn (R1). Idempotent on `UNIQUE(completion_token)`: a re-POST with
   * the same token updates mutable fields in place — `COALESCE(excluded.x, x)`
   * preserves already-enriched cc/hapi ids and other nullable fields rather than
   * clobbering them with NULLs — instead of inserting a duplicate row. Returns the
   * stored row.
   */
  upsertSpawn(input: PmSpawnRosterUpsert): PmSpawnRosterRecord {
    this.db
      .prepare(
        `INSERT INTO pm_spawn_roster (
           id, completion_token, pm_session_id, hapi_session_id, cc_session_id,
           issue, repo, node_id, worktree_path, reconciliation_status,
           spawned_at_ms, updated_at_ms
         ) VALUES (
           @id, @completion_token, @pm_session_id, @hapi_session_id, @cc_session_id,
           @issue, @repo, @node_id, @worktree_path, @reconciliation_status,
           @spawned_at_ms, @updated_at_ms
         )
         ON CONFLICT(completion_token) DO UPDATE SET
           pm_session_id   = excluded.pm_session_id,
           node_id         = excluded.node_id,
           hapi_session_id = COALESCE(excluded.hapi_session_id, pm_spawn_roster.hapi_session_id),
           cc_session_id   = COALESCE(excluded.cc_session_id, pm_spawn_roster.cc_session_id),
           issue           = COALESCE(excluded.issue, pm_spawn_roster.issue),
           repo            = COALESCE(excluded.repo, pm_spawn_roster.repo),
           worktree_path   = COALESCE(excluded.worktree_path, pm_spawn_roster.worktree_path),
           updated_at_ms   = excluded.updated_at_ms`
      )
      .run({
        id: newUuidV7(),
        completion_token: input.completionToken,
        pm_session_id: input.pmSessionId,
        hapi_session_id: input.hapiSessionId ?? null,
        cc_session_id: input.ccSessionId ?? null,
        issue: input.issue ?? null,
        repo: input.repo ?? null,
        node_id: input.nodeId,
        worktree_path: input.worktreePath ?? null,
        reconciliation_status: input.reconciliationStatus ?? "spawned",
        spawned_at_ms: input.spawnedAtMs,
        updated_at_ms: this.getNow(),
      });
    const row = this.getByToken(input.completionToken);
    if (!row) {
      throw new Error(
        `pm_spawn_roster upsert succeeded but row not found for token ${input.completionToken}`
      );
    }
    return row;
  }

  /**
   * Enrich cc/hapi session ids (R2). Omitted fields stay unchanged (COALESCE).
   * Returns the number of rows updated — 0 ⟺ no row matches the completion_token
   * (issue #1941: lets the route distinguish a real enrichment from a no-op).
   */
  enrich(input: PmRosterEnrichInput): number {
    return this.db
      .prepare(
        `UPDATE pm_spawn_roster SET
           cc_session_id   = COALESCE(@cc_session_id, cc_session_id),
           hapi_session_id = COALESCE(@hapi_session_id, hapi_session_id),
           updated_at_ms   = @updated_at_ms
         WHERE completion_token = @completion_token`
      )
      .run({
        completion_token: input.completionToken,
        cc_session_id: input.ccSessionId ?? null,
        hapi_session_id: input.hapiSessionId ?? null,
        updated_at_ms: this.getNow(),
      }).changes;
  }

  /**
   * Transition reconciliation_status (R3): spawned → complete | re-driving.
   * Returns the number of rows updated — 0 ⟺ no row matches the completion_token
   * (issue #1941).
   */
  setStatus(input: PmRosterSetStatusInput): number {
    return this.db
      .prepare(
        `UPDATE pm_spawn_roster SET
           reconciliation_status = @status,
           updated_at_ms         = @updated_at_ms
         WHERE completion_token = @completion_token`
      )
      .run({
        completion_token: input.completionToken,
        status: input.status,
        updated_at_ms: this.getNow(),
      }).changes;
  }

  /**
   * Node-local roster filtered by PM, optionally by status (R4; also the
   * federation receiver's source, R5). Newest-spawn-first. Two prepared statements
   * (rather than `${}`-interpolated WHERE) keep the SQL static and parameterized.
   */
  queryByPm(
    pmSessionId: string,
    status?: PmSpawnReconciliationStatus
  ): PmSpawnRosterRecord[] {
    const rows = (
      status === undefined
        ? this.db
            .prepare(
              `SELECT * FROM pm_spawn_roster
               WHERE pm_session_id = @pm_session_id
               ORDER BY spawned_at_ms DESC`
            )
            .all({ pm_session_id: pmSessionId })
        : this.db
            .prepare(
              `SELECT * FROM pm_spawn_roster
               WHERE pm_session_id = @pm_session_id
                 AND reconciliation_status = @status
               ORDER BY spawned_at_ms DESC`
            )
            .all({ pm_session_id: pmSessionId, status })
    ) as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /**
   * All non-`complete` roster rows on THIS node (issue #2010 — `pmReconcileStep`
   * token-scan). Returns every row whose `reconciliation_status != 'complete'`,
   * regardless of PM or session: the finalize step greps each row's
   * `completion_token` against the just-finalized transcript, and the token is
   * `PMDONE-<24hex>` (96-bit, UNIQUE, emitted ONLY into its own session's
   * transcript by the closer's terminal step) — so the scan is collision-free and
   * works identically same-node and cross-node WITHOUT relying on the node-blind
   * cc/hapi session-id enrichment. Uses `idx_pm_roster_status`. Returns `[]` when
   * none (the common case — keeps the finalize step a cheap no-op for non-PM
   * sessions: one indexed SELECT, no transcript read).
   */
  getReconcilable(): PmSpawnRosterRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pm_spawn_roster
         WHERE reconciliation_status != 'complete'`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToRecord);
  }

  /** Single-row lookup by completion token (internal — backs upsert's return). */
  private getByToken(completionToken: string): PmSpawnRosterRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM pm_spawn_roster WHERE completion_token = @t`)
      .get({ t: completionToken }) as Record<string, unknown> | null;
    return row ? rowToRecord(row) : null;
  }
}

/** snake_case DB row → camelCase API record. */
function rowToRecord(r: Record<string, unknown>): PmSpawnRosterRecord {
  return {
    id: r.id as string,
    completionToken: r.completion_token as string,
    pmSessionId: r.pm_session_id as string,
    hapiSessionId: (r.hapi_session_id as string | null) ?? null,
    ccSessionId: (r.cc_session_id as string | null) ?? null,
    issue: (r.issue as string | null) ?? null,
    repo: (r.repo as string | null) ?? null,
    nodeId: r.node_id as string,
    worktreePath: (r.worktree_path as string | null) ?? null,
    reconciliationStatus:
      r.reconciliation_status as PmSpawnRosterRecord["reconciliationStatus"],
    spawnedAtMs: r.spawned_at_ms as number,
    updatedAtMs: (r.updated_at_ms as number | null) ?? null,
  };
}
