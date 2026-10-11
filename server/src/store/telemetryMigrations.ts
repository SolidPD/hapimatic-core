// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Versioned migrations for `telemetry.db` (issue #2154, epic rp1-home#1312).
 *
 * `telemetry.db` is a SEPARATE database from the main store, and before this
 * module its ONLY DDL was `TelemetryStore.createSchema()` — all
 * `CREATE TABLE IF NOT EXISTS`. That is a silent no-op against an existing
 * database: `IF NOT EXISTS` skips the whole statement, so a column added to the
 * `CREATE TABLE` body never appears on any deployed DB, and every INSERT naming
 * it then throws at runtime. Adding a column therefore REQUIRES an `ALTER TABLE`
 * path; `createSchema()` alone is not sufficient.
 *
 * Two invariants this module exists to hold:
 *
 *   - **Both creation paths must agree.** A *fresh* DB gets the columns from
 *     `createSchema()`'s `CREATE TABLE`; an *existing* DB gets them from the
 *     ALTERs here. `addColumn()`'s `PRAGMA table_info` guard is what lets the
 *     same migration run over both without a "duplicate column name" crash on
 *     the fresh path (the columns are already there, so each ALTER is skipped
 *     and only the version stamp lands).
 *
 *   - **One DDL statement per `exec()` call.** Bun's SQLite driver can silently
 *     truncate multi-statement strings — see the comment in `telemetryStore.ts`
 *     `createSchema()`, which splits its own DDL for exactly this reason. A
 *     batched migration would appear to succeed while applying only its first
 *     statement.
 *
 * `PRAGMA user_version` is the version counter. It is unused by this database
 * (unlike the main store, where it is a frozen mismatch gate), so it is free to
 * carry the telemetry schema version.
 *
 * Deviation from the fail-open house pattern (`store/index.ts` `migrateAddColumn`,
 * `turns/schema.ts`): boot is still never aborted, but the version is stamped
 * ONLY after the expected columns are verified present. Stamping unconditionally
 * would mark a silently-failed migration as done and skip the retry on next boot
 * — reintroducing the exact silent-column-absence failure this module defuses.
 *
 * Migration 2 (issue #3742) departs from the `addColumn` shape: widening the
 * `events.file_type` CHECK to admit `'capability'` is not a column add, and
 * SQLite cannot ALTER a CHECK in place — so `migrateV2` REBUILDS the table
 * (create-new-CHECK, copy rows, drop, rename) inside ONE transaction, then
 * recreates every index. It is idempotent by inspecting the live table's CREATE
 * SQL, so a fresh DB (whose `createSchema` already emits the widened CHECK) is
 * left untouched. The stamp gate additionally verifies the widened CHECK.
 */

/** Current telemetry schema version. Bump when adding a migration below. */
export const TELEMETRY_SCHEMA_VERSION = 2;

/** Columns migration 1 adds to `events`. All nullable — see `migrateV1`. */
const V1_COLUMNS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "input_tokens", type: "INTEGER" },
  { name: "output_tokens", type: "INTEGER" },
  { name: "session_role", type: "TEXT" },
  { name: "repo", type: "TEXT" },
];

function readUserVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return row?.user_version ?? 0;
}

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map(r => r.name));
}

/**
 * Add one column if absent. Mirrors `Store.migrateAddColumn`
 * (`store/index.ts`): identifier validation, `table_info` guard, and a
 * duplicate-column catch for the race between the guard and the ALTER.
 * Returns false on genuine failure so the caller can withhold the version stamp.
 */
function addColumn(
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
    if (columnNames(db, table).has(column)) return true;
    // One statement per call — never batched (see the L2 note in the docblock).
    const ddl = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
    db.exec(ddl);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("duplicate column")) return true;
    console.error(
      `[Telemetry] Migration failed: ALTER TABLE ${table} ADD COLUMN ${column} ${type}:`,
      error
    );
    return false;
  }
}

function createIndex(
  db: Database,
  name: string,
  table: string,
  column: string
): void {
  try {
    // One statement per call — see the L2 note in the docblock.
    const ddl = `CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${column})`;
    db.exec(ddl);
  } catch (error) {
    console.error(`[Telemetry] Migration failed: CREATE INDEX ${name}:`, error);
  }
}

/**
 * Migration 1 — per-invocation token measurement + attribution columns.
 *
 * All four columns are nullable on purpose. Rows written before this migration
 * have no token data, and that absence must stay distinguishable from a measured
 * zero: aggregations filter `NULL` out of the sample rather than coalescing it to
 * 0, or old rows drag every percentile toward zero.
 *
 * `session_role` ships nullable and unpopulated so hapimatic-private#2155 can
 * fill it in without a second migration against this database.
 */
function migrateV1(db: Database): boolean {
  let ok = true;
  for (const { name, type } of V1_COLUMNS) {
    if (!addColumn(db, "events", name, type)) ok = false;
  }
  createIndex(db, "idx_events_role", "events", "session_role");
  createIndex(db, "idx_events_repo", "events", "repo");
  return ok;
}

/** The `events.file_type` CHECK vocabulary after migration 2 (issue #3742). */
const V2_FILE_TYPES = "'skill', 'hook', 'agent', 'capability'";

