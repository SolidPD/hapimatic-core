// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Schema migration for `builtin.session-notes` (issue #1284, Sub-Issue T of
 * epic #1264).
 *
 * Unlike `builtin.scheduler` (#1274), this is a BRAND-NEW feature — there is no
 * legacy core-owned table to rename, so the migration is a pure
 * `CREATE TABLE IF NOT EXISTS` plus its index. That makes it idempotent by
 * construction: every boot re-runs it, and every run after the first is a no-op.
 *
 * Registered via `host.store.addMigration()` and executed by
 * `Store.runExtensionMigrations()`, which F's loader calls AFTER core
 * `initSchema()` — so the `sessions` table this one references already exists.
 *
 * ## Why `ON DELETE CASCADE`
 *
 * Notes are meaningless without their session, and Hapimatic hard-deletes
 * sessions. Cascading at the schema level means a deleted session cannot leave
 * orphaned note rows behind — matching the `messages` table's relationship to
 * `sessions` (`server/src/store/index.ts`). This relies on `PRAGMA foreign_keys`
 * being ON, which core's Store sets at open.
 *
 * ## Why the index is (session_id, created_at)
 *
 * Every read path is "all notes for ONE session, oldest first" — the composite
 * index serves both the filter and the sort, so the list query never sorts at
 * runtime. A bare `session_id` index would still require a sort pass.
 */
import type { Database } from "bun:sqlite";
import type { ExtensionMigration } from "@hapi/protocol/ext";

import { SESSION_NOTES_TABLE } from "./tableNames";

/**
 * DDL statements, one per array entry. The table name is interpolated from the
 * shared constant in `./tableNames` — the SAME constant the query layer imports
 * — so migration and queries address one physical table by construction.
 */
const SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${SESSION_NOTES_TABLE} (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     content TEXT NOT NULL,
     created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
     updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_ext_builtin_session_notes_session_created
     ON ${SESSION_NOTES_TABLE}(session_id, created_at)`,
];

/**
 * Apply the session-notes schema. Safe to call repeatedly — every statement is
 * `IF NOT EXISTS`. Wrapped in a transaction so a mid-run failure cannot leave
 * the table present without its index.
 */
export function migrateSessionNotesTables(db: Database): void {
  const txn = db.transaction(() => {
    for (const statement of SCHEMA_STATEMENTS) {
      db.run(statement);
    }
  });
  txn();
}

/**
 * The {@link ExtensionMigration} passed to `host.store.addMigration()`.
 *
 * `up` receives `unknown` (the shared `ExtensionMigration` contract keeps
 * `shared/` free of a `bun:sqlite` dependency), so it narrows to `Database` at
 * this boundary — the same opaque-then-narrow pattern the host uses for
 * `getRawDb()`.
 */
export const sessionNotesMigration: ExtensionMigration = {
  version: 1,
  up: (db: unknown) => {
    migrateSessionNotesTables(db as Database);
  },
};
