// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import { newUuidV7 } from "./ids";
import type { TimelogAdjustmentRow, TimelogAdjustmentType } from "./types";

/**
 * Raw synchronous CRUD for the append-only `timelog_adjustments` manual ledger
 * (issue #1670, Sub H1, epic #1662).
 *
 * This is the WRITE surface for the six clock controls. It mirrors `TurnStore`'s
 * low-level style: synchronous methods, named-param `@field` INSERT under
 * `bun:sqlite { strict: true }`, a UUIDv7 id (R4) + `node_id` (R5) on every row,
 * and a `rowTo*` snake_case→camelCase mapper.
 *
 * Append-only invariant (R3): there is NO update or delete method. "Undo" is a
 * NEW reversing row of `type='undo'` that references the adjustment it reverses
 * via `targetAdjustmentId`; the derivation (`timelogDerivation.ts`) interprets it.
 * The table itself is created by `applyTurnsMigrations` (Sub A) — this store adds
 * NO schema.
 *
 * DORMANCY (#1670 PR-1): nothing in the live read path or any HTTP route calls
 * this store yet. PR-2 wires the six clock controls to it; the actual display
 * switch stays gated on the Sub-G parity green-streak (see `cutoverGate.ts`).
 */

/** Generic append input — one `timelog_adjustments` row. */
export interface AppendAdjustmentInput {
  hapiSessionId: string;
  nodeId: string;
  namespace?: string | null;
  /** Epoch ms of the adjustment. Caller-supplied (no Date.now() in this store). */
  tsMs: number;
  type: TimelogAdjustmentType;
  deltaMs?: number | null;
  fromMs?: number | null;
  toMs?: number | null;
  targetAdjustmentId?: string | null;
  actor?: string | null;
  note?: string | null;
}

/** Shared scope fields the typed control helpers carry. */
interface ControlBase {
  hapiSessionId: string;
  nodeId: string;
  namespace?: string | null;
  tsMs: number;
  actor?: string | null;
  note?: string | null;
}

/** Filters for reading the ledger back (all optional). */
export interface AdjustmentQuery {
  hapiSessionId?: string;
  namespace?: string | null;
  /** Inclusive lower bound on `ts_ms`. */
  startMs?: number;
  /** Inclusive upper bound on `ts_ms`. */
  endMs?: number;
}

export class TimelogAdjustmentsStore {
  constructor(private readonly db: Database) {}

  /**
   * Append one adjustment row. Mints the UUIDv7 id and returns the inserted row.
   * Synchronous; MAY throw (locked DB). Callers that must never block a session
   * wrap this off the critical path (the live wiring lands in PR-2).
   */
  appendAdjustment(input: AppendAdjustmentInput): TimelogAdjustmentRow {
    const id = newUuidV7();
    const row: TimelogAdjustmentRow = {
      id,
      hapiSessionId: input.hapiSessionId,
      nodeId: input.nodeId,
      namespace: input.namespace ?? null,
      tsMs: input.tsMs,
      type: input.type,
      deltaMs: input.deltaMs ?? null,
      fromMs: input.fromMs ?? null,
      toMs: input.toMs ?? null,
      targetAdjustmentId: input.targetAdjustmentId ?? null,
      actor: input.actor ?? null,
      note: input.note ?? null,
    };
    this.db
      .prepare(
        `INSERT INTO timelog_adjustments (
           id, hapi_session_id, node_id, namespace, ts_ms, type,
           delta_ms, from_ms, to_ms, target_adjustment_id, actor, note
         ) VALUES (
           @id, @hapi_session_id, @node_id, @namespace, @ts_ms, @type,
           @delta_ms, @from_ms, @to_ms, @target_adjustment_id, @actor, @note
         )`
      )
      .run({
        id: row.id,
        hapi_session_id: row.hapiSessionId,
        node_id: row.nodeId,
        namespace: row.namespace,
        ts_ms: row.tsMs,
        type: row.type,
        delta_ms: row.deltaMs,
        from_ms: row.fromMs,
        to_ms: row.toMs,
        target_adjustment_id: row.targetAdjustmentId,
        actor: row.actor,
        note: row.note,
      });
    return row;
  }

  /** Adjust (relative) → a signed `delta` entry. */
  adjust(input: ControlBase & { deltaMs: number }): TimelogAdjustmentRow {
    return this.appendAdjustment({
      ...input,
      type: "delta",
      deltaMs: input.deltaMs,
    });
  }

