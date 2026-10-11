// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One-time table-rename migration for `builtin.scheduler` (issue #1274,
 * Sub-Issue J of epic #1264).
 *
 * Moves the two scheduler tables from core-owned names to the extension-prefixed
 * names the extension system reserves for `builtin.scheduler`:
 *
 *   scheduled_tasks  → ext_builtin_scheduler_tasks
 *   task_executions  → ext_builtin_scheduler_task_executions
 *
 * Registered via `host.store.addMigration()` and executed by
 * `Store.runExtensionMigrations()`, which F's loader calls AFTER core
 * `initSchema()` — so every core migration has already run when this executes.
 *
 * ## Idempotency matrix
 *
 * | Legacy present | New present | Behavior                                  |
 * |----------------|-------------|-------------------------------------------|
 * | no             | no          | fresh install → CREATE with full schema   |
 * | yes            | no          | ALTER TABLE RENAME (data preserved)       |
 * | no             | yes         | already migrated → no-op                  |
 * | yes            | yes         | zombie legacy: dropped iff EMPTY, else    |
 * |                |             | left in place and reported (needs a human)|
 *
 * ## Why the full schema is spelled out here
 *
 * Before this migration, the canonical `scheduled_tasks` shape was the UNION of
 * two core mechanisms in `server/src/store/index.ts`:
 *
 *   1. a `CREATE TABLE IF NOT EXISTS scheduled_tasks (…)` block, and
 *   2. ~20 `migrateAddColumn("scheduled_tasks", …)` calls that patched in every
 *      column added since.
 *
 * Those two masked each other: the CREATE block is missing four columns
 * (`session_type`, `worktree_branch_name`, `pre_work_instructions`,
 * `closing_instructions`) and the `migrateAddColumn` loop silently supplied them
 * on the next boot. Once the table is renamed, every
 * `migrateAddColumn("scheduled_tasks", …)` becomes a no-op against a table that
 * no longer exists — so copying the CREATE block alone would ship 36-column
 * tables to fresh installs while the query layer reads 40, failing at
 * task-execution time rather than at boot.
 *
 * The 40 columns below were reconciled against three sources and verified equal:
 * the live `PRAGMA table_info` of a running instance, the core CREATE block, and
 * the programmatically enumerated `migrateAddColumn` list. Column ORDER matches
 * what a fresh install produces today (core CREATE block, then `migrateAddColumn`
 * order) so `SELECT *` positions are unchanged.
 *
 * ## NOT NULL convergence
 *
 * `event_count_current`, `heartbeat_mode`, and `run_once_at_launch` are declared
 * NULLABLE-with-DEFAULT here. Core declared them `NOT NULL DEFAULT 0` in its
 * fresh-install block but added them via `migrateAddColumn` as plain
 * `INTEGER DEFAULT 0` — SQLite cannot add a NOT NULL column without a default,
 * so every UPGRADED database in the field has them nullable. Choosing the
 * nullable form makes fresh installs match the existing fleet instead of
 * perpetuating the split, and is strictly more permissive (no INSERT that
 * succeeds today can begin to fail).
 *
 * ## Index handling
 *
 * `ALTER TABLE … RENAME TO` does NOT rename indexes — they stay attached to the
 * renamed table under their original `idx_scheduled_tasks_*` /
 * `idx_task_executions_*` names. Phase 1b drops those legacy names so the
 * ext-prefixed `CREATE INDEX` statements in phase 2 do not create duplicate
 * indexes over the same columns.
 *
 * ## Foreign key
 *
 * `task_executions.task_id` REFERENCES `scheduled_tasks(id)`. SQLite rewrites
 * that reference automatically when the referenced table is renamed (default
 * `legacy_alter_table=off`), so the tasks table is renamed FIRST and the FK
 * follows it to the new name. `migration.test.ts` asserts this rather than
 * assuming it.
 *
 * ## Phase 3 — executions-table rebuild (#2701)
 *
 * The executions status CHECK gains `completed`, and two nullable reap columns
 * are appended. SQLite cannot ALTER a CHECK, so an existing table is rebuilt
 * (create `_new` → copy → drop → rename → re-index) inside the same transaction.
 * The step inspects the live schema and no-ops once done: extension migrations
 * re-run on every boot, and `schedulerMigration.version` is metadata only.
 */
import type { Database } from "bun:sqlite";
import type { ExtensionMigration } from "@hapi/protocol/ext";

import { SCHEDULER_EXECS_TABLE, SCHEDULER_TASKS_TABLE } from "./tableNames";

const LEGACY_TASKS = "scheduled_tasks";
const LEGACY_EXECS = "task_executions";

// Target names come from `./tableNames` — the SAME constants the query layer
// imports, so the migration and the queries address one set of physical tables
// by construction. Declaring a second pair of names here is how you get a
// scheduler that migrates cleanly and then throws `no such table` on its first
// query (#1274).

