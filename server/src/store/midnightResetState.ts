// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-namespace midnight reset state (Issue #1119).
 *
 * Tracks the last date each namespace was reset, plus the timezone used at
 * reset time. Persists across server restarts so that catch-up logic can
 * fire for any midnight boundaries crossed while the server was offline.
 *
 * The catch-up loop in SyncEngine compares stored `last_reset_date` to
 * today's date in the namespace's timezone (string comparison) and fires
 * one reset per missed date in chronological order. DST-correct iteration
 * is handled by `addDaysInTimezone` (see `sync/timelogReset.ts`) — this store
 * is a dumb persistence layer.
 */

import type { Database } from "bun:sqlite";

export type MidnightResetState = {
  namespace: string;
  timezone: string;
  /** YYYY-MM-DD in `timezone`. */
  lastResetDate: string;
  /** ms timestamp when the most recent reset fired. */
  lastResetEpoch: number;
  /** ms timestamp this row was last touched. */
  updatedAt: number;
};

type DbRow = {
  namespace: string;
  timezone: string;
  last_reset_date: string;
  last_reset_epoch: number;
  updated_at: number;
};

function toState(row: DbRow): MidnightResetState {
  return {
    namespace: row.namespace,
    timezone: row.timezone,
    lastResetDate: row.last_reset_date,
    lastResetEpoch: row.last_reset_epoch,
    updatedAt: row.updated_at,
  };
}

export function getAll(db: Database): MidnightResetState[] {
  const rows = db
    .prepare("SELECT * FROM midnight_reset_state")
    .all() as DbRow[];
  return rows.map(toState);
}

export function get(
  db: Database,
  namespace: string
): MidnightResetState | null {
  const row = db
    .prepare("SELECT * FROM midnight_reset_state WHERE namespace = ?")
    .get(namespace) as DbRow | undefined;
  return row ? toState(row) : null;
}

export function upsert(
  db: Database,
  namespace: string,
  timezone: string,
  lastResetDate: string,
  lastResetEpoch: number
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO midnight_reset_state
       (namespace, timezone, last_reset_date, last_reset_epoch, updated_at)
     VALUES (@namespace, @timezone, @last_reset_date, @last_reset_epoch, @updated_at)
     ON CONFLICT(namespace) DO UPDATE SET
       timezone = excluded.timezone,
       last_reset_date = excluded.last_reset_date,
       last_reset_epoch = excluded.last_reset_epoch,
       updated_at = excluded.updated_at`
  ).run({
    namespace,
    timezone,
    last_reset_date: lastResetDate,
    last_reset_epoch: lastResetEpoch,
    updated_at: now,
  });
}