  /**
   * Set (absolute) → a `set` checkpoint to `toMs`. `fromMs` (the derived total at
   * the instant of the set) is optional audit context; the derivation does not
   * require it.
   */
  set(
    input: ControlBase & { toMs: number; fromMs?: number | null }
  ): TimelogAdjustmentRow {
    return this.appendAdjustment({
      ...input,
      type: "set",
      toMs: input.toMs,
      fromMs: input.fromMs ?? null,
    });
  }

  /** Reset → a `reset` checkpoint to 0 (a `set` to zero). */
  reset(input: ControlBase & { fromMs?: number | null }): TimelogAdjustmentRow {
    return this.appendAdjustment({
      ...input,
      type: "reset",
      toMs: 0,
      fromMs: input.fromMs ?? null,
    });
  }

  /**
   * Undo → an append-only reversing entry referencing `targetAdjustmentId`.
   * NEVER deletes (R3). Throws if the target does not exist — you cannot undo a
   * nonexistent adjustment. The derivation interprets an undo by EXCLUDING the
   * referenced adjustment from the computation (uniform across all target types).
   */
  undo(
    input: ControlBase & { targetAdjustmentId: string }
  ): TimelogAdjustmentRow {
    const target = this.getById(input.targetAdjustmentId);
    if (!target) {
      throw new Error(
        `undo: target adjustment ${input.targetAdjustmentId} does not exist`
      );
    }
    return this.appendAdjustment({
      ...input,
      type: "undo",
      targetAdjustmentId: input.targetAdjustmentId,
    });
  }

  /**
   * Disable → an aggregation-flag `[fromMs, toMs]` range. Facts (turns) are still
   * recorded; the derivation EXCLUDES auto-turn durations whose `started_at_ms`
   * falls inside a net-disabled range from the displayed total.
   */
  disableRange(
    input: ControlBase & { fromMs: number; toMs: number }
  ): TimelogAdjustmentRow {
    return this.appendAdjustment({
      ...input,
      type: "disable",
      fromMs: input.fromMs,
      toMs: input.toMs,
    });
  }

  /** Enable → re-include a previously-disabled `[fromMs, toMs]` range. */
  enableRange(
    input: ControlBase & { fromMs: number; toMs: number }
  ): TimelogAdjustmentRow {
    return this.appendAdjustment({
      ...input,
      type: "enable",
      fromMs: input.fromMs,
      toMs: input.toMs,
    });
  }

  /** Single adjustment by id, or null. */
  getById(id: string): TimelogAdjustmentRow | null {
    const row = this.db
      .prepare("SELECT * FROM timelog_adjustments WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowToAdjustment(row) : null;
  }

  /**
   * Read the ledger back, ordered by `ts_ms ASC` (the order the derivation
   * processes). All filters optional; NULL-namespace is matched when
   * `namespace` is explicitly `null` (coalesced to "").
   */
  getAdjustments(query: AdjustmentQuery = {}): TimelogAdjustmentRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (query.hapiSessionId !== undefined) {
      clauses.push("hapi_session_id = ?");
      params.push(query.hapiSessionId);
    }
    if (query.namespace !== undefined) {
      clauses.push("COALESCE(namespace, '') = ?");
      params.push(query.namespace ?? "");
    }
    if (typeof query.startMs === "number") {
      clauses.push("ts_ms >= ?");
      params.push(query.startMs);
    }
    if (typeof query.endMs === "number") {
      clauses.push("ts_ms <= ?");
      params.push(query.endMs);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM timelog_adjustments ${where} ORDER BY ts_ms ASC, id ASC`
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map(rowToAdjustment);
  }
}

/** Map a raw `timelog_adjustments` row (snake_case) to the camelCase contract. */
function rowToAdjustment(r: Record<string, unknown>): TimelogAdjustmentRow {
  return {
    id: r.id as string,
    hapiSessionId: r.hapi_session_id as string,
    nodeId: r.node_id as string,
    namespace: (r.namespace as string | null) ?? null,
    tsMs: r.ts_ms as number,
    type: r.type as TimelogAdjustmentType,
    deltaMs: (r.delta_ms as number | null) ?? null,
    fromMs: (r.from_ms as number | null) ?? null,
    toMs: (r.to_ms as number | null) ?? null,
    targetAdjustmentId: (r.target_adjustment_id as string | null) ?? null,
    actor: (r.actor as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  };
}