/**
 * The executions-table DDL, shared by the fresh-install CREATE and the Phase 3
 * rebuild so the two can never drift apart.
 *
 * #2701 (epic #2698 F5): the status CHECK gains `completed`, and two nullable
 * columns are appended LAST (so `SELECT *` column positions are unchanged):
 * `reaped_at` + `reap_reason` record how the reaper freed the slot. The reason
 * is deliberately NOT CHECK-constrained — later reaper layers add reasons
 * without another table rebuild. `ON DELETE CASCADE` is kept: #2701 defers the
 * one-shot delete until the session is reaped rather than changing the FK.
 */
function executionsTableDdl(tableName: string): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES ${SCHEDULER_TASKS_TABLE}(id) ON DELETE CASCADE,
    session_id TEXT,
    scheduled_for INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'delivered', 'failed', 'timed_out', 'skipped', 'completed')),
    error_message TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    reaped_at INTEGER,
    reap_reason TEXT
  )`;
}

const EXECS_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_ext_builtin_scheduler_execs_task_id
    ON ${SCHEDULER_EXECS_TABLE}(task_id)`;

/**
 * Full canonical schema — core's fresh-install CREATE block plus every column
 * core added via `migrateAddColumn`, in fresh-install order. See the file
 * docstring for how this list was reconciled and why it must be complete.
 */
const FULL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${SCHEDULER_TASKS_TABLE} (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT,
    prompt TEXT NOT NULL,
    project_directory TEXT NOT NULL,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('at', 'every', 'cron')),
    cron_expression TEXT,
    scheduled_at INTEGER,
    interval_ms INTEGER,
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    enabled INTEGER NOT NULL DEFAULT 1,
    delete_after_run INTEGER NOT NULL DEFAULT 0,
    max_runtime_ms INTEGER,
    notify_on TEXT DEFAULT 'both',
    overlap_policy TEXT DEFAULT 'skip',
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    last_session_id TEXT,
    namespace TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    last_executed_at INTEGER,
    next_execution_at INTEGER,
    operating_schedule TEXT,
    exclusion_schedule TEXT,
    lifetime_start INTEGER,
    lifetime_end INTEGER,
    event_count_limit INTEGER,
    event_count_current INTEGER DEFAULT 0,
    jitter_max_ms INTEGER,
    heartbeat_mode INTEGER DEFAULT 0,
    standing_orders TEXT,
    ack_max_chars INTEGER,
    rotation_config TEXT,
    backoff_config TEXT,
    run_once_at_launch INTEGER DEFAULT 0,
    dst_adjustment TEXT,
    session_type TEXT DEFAULT 'simple',
    worktree_branch_name TEXT,
    pre_work_instructions TEXT,
    closing_instructions TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ext_builtin_scheduler_tasks_next
    ON ${SCHEDULER_TASKS_TABLE}(next_execution_at) WHERE enabled = 1;

  ${executionsTableDdl(SCHEDULER_EXECS_TABLE)};

  ${EXECS_INDEX_DDL};
