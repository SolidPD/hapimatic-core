// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { HarnessDetectionState } from "@hapi/protocol";

/**
 * Detection-state sub-store (issue #1770). Persists one row per
 * `(node_id, harness_id)` in the `harness_detection_state` table (created in
 * `store/index.ts` `runMigrations()`). A thin `Database` wrapper mirroring
 * `recentPathStore.ts`.
 *
 * Two invariants the poll depends on:
 *   - `prior_version` (the rollback slot) is NEVER written by the poll upsert —
 *     only the update/rollback flow (#1774) writes it via `setPriorVersion`.
 *     The upsert omits it from both the INSERT columns and the DO UPDATE SET, so
 *     a re-poll preserves whatever the update flow last stored.
 *   - `changelog_text` (~126 KB) is read back ONLY via `getChangelogText`
 *     (KD-7, for #1771). The state getters SELECT columns explicitly and never
 *     carry it, so it cannot leak into a serialized status payload.
 */

/** The fields the daily poll / manual check writes. Excludes `prior_version`
 *  (rollback slot, owned by #1774) — it is preserved across upserts. */
export interface HarnessDetectionUpsert {
  node_id: string;
  harness_id: string;
  installed_version: string | null;
  latest_version: string | null;
  update_available: boolean;
  changelog_text: string | null;
  last_checked_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

/** The raw DB row shape for a state SELECT (update_available is an INTEGER). */
interface DetectionStateRow {
  node_id: string;
  harness_id: string;
  installed_version: string | null;
  latest_version: string | null;
  prior_version: string | null;
  update_available: number;
  last_checked_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
}

const STATE_COLUMNS =
  "node_id, harness_id, installed_version, latest_version, prior_version, " +
  "update_available, last_checked_at, last_error, last_error_at";

function rowToState(row: DetectionStateRow): HarnessDetectionState {
  return {
    node_id: row.node_id,
    harness_id: row.harness_id,
    installed_version: row.installed_version,
    latest_version: row.latest_version,
    prior_version: row.prior_version,
    update_available: row.update_available !== 0,
    last_checked_at: row.last_checked_at,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
  };
}

export class HarnessStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Insert or update the detection state for `(node_id, harness_id)`.
   * `prior_version` is deliberately absent from the INSERT columns (defaults
   * NULL on a new row) and from the DO UPDATE SET (preserved on re-poll) — the
   * poll must never clobber the rollback slot.
   */
  upsertDetectionState(row: HarnessDetectionUpsert): void {
    this.db
      .prepare(
        `INSERT INTO harness_detection_state
           (node_id, harness_id, installed_version, latest_version,
            update_available, changelog_text, last_checked_at, last_error, last_error_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id, harness_id) DO UPDATE SET
           installed_version = excluded.installed_version,
           latest_version = excluded.latest_version,
           update_available = excluded.update_available,
           changelog_text = excluded.changelog_text,
           last_checked_at = excluded.last_checked_at,
           last_error = excluded.last_error,
           last_error_at = excluded.last_error_at`
      )
      .run(
        row.node_id,
        row.harness_id,
        row.installed_version,
        row.latest_version,
        row.update_available ? 1 : 0,
        row.changelog_text,
        row.last_checked_at,
        row.last_error,
        row.last_error_at
      );
  }

  /** Detection state for one `(node_id, harness_id)`, or null. Never carries
   *  `changelog_text` (use `getChangelogText`). */
  getDetectionState(
    node_id: string,
    harness_id: string
  ): HarnessDetectionState | null {
    const row = this.db
      .prepare(
        `SELECT ${STATE_COLUMNS} FROM harness_detection_state
         WHERE node_id = ? AND harness_id = ?`
      )
      .get(node_id, harness_id) as DetectionStateRow | null;
    return row ? rowToState(row) : null;
  }

  /** All detection states for a node (v1: the local node). */
  getDetectionStates(node_id: string): HarnessDetectionState[] {
    const rows = this.db
      .prepare(
        `SELECT ${STATE_COLUMNS} FROM harness_detection_state
         WHERE node_id = ? ORDER BY harness_id ASC`
      )
      .all(node_id) as DetectionStateRow[];
    return rows.map(rowToState);
  }

  /**
   * The cached raw changelog text for `(node_id, harness_id)`, or null. The ONLY
   * read path for the changelog (KD-7) — #1771's changelog route calls it
   * server-side. The state getters never carry the text.
   */
  getChangelogText(node_id: string, harness_id: string): string | null {
    const row = this.db
      .prepare(
        `SELECT changelog_text FROM harness_detection_state
         WHERE node_id = ? AND harness_id = ?`
      )
      .get(node_id, harness_id) as { changelog_text: string | null } | null;
    return row?.changelog_text ?? null;
  }

  /**
   * Set the `prior_version` rollback slot. Provided for #1774 (rollback capture)
   * — NOT called by Sub A's poll. #1774 checks its own update-status in-flight
   * lock before writing this slot so an in-progress update is not clobbered.
   */
  setPriorVersion(
    node_id: string,
    harness_id: string,
    prior: string | null
  ): void {
    this.db
      .prepare(
        `UPDATE harness_detection_state SET prior_version = ?
         WHERE node_id = ? AND harness_id = ?`
      )
      .run(prior, node_id, harness_id);
  }
}
