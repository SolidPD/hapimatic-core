// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Durable, non-droppable audit log for privileged host-mutating self-update
 * actions (issue #1774, Sub E of epic #1769, Task 2 — R6).
 *
 * A privileged action (a global `claude install`) MUST leave a queryable,
 * NON-droppable record. `errorLogger.info` is deliberately NOT used: it is
 * rate-limited (10/min/category) and SILENTLY DROPS on flood
 * (`logging/errorLogger.ts`), and `error_logs` has no actor/action/version
 * columns. Writes here go SYNCHRONOUSLY through `append()` and never drop.
 *
 * Mirrors the {@link LeaseStore} / {@link HarnessStore} shape: `Database` in the
 * constructor, synchronous prepared queries. The `audit_logs` table is created
 * in `Store.runMigrations()` (`store/index.ts`), NOT here — this class is pure
 * queries (parity with the sibling stores).
 */

/** The action that produced the record. */
export type AuditAction = "update" | "rollback";

/** The terminal outcome of the action. */
export type AuditOutcome = "success" | "failure";

/** A row to append. `id` is assigned by SQLite (AUTOINCREMENT). */
export interface AuditLogRow {
  timestamp: number;
  /** The JWT namespace of the operator that triggered the action, or null when
   *  the trigger has no request context (e.g. a system-initiated path). */
  actor: string | null;
  node_id: string;
  harness_id: string;
  action: AuditAction;
  from_version: string | null;
  to_version: string | null;
  outcome: AuditOutcome;
  /** Free-form context: the stderr tail on failure, or a post-success throw
   *  (a `detectNow`/`archiveSession` failure recorded WITHOUT flipping the
   *  install outcome to failure). Null when there is nothing to add. */
  detail: string | null;
}

/** A read-back record — a row plus its assigned id. */
export interface AuditLogRecord extends AuditLogRow {
  id: number;
}

/** The raw DB row shape (all columns explicit). */
interface AuditLogDbRow {
  id: number;
  timestamp: number;
  actor: string | null;
  node_id: string;
  harness_id: string;
  action: string;
  from_version: string | null;
  to_version: string | null;
  outcome: string;
  detail: string | null;
}

export class AuditStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Append one audit record. Synchronous — the row is committed before the
   * method returns, so a privileged action can never complete without its
   * record (R6 non-droppable).
   */
  append(row: AuditLogRow): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs
           (timestamp, actor, node_id, harness_id, action,
            from_version, to_version, outcome, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.timestamp,
        row.actor,
        row.node_id,
        row.harness_id,
        row.action,
        row.from_version,
        row.to_version,
        row.outcome,
        row.detail
      );
  }

  /** The most recent `limit` records, newest first. */
  list(limit = 100): AuditLogRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, actor, node_id, harness_id, action,
                from_version, to_version, outcome, detail
           FROM audit_logs
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(limit) as AuditLogDbRow[];
    return rows.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      actor: r.actor,
      node_id: r.node_id,
      harness_id: r.harness_id,
      action: r.action as AuditAction,
      from_version: r.from_version,
      to_version: r.to_version,
      outcome: r.outcome as AuditOutcome,
      detail: r.detail,
    }));
  }
}