`;

/** Structured report of what the migration did — consumed by tests and logging. */
export interface SchedulerMigrationResult {
  renamedTasks: boolean;
  renamedExecs: boolean;
  droppedZombieTables: readonly string[];
  /** Legacy tables left in place because they still hold rows (needs a human). */
  conflictingTables: readonly string[];
  droppedLegacyIndexes: readonly string[];
  /**
   * True when Phase 3 rebuilt the executions table to widen its status CHECK
   * and add the reap columns (#2701). False on every later boot — the rebuild
   * detects its own completion because extension-migration `version` is
   * metadata only and `up` re-runs on every boot.
   */
  widenedExecutions: boolean;
}

const tableExists = (db: Database, name: string): boolean =>
  Boolean(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(name)
  );

const rowCount = (db: Database, table: string): number =>
  (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;

/**
 * Apply the scheduler table migration. Safe to call repeatedly — see the
 * idempotency matrix in the file docstring.
 *
 * Returns a {@link SchedulerMigrationResult} describing what changed, so
 * callers can log a meaningful one-liner and tests can assert precisely.
 */
export function migrateSchedulerTables(db: Database): SchedulerMigrationResult {
  const renamed: string[] = [];
  const droppedZombieTables: string[] = [];
  const conflictingTables: string[] = [];
  const droppedLegacyIndexes: string[] = [];
  let widenedExecutions = false;

  // Whole migration is one transaction: a failure partway through must not
  // leave the database with one table renamed and the other not (which would
  // break the task_executions → scheduled_tasks foreign key).
  const txn = db.transaction(() => {
    // ── Phase 1: rename legacy → prefixed. Tasks FIRST so the executions FK
    // follows the referenced table to its new name.
    for (const [legacy, next] of [
      [LEGACY_TASKS, SCHEDULER_TASKS_TABLE],
      [LEGACY_EXECS, SCHEDULER_EXECS_TABLE],
    ] as const) {
      const hasLegacy = tableExists(db, legacy);
      const hasNext = tableExists(db, next);

      if (hasLegacy && !hasNext) {
        db.run(`ALTER TABLE ${legacy} RENAME TO ${next}`);
        renamed.push(legacy);
        continue;
      }

      if (hasLegacy && hasNext) {
        // Both present. The expected cause is a ZOMBIE: core's
        // `CREATE TABLE IF NOT EXISTS` re-created an empty legacy table on a
        // boot after this migration already ran. Dropping an empty table is
        // safe and stops the confusion from recurring. A legacy table with
        // ROWS is a genuine split-brain we must not silently resolve —
        // choosing either side would lose data.
        if (rowCount(db, legacy) === 0) {
          db.run(`DROP TABLE ${legacy}`);
          droppedZombieTables.push(legacy);
        } else {
          conflictingTables.push(legacy);
        }
      }
    }

    // ── Phase 1b: drop legacy-named indexes carried over by the rename.
    const legacyIndexes = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND (name LIKE 'idx_scheduled_tasks_%' OR name LIKE 'idx_task_executions_%')`
      )
      .all() as Array<{ name: string }>;
    for (const { name } of legacyIndexes) {
      db.run(`DROP INDEX IF EXISTS ${name}`);
      droppedLegacyIndexes.push(name);
    }

    // ── Phase 2: ensure the prefixed tables exist with the full schema.
    // No-op after a rename (IF NOT EXISTS); creates everything on a fresh
    // install, which is the ONLY path that ever sees these CREATE statements
    // once core's own scheduler DDL is removed (Task 13).
    db.exec(FULL_SCHEMA);

    // ── Phase 3 (#2701): rebuild an existing executions table whose CHECK
    // predates `completed` or which lacks the reap columns. A fresh install
    // already has the current shape from phase 2, so this is a no-op there.
    widenedExecutions = widenExecutionsTableIfNeeded(db);
  });

  txn();

  return {
    renamedTasks: renamed.includes(LEGACY_TASKS),
    renamedExecs: renamed.includes(LEGACY_EXECS),
    droppedZombieTables,
    conflictingTables,
    droppedLegacyIndexes,
    widenedExecutions,
  };
}

/** Columns the #2701 executions table must carry. */
const REAP_COLUMNS = ["reaped_at", "reap_reason"] as const;

const columnNames = (db: Database, table: string): string[] =>
  (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map(c => c.name);

/**
 * Self-detecting rebuild of the executions table (#2701). Extension migrations
 * re-run on EVERY boot (`host.store.addMigration` wraps `up`;
 * `Store.runExtensionMigrations` replays each queued `up` — `version` is
 * metadata only), so this step decides from the live schema whether it has
 * already happened. SQLite cannot ALTER a CHECK, so widening it means the
 * standard rebuild: create `<table>_new` → copy rows → drop → rename →
 * re-create the index (a dropped table takes its indexes with it).
 *
 * Runs inside the caller's transaction, so a failure leaves the old table
 * intact. Returns true when it rebuilt the table.
 */
function widenExecutionsTableIfNeeded(db: Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(SCHEDULER_EXECS_TABLE) as { sql: string } | null;
  if (!row) return false;

  const existing = columnNames(db, SCHEDULER_EXECS_TABLE);
  const hasCompleted = row.sql.includes("'completed'");
  const hasReapColumns = REAP_COLUMNS.every(c => existing.includes(c));
  if (hasCompleted && hasReapColumns) return false;

  const tmp = `${SCHEDULER_EXECS_TABLE}_new`;
  db.run(`DROP TABLE IF EXISTS ${tmp}`);
  db.run(executionsTableDdl(tmp));
  // Copy every column both shapes share, so a table with any older column set
  // keeps all of its data.
  const shared = columnNames(db, tmp)
    .filter(c => existing.includes(c))
    .join(", ");
  db.run(
    `INSERT INTO ${tmp} (${shared}) SELECT ${shared} FROM ${SCHEDULER_EXECS_TABLE}`
  );
  db.run(`DROP TABLE ${SCHEDULER_EXECS_TABLE}`);
  db.run(`ALTER TABLE ${tmp} RENAME TO ${SCHEDULER_EXECS_TABLE}`);
  db.run(EXECS_INDEX_DDL);
  return true;
}

/**
 * The {@link ExtensionMigration} passed to `host.store.addMigration()`.
 *
 * `up` receives `unknown` (the shared `ExtensionMigration` contract keeps
 * `shared/` free of a `bun:sqlite` dependency), so it narrows to `Database` at
 * this boundary — the same opaque-then-narrow pattern the host uses for
 * `getRawDb()`.
 */
export const schedulerMigration: ExtensionMigration = {
  version: 1,
  up: (db: unknown) => {
    migrateSchedulerTables(db as Database);
  },
};
