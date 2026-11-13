// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Billable-time schema (issue #6586): every table, index and trigger of this
 * feature. Called from `Store.runMigrations()`.
 *
 * It only creates: `runMigrations()` runs on every `new Store(path)`, which
 * includes a second server process on the same data directory and every test, and
 * none of those callers knows the node id or the mode. Rows written at boot belong
 * to `runBillableStartup` (`./startup.ts`), which the entry point calls once.
 *
 * House pattern (`store/turns/schema.ts`): `CREATE … IF NOT EXISTS`, each table
 * block in its own try/catch that logs and continues, so a DDL error never aborts
 * the boot. Causes are plain TEXT with no CHECK (the K1 rule of
 * `store/turns/types.ts`). There is no foreign key to `sessions` (R2): interval
 * rows survive a session delete.
 *
 * DDL is held in constants so each call reads `db.exec(NAME)`.
 */

/**
 * `thinking_intervals`: one row per billable interval, plus the balance rows
 * (`opening_balance`, `carried_forward`), which are undated (start = end = the
 * boot time, `duration_ms` = the carried amount). Every other closed row keeps
 * `ended_at_ms = started_at_ms + duration_ms`. There is no `turn_seq` column: the
 * tracker has no turn knowledge, so a consumer maps an interval to turns by time.
 */
const THINKING_INTERVALS_DDL = `
  CREATE TABLE IF NOT EXISTS thinking_intervals (
    id                    TEXT PRIMARY KEY,
    hapi_session_id       TEXT NOT NULL,
    namespace             TEXT NOT NULL,
    node_id               TEXT NOT NULL,
    launcher_kind         TEXT NOT NULL,
    recorded_mode         TEXT NOT NULL,
    stretch_started_at_ms INTEGER NOT NULL,
    started_at_ms         INTEGER NOT NULL,
    last_seen_at_ms       INTEGER NOT NULL,
    ended_at_ms           INTEGER,
    duration_ms           INTEGER,
    start_cause           TEXT NOT NULL,
    end_cause             TEXT,
    session_name          TEXT,
    linked_issue          TEXT,
    cwd                   TEXT,
    flags                 TEXT,
    change_seq            INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_thinking_intervals_one_open
    ON thinking_intervals(hapi_session_id) WHERE ended_at_ms IS NULL;
  CREATE INDEX IF NOT EXISTS idx_thinking_intervals_session_start
    ON thinking_intervals(hapi_session_id, started_at_ms);
  CREATE INDEX IF NOT EXISTS idx_thinking_intervals_start
    ON thinking_intervals(started_at_ms);
  CREATE INDEX IF NOT EXISTS idx_thinking_intervals_change_seq
    ON thinking_intervals(change_seq);
`;

/**
 * `change_seq` on the `turns` shape (`store/turns/schema.ts`), with narrower
 * guards: an open row keeps `change_seq` NULL, a row gets a new value when it is
 * inserted closed or when a close column changes, and a touch (a
 * `last_seen_at_ms` write) never bumps it, because the interval feed re-serves
 * every row whose `change_seq` moves and a touch every 14 s would re-send rows to
 * every peer. The AFTER INSERT trigger's inner UPDATE changes `change_seq`, so the
 * UPDATE trigger's `NEW.change_seq IS OLD.change_seq` guard keeps it from firing
 * a second time.
 */
const THINKING_INTERVAL_CHANGE_SEQ_DDL = `
  CREATE TABLE IF NOT EXISTS thinking_interval_change_seq (
    id    INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO thinking_interval_change_seq (id, value) VALUES (1, 0);

  CREATE TRIGGER IF NOT EXISTS thinking_intervals_change_seq_ai
    AFTER INSERT ON thinking_intervals
    WHEN NEW.ended_at_ms IS NOT NULL BEGIN
    UPDATE thinking_interval_change_seq SET value = value + 1 WHERE id = 1;
    UPDATE thinking_intervals
      SET change_seq = (SELECT value FROM thinking_interval_change_seq WHERE id = 1)
      WHERE id = NEW.id;
  END;
  CREATE TRIGGER IF NOT EXISTS thinking_intervals_change_seq_au
    AFTER UPDATE ON thinking_intervals
    WHEN NEW.change_seq IS OLD.change_seq
      AND (NEW.ended_at_ms IS NOT OLD.ended_at_ms
        OR NEW.duration_ms IS NOT OLD.duration_ms
        OR NEW.end_cause IS NOT OLD.end_cause) BEGIN
    UPDATE thinking_interval_change_seq SET value = value + 1 WHERE id = 1;
    UPDATE thinking_intervals
      SET change_seq = (SELECT value FROM thinking_interval_change_seq WHERE id = 1)
      WHERE id = NEW.id;
  END;
`;

/**
 * `billable_shadow_stretches`: the old clock's stretches, written in `shadow`
 * only, beside the tracker's three measurements of each and the wait the
 * session's own request records give for it.
 */
