// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Usage-snapshot store (epic #1855, Sub-Issue I / #1864).
 *
 * Persists periodic per-account usage snapshots in the `usage_snapshots` table
 * (created in `store/index.ts` runMigrations) — one row per
 * (account_uuid, limit_key, sampled_at). Backs the history endpoint's sparkline
 * series and the projected-exhaustion estimate. Bounded retention via
 * `pruneOlderThan` keeps the table from growing without limit (the issue's one
 * real hazard). Mirrors `ErrorLogStore`'s prepared-statement + retention shape.
 */

/** One persisted snapshot row, app-shaped (camelCase). */
export interface UsageSnapshotRow {
  accountUuid: string;
  limitKey: string;
  utilization: number;
  sampledAt: number;
}

/** A snapshot to insert (same shape as the stored row). */
export type InsertUsageSnapshot = UsageSnapshotRow;

interface DbUsageSnapshotRow {
  account_uuid: string;
  limit_key: string;
  utilization: number;
  sampled_at: number;
}

export class UsageHistoryStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Insert a single snapshot row. */
  insertSnapshot(
    accountUuid: string,
    limitKey: string,
    utilization: number,
    sampledAt: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO usage_snapshots (account_uuid, limit_key, utilization, sampled_at)
         VALUES (@account_uuid, @limit_key, @utilization, @sampled_at)`
      )
      .run({
        account_uuid: accountUuid,
        limit_key: limitKey,
        utilization,
        sampled_at: sampledAt,
      });
  }

  /**
   * Insert a whole sample's rows in one transaction. A sample with no rows
   * (e.g. all accounts non-ok) is a no-op.
   */
  insertMany(rows: InsertUsageSnapshot[]): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO usage_snapshots (account_uuid, limit_key, utilization, sampled_at)
       VALUES (@account_uuid, @limit_key, @utilization, @sampled_at)`
    );
    const insertAll = this.db.transaction((batch: InsertUsageSnapshot[]) => {
      for (const r of batch) {
        stmt.run({
          account_uuid: r.accountUuid,
          limit_key: r.limitKey,
          utilization: r.utilization,
          sampled_at: r.sampledAt,
        });
      }
    });
    insertAll(rows);
  }

  /**
   * Recent series for one account (all windows), ascending by time. The caller
   * groups by `limitKey`. `sinceMs` bounds the lookback.
   */
  getSeries(accountUuid: string, sinceMs: number): UsageSnapshotRow[] {
    const rows = this.db
      .prepare(
        `SELECT account_uuid, limit_key, utilization, sampled_at
         FROM usage_snapshots
         WHERE account_uuid = ? AND sampled_at >= ?
         ORDER BY sampled_at ASC`
      )
      .all(accountUuid, sinceMs) as DbUsageSnapshotRow[];
    return rows.map(r => ({
      accountUuid: r.account_uuid,
      limitKey: r.limit_key,
      utilization: r.utilization,
      sampledAt: r.sampled_at,
    }));
  }

  /** Delete snapshots older than `days`. Returns the number of rows removed. */
  pruneOlderThan(days: number): number {
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = this.db
      .prepare("DELETE FROM usage_snapshots WHERE sampled_at < ?")
      .run(cutoffMs);
    return result.changes;
  }
}
