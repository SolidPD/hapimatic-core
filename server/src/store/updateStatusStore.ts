// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * In-flight lock for the self-update flow (issue #1774, Sub E of epic #1769,
 * Task 2/3). One row per `(node_id, harness_id)` in `harness_update_status`
 * (created in `Store.runMigrations()`), holding `idle` | `updating`.
 *
 * This is BOTH:
 *   - the 409-producer for the update/rollback route (a second concurrent
 *     apply while one is `updating` fails to acquire → `update_in_flight`), and
 *   - the interlock the #1770 poll cites: while the row reads `updating`, the
 *     daily poll must not clobber the `prior_version` rollback slot.
 *
 * Acquisition is a single atomic upsert (`ON CONFLICT DO UPDATE ... WHERE
 * status='idle'`): a fresh row inserts, an `idle` row flips to `updating`, an
 * already-`updating` row is a no-op — `changes > 0` iff THIS caller took the
 * lock. The hub's synchronous SQLite driver serializes racing callers, so two
 * cannot both win. Mirrors {@link LeaseStore.tryAcquire}.
 *
 * Pure queries (parity with `LeaseStore`); the table lives in `store/index.ts`.
 */

export type UpdateStatus = "idle" | "updating";

export class UpdateStatusStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Atomically acquire the update lock for `(node_id, harness_id)`. Returns true
   * iff THIS call took the lock (the row was absent or `idle`); false when the
   * lock is already held (`updating`). `now` is the acquisition timestamp
   * (epoch ms) — injected so the caller controls the clock.
   */
  tryAcquire(node_id: string, harness_id: string, now: number): boolean {
    const res = this.db
      .prepare(
        `INSERT INTO harness_update_status (node_id, harness_id, status, started_at)
         VALUES (?, ?, 'updating', ?)
         ON CONFLICT(node_id, harness_id) DO UPDATE SET
           status = 'updating',
           started_at = excluded.started_at
         WHERE harness_update_status.status = 'idle'`
      )
      .run(node_id, harness_id, now);
    return res.changes > 0;
  }

  /** Release the lock back to `idle` (idempotent — a no-op if the row is absent). */
  release(node_id: string, harness_id: string): void {
    this.db
      .prepare(
        `UPDATE harness_update_status SET status = 'idle', started_at = NULL
          WHERE node_id = ? AND harness_id = ?`
      )
      .run(node_id, harness_id);
  }

  /** The current status for `(node_id, harness_id)`, or null when no row exists. */
  getStatus(node_id: string, harness_id: string): UpdateStatus | null {
    const row = this.db
      .prepare(
        `SELECT status FROM harness_update_status
          WHERE node_id = ? AND harness_id = ?`
      )
      .get(node_id, harness_id) as { status: string } | null;
    return row ? (row.status as UpdateStatus) : null;
  }
}