/** Read the live CREATE SQL of the `events` table (empty string if absent). */
function eventsTableSql(db: Database): string {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'events'"
    )
    .get() as { sql?: string } | undefined;
  return row?.sql ?? "";
}

/**
 * Migration 2 (issue #3742) — widen the `events.file_type` CHECK to admit
 * `'capability'`, so the `cataloged()` middleware can persist capability
 * events. SQLite cannot ALTER a CHECK in place, so this is a standard table
 * REBUILD: a new table with the widened CHECK, copy every row, drop the old
 * table, rename. Wrapped in ONE transaction so a mid-rebuild failure rolls back
 * rather than leaving `events` dropped. Every index is recreated afterward (all
 * are dropped with the old table).
 *
 * Idempotent: a table whose CHECK already lists `'capability'` (a fresh DB built
 * by the updated `createSchema()`, or a re-run) is left untouched. Each rebuild
 * statement is a single-statement `db.run(...)`, which — unlike a batched exec —
 * cannot be truncated by Bun's driver.
 */
function migrateV2(db: Database): boolean {
  try {
    const currentSql = eventsTableSql(db);
    // Fresh DB (createSchema already emits the widened CHECK) or no table yet →
    // nothing to rebuild.
    if (currentSql === "" || currentSql.includes("'capability'")) return true;

    const rebuild = db.transaction(() => {
      db.run("DROP TABLE IF EXISTS events_migrate_v2");
      // ONLY difference from createSchema()'s table is the widened file_type
      // CHECK; the column set mirrors createSchema() + migration 1 exactly.
      db.run(
        `CREATE TABLE events_migrate_v2 (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          file_type TEXT NOT NULL CHECK (file_type IN (${V2_FILE_TYPES})),
          event_type TEXT NOT NULL CHECK (event_type IN ('invocation', 'completion', 'skip', 'error')),
          session_id TEXT,
          timestamp INTEGER NOT NULL,
          duration_ms INTEGER,
          outcome TEXT,
          context_json TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          session_role TEXT,
          repo TEXT
        )`
      );
      db.run(
        `INSERT INTO events_migrate_v2 (id, file_path, file_type, event_type, session_id, timestamp, duration_ms, outcome, context_json, input_tokens, output_tokens, session_role, repo)
         SELECT id, file_path, file_type, event_type, session_id, timestamp, duration_ms, outcome, context_json, input_tokens, output_tokens, session_role, repo FROM events`
      );
      db.run("DROP TABLE events");
      db.run("ALTER TABLE events_migrate_v2 RENAME TO events");
    });
    rebuild();

    // Recreate every index — all were dropped with the old table.
    createIndex(
      db,
      "idx_events_file_timestamp",
      "events",
      "file_path, timestamp"
    );
    createIndex(db, "idx_events_timestamp", "events", "timestamp");
    createIndex(db, "idx_events_session", "events", "session_id");
    createIndex(db, "idx_events_file_type", "events", "file_type");
    createIndex(db, "idx_events_role", "events", "session_role");
    createIndex(db, "idx_events_repo", "events", "repo");
    return true;
  } catch (error) {
    console.error(
      "[Telemetry] Migration v2 (file_type CHECK widen) failed:",
      error
    );
    return false;
  }
}

/**
 * Apply all pending telemetry migrations. Called from the `TelemetryStore`
 * constructor immediately after `createSchema()`, on every boot — fresh AND
 * existing databases alike.
 *
 * Idempotent: a DB already at `TELEMETRY_SCHEMA_VERSION` returns immediately,
 * and each migration is independently re-runnable via its `table_info` guard.
 * Never throws — a migration failure logs and leaves `user_version` unstamped so
 * the next boot retries.
 */
export function applyTelemetryMigrations(db: Database): void {
  try {
    const current = readUserVersion(db);
    if (current >= TELEMETRY_SCHEMA_VERSION) return;

    let ok = true;
    if (current < 1) ok = migrateV1(db) && ok;
    if (current < 2) ok = migrateV2(db) && ok;

    // Verify before stamping: a stamped-but-unapplied version would skip the
    // retry on next boot and leave INSERTs naming absent columns (v1) or a
    // capability write rejected by a stale file_type CHECK (v2).
    const present = columnNames(db, "events");
    const missing = V1_COLUMNS.filter(c => !present.has(c.name)).map(
      c => c.name
    );
    const checkWidened = eventsTableSql(db).includes("'capability'");
    if (!ok || missing.length > 0 || !checkWidened) {
      console.error(
        `[Telemetry] Migration to v${TELEMETRY_SCHEMA_VERSION} incomplete — missing columns: ${
          missing.join(", ") || "(none reported)"
        }${
          checkWidened ? "" : "; file_type CHECK not widened to 'capability'"
        }. Leaving user_version at ${current} so the next boot retries.`
      );
      return;
    }

    const stamp = `PRAGMA user_version = ${TELEMETRY_SCHEMA_VERSION}`;
    db.exec(stamp);
  } catch (error) {
    // Fail-open: telemetry is observability, never a reason to abort boot.
    console.error("[Telemetry] Migration aborted:", error);
  }
}
