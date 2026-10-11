// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Versioned migrations for `scorecard.db` (issue #3128, epic #3117 Sub-Issue N —
 * the Harness Scorecard). A SEPARATE database from the main store AND from
 * `telemetry.db`, mirroring `telemetryMigrations.ts`'s disciplines (KD1):
 *
 *   - **Both creation paths must agree.** A *fresh* DB gets its columns from
 *     `ScorecardStore.createSchema()`'s `CREATE TABLE`; an *existing* DB gets any
 *     later columns from the ALTERs added here. `addScorecardColumn()`'s `PRAGMA
 *     table_info` guard lets the same migration run over both without a
 *     "duplicate column name" crash on the fresh path.
 *
 *   - **One DDL statement per `exec()` call.** Bun's SQLite driver can silently
 *     truncate multi-statement strings — so every ALTER below is its own
 *     `exec()`, assigned to a local first (matching telemetryMigrations.ts).
 *
 * `PRAGMA user_version` is the version counter (its own numbering, no collision
 * with `telemetry.db`). Deviation from the fail-open house pattern (as in
 * telemetry): boot is never aborted, but the version is stamped ONLY after the
 * migration verifies — a stamped-but-unapplied version would skip the retry on
 * next boot.
 *
 * v1 is the INITIAL schema. `createSchema()` already declares every v1 column, so
 * `applyScorecardMigrations` at v1 only stamps `user_version = 1`, establishing
 * the standard incremental infrastructure a future v2 builds on (add a
 * `migrateV2`, bump `SCORECARD_SCHEMA_VERSION`, list its columns). Keeping the
 * infra from day one matches the telemetry precedent the directive copies.
 */

/** Current scorecard schema version. Bump when adding a migration below. */
export const SCORECARD_SCHEMA_VERSION = 1;

function readUserVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return row?.user_version ?? 0;
}

/**
 * Column-name set for a table. Kept for the day a v2 migration needs the
 * `table_info` guard (`addScorecardColumn` below) — mirrors
 * `telemetryMigrations.ts`.
 */
export function scorecardColumnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map(r => r.name));
}

/**
 * Add one column if absent. Mirrors `telemetryMigrations.ts` `addColumn`:
 * identifier validation, `table_info` guard, and a duplicate-column catch for the
 * race between the guard and the ALTER. Returns false on genuine failure so the
 * caller can withhold the version stamp. Unused at v1 (no columns to add) but
 * present so a v2 migration is a one-liner.
 */
export function addScorecardColumn(
  db: Database,
  table: string,
  column: string,
  type: string
): boolean {
  if (!/^[a-zA-Z0-9_]+$/.test(table)) {
    throw new Error(`Invalid SQL identifier for table: ${table}`);
  }
  if (!/^[a-zA-Z0-9_]+$/.test(column)) {
    throw new Error(`Invalid SQL identifier for column: ${column}`);
  }
  if (!/^[a-zA-Z0-9_ (),'-]+$/.test(type)) {
    throw new Error(`Invalid SQL type: ${type}`);
  }

  try {
    if (scorecardColumnNames(db, table).has(column)) return true;
    // One statement per call — assigned to a local before exec (never batched).
    const ddl = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
    db.exec(ddl);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("duplicate column")) return true;
    console.error(
      `[Scorecard] Migration failed: ALTER TABLE ${table} ADD COLUMN ${column} ${type}:`,
      error
    );
    return false;
  }
}

/**
 * Apply all pending scorecard migrations. Called from the `ScorecardStore`
 * constructor immediately after `createSchema()`, on every boot — fresh AND
 * existing databases alike.
 *
 * Idempotent: a DB already at `SCORECARD_SCHEMA_VERSION` returns immediately.
 * Never throws — a failure logs and leaves `user_version` unstamped so the next
 * boot retries. At v1 there are no ALTERs, so this only stamps the version once.
 */
export function applyScorecardMigrations(db: Database): void {
  try {
    const current = readUserVersion(db);
    if (current >= SCORECARD_SCHEMA_VERSION) return;

    // v1: initial schema — no incremental ALTERs (createSchema declares every
    // column). Future migrations chain here, e.g.:
    //   let ok = true;
    //   if (current < 2) ok = migrateV2(db) && ok;
    //   ...verify columns, then stamp only if ok.

    const stamp = `PRAGMA user_version = ${SCORECARD_SCHEMA_VERSION}`;
    db.exec(stamp);
  } catch (error) {
    // Fail-open: the scorecard is observability, never a reason to abort boot.
    console.error("[Scorecard] Migration aborted:", error);
  }
}