const BILLABLE_SHADOW_STRETCHES_DDL = `
  CREATE TABLE IF NOT EXISTS billable_shadow_stretches (
    id                    TEXT PRIMARY KEY,
    hapi_session_id       TEXT NOT NULL,
    namespace             TEXT NOT NULL,
    node_id               TEXT NOT NULL,
    stretch_started_at_ms INTEGER NOT NULL,
    legacy_ended_at_ms    INTEGER NOT NULL,
    legacy_ms             INTEGER NOT NULL,
    intervals_ms          INTEGER NOT NULL,
    wait_ms               INTEGER NOT NULL,
    trim_ms               INTEGER NOT NULL,
    launcher_kind         TEXT NOT NULL,
    wait_ref_ms           INTEGER NOT NULL,
    wait_ref_incomplete   INTEGER NOT NULL,
    sweep_gap_ms          INTEGER NOT NULL,
    site                  TEXT NOT NULL,
    recorded_at_ms        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_billable_shadow_stretches_session
    ON billable_shadow_stretches(hapi_session_id, stretch_started_at_ms);
`;

/** `billable_reconcile`: the daily check's run and detail rows. */
const BILLABLE_RECONCILE_DDL = `
  CREATE TABLE IF NOT EXISTS billable_reconcile (
    run_id                TEXT NOT NULL,
    run_at_ms             INTEGER NOT NULL,
    row_type              TEXT NOT NULL,
    mode                  TEXT NOT NULL,
    kind                  TEXT,
    namespace             TEXT,
    hapi_session_id       TEXT,
    interval_id           TEXT,
    stretch_started_at_ms INTEGER,
    a_ms                  INTEGER,
    b_ms                  INTEGER,
    diff_ms               INTEGER,
    detail_json           TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_billable_reconcile_run_at
    ON billable_reconcile(run_at_ms);
  CREATE INDEX IF NOT EXISTS idx_billable_reconcile_run_namespace
    ON billable_reconcile(run_id, namespace);
`;

/**
 * `thinking_intervals_mirror`: peers' closed intervals (the `turn_mirror` shape
 * plus projected columns, NOT NULL because the feed serves closed rows only).
 */
const THINKING_INTERVALS_MIRROR_DDL = `
  CREATE TABLE IF NOT EXISTS thinking_intervals_mirror (
    origin_node_id     TEXT NOT NULL,
    origin_incarnation TEXT NOT NULL,
    interval_id        TEXT NOT NULL,
    origin_change_seq  INTEGER NOT NULL,
    hapi_session_id    TEXT NOT NULL,
    namespace          TEXT NOT NULL,
    launcher_kind      TEXT NOT NULL,
    started_at_ms      INTEGER NOT NULL,
    ended_at_ms        INTEGER NOT NULL,
    duration_ms        INTEGER NOT NULL,
    end_cause          TEXT NOT NULL,
    row_json           TEXT NOT NULL,
    mirrored_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (origin_node_id, origin_incarnation, interval_id)
  );
  CREATE INDEX IF NOT EXISTS idx_thinking_intervals_mirror_session_start
    ON thinking_intervals_mirror(hapi_session_id, started_at_ms);
`;

/**
 * `thinking_interval_mirror_cursor`: one row per origin. `origin_incarnation` is
 * the empty string until the origin has served a page, because an origin that has
 * never served one still needs a row to hold its `feed_state`.
 */
const THINKING_INTERVAL_MIRROR_CURSOR_DDL = `
  CREATE TABLE IF NOT EXISTS thinking_interval_mirror_cursor (
    origin_node_id      TEXT PRIMARY KEY,
    origin_incarnation  TEXT NOT NULL,
    cursor              INTEGER NOT NULL DEFAULT 0,
    feed_state          TEXT NOT NULL,
    origin_mode         TEXT,
    last_origin_max_seq INTEGER,
    last_sync_at_ms     INTEGER,
    last_attempt_at_ms  INTEGER
  );
`;

function applyBlock(db: Database, name: string, ddl: string): void {
  try {
    db.exec(ddl);
  } catch (error) {
    console.error(`[Store] Migration failed: ${name} (#6586):`, error);
  }
}

export function applyBillableMigrations(db: Database): void {
  applyBlock(db, "thinking_intervals", THINKING_INTERVALS_DDL);
  applyBlock(
    db,
    "thinking_interval_change_seq",
    THINKING_INTERVAL_CHANGE_SEQ_DDL
  );
  applyBlock(db, "billable_shadow_stretches", BILLABLE_SHADOW_STRETCHES_DDL);
  applyBlock(db, "billable_reconcile", BILLABLE_RECONCILE_DDL);
  applyBlock(db, "thinking_intervals_mirror", THINKING_INTERVALS_MIRROR_DDL);
  applyBlock(
    db,
    "thinking_interval_mirror_cursor",
    THINKING_INTERVAL_MIRROR_CURSOR_DDL
  );
}
