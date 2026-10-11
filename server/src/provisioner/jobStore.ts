// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SQLite job store (issue #2468, R5 — records carry no secrets).
 *
 * Bun built-in SQLite (`bun:sqlite`), no ORM, synchronous queries — the house
 * pattern (`server/src/store/timeLogStore.ts`, the scheduler store). Structural
 * R5 guarantee: the schema has NO column for a secret value or a secret env-var
 * name. `argv` holds only positionals + allowlisted flags (subdomain, email,
 * tier, …) — the scripts read every secret (`TS_AUTHKEY`, `CF_API_TOKEN`,
 * `GATEWAY_REGISTRATION_TOKEN`, inventory `access_token`, …) from the process
 * ENVIRONMENT, never from argv — so a secret cannot reach a row.
 */

import type { Database } from "bun:sqlite";

import type { ActionItem, JobRecord, JobResultJson, JobState } from "./types";

export const PROVISIONER_JOBS_TABLE = "provisioner_jobs";
export const PROVISIONER_SCHEMA_VERSION = 1;

// Full DDL as a pre-assigned const (interpolating the table name + schema
// version here, NOT at the `.exec()` call site) — mirrors the house idiom
// `db.exec(FULL_SCHEMA)` in server/src/extensions/scheduler/migration.ts.
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${PROVISIONER_JOBS_TABLE} (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    script_path TEXT NOT NULL,
    argv TEXT NOT NULL,            -- JSON array of strings
    state TEXT NOT NULL CHECK (state IN ('queued','running','succeeded','failed','capacity-waiting')),
    mutating INTEGER NOT NULL DEFAULT 0,
    log_path TEXT NOT NULL,
    unit_name TEXT NOT NULL,
    exit_code INTEGER,
    action_items TEXT,            -- JSON array of strings, nullable
    result TEXT,                  -- JSON document, nullable
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    started_at INTEGER,
    finished_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_${PROVISIONER_JOBS_TABLE}_state
    ON ${PROVISIONER_JOBS_TABLE}(state);

  PRAGMA user_version = ${PROVISIONER_SCHEMA_VERSION};
`;

/** Physical row shape (snake_case, JSON-as-text, booleans as 0/1). */
interface JobRow {
  id: string;
  kind: string;
  script_path: string;
  argv: string;
  state: string;
  mutating: number;
  log_path: string;
  unit_name: string;
  exit_code: number | null;
  action_items: string | null;
  result: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

function rowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind as JobRecord["kind"],
    scriptPath: row.script_path,
    argv: JSON.parse(row.argv) as string[],
    state: row.state as JobState,
    mutating: row.mutating === 1,
    logPath: row.log_path,
    unitName: row.unit_name,
    exitCode: row.exit_code,
    actionItems:
      row.action_items === null
        ? null
        : (JSON.parse(row.action_items) as ActionItem[]),
    result:
      row.result === null ? null : (JSON.parse(row.result) as JobResultJson),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Thin store over one `Database`. Inject a `new Database(":memory:")` in tests;
 * #2469 injects the server's core DB. Ensures its own schema on construction so
 * a caller need not run a separate migration step.
 */
export class JobStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA_SQL);
  }

  /** Insert a fully-formed record (runner assigns id/unit/log/timestamps). */
  create(record: JobRecord): JobRecord {
    this.db
      .prepare(
        `INSERT INTO ${PROVISIONER_JOBS_TABLE}
           (id, kind, script_path, argv, state, mutating, log_path, unit_name,
            exit_code, action_items, result, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.kind,
        record.scriptPath,
        JSON.stringify(record.argv),
        record.state,
        record.mutating ? 1 : 0,
        record.logPath,
        record.unitName,
        record.exitCode,
        record.actionItems === null ? null : JSON.stringify(record.actionItems),
        record.result === null || record.result === undefined
          ? null
          : JSON.stringify(record.result),
        record.createdAt,
        record.startedAt,
        record.finishedAt
      );
    return record;
  }

  get(id: string): JobRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM ${PROVISIONER_JOBS_TABLE} WHERE id = ?`)
      .get(id) as JobRow | null;
    return row ? rowToRecord(row) : null;
  }

  list(): JobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${PROVISIONER_JOBS_TABLE} ORDER BY created_at DESC`
      )
      .all() as JobRow[];
    return rows.map(rowToRecord);
  }

  /** For re-attach: enumerate persisted jobs in a given state (e.g. running). */
  listByState(state: JobState): JobRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${PROVISIONER_JOBS_TABLE} WHERE state = ? ORDER BY created_at ASC`
      )
      .all(state) as JobRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Update a job's state, optionally stamping `started_at` / `finished_at`.
   * Passing a field sets it; omitting it leaves the stored value untouched.
   */
  updateState(
    id: string,
    state: JobState,
    patch: { startedAt?: number; finishedAt?: number } = {}
  ): void {
    this.db
      .prepare(
        `UPDATE ${PROVISIONER_JOBS_TABLE}
           SET state = ?,
               started_at = COALESCE(?, started_at),
               finished_at = COALESCE(?, finished_at)
         WHERE id = ?`
      )
      .run(state, patch.startedAt ?? null, patch.finishedAt ?? null, id);
  }

  setActionItems(id: string, items: ActionItem[]): void {
    this.db
      .prepare(
        `UPDATE ${PROVISIONER_JOBS_TABLE} SET action_items = ? WHERE id = ?`
      )
      .run(JSON.stringify(items), id);
  }

  setResult(id: string, result: JobResultJson): void {
    this.db
      .prepare(`UPDATE ${PROVISIONER_JOBS_TABLE} SET result = ? WHERE id = ?`)
      .run(
        result === null || result === undefined ? null : JSON.stringify(result),
        id
      );
  }

  setExit(id: string, exitCode: number): void {
    this.db
      .prepare(
        `UPDATE ${PROVISIONER_JOBS_TABLE} SET exit_code = ? WHERE id = ?`
      )
      .run(exitCode, id);
  }
}
