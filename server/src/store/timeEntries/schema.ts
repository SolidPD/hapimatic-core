// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan section 3.2): the eleven tables of the time-entry record.
 *
 * House pattern (#6646, #6779): `CREATE … IF NOT EXISTS`, each statement in its
 * own log-and-continue `try`, called from `Store.runMigrations()` after the
 * billing-category tables, on every boot whatever the gate (D-10). No CHECK
 * except the keys, no foreign key (an entry outlives its session, 3.4), value
 * domains in the one writer (#6778 ruling 10). Nothing is written at boot.
 *
 * `IF NOT EXISTS` leaves a shipped table as it is, so `hasTimeEntryStorage`
 * compares the columns of every table, not only the names (#6778's check), and
 * from PR-2 on every change to a column list is a `migrateAddColumn`, never a
 * change of the text below.
 *
 * The DDL and the column list the check reads are built from one definition,
 * so they cannot drift apart.
 */
import type { Database } from "bun:sqlite";

export const TIME_ENTRY_TABLES = [
  "time_entries",
  "time_entry_events",
  "time_entry_coverage",
  "time_entry_sync",
  "time_entry_timer_marks",
  "time_entry_cuts",
  "time_entry_epochs",
  "time_entry_copy_state",
  "time_entry_runs",
  "time_entry_baselines",
  "time_entry_exclusions",
] as const;
export type TimeEntryTable = (typeof TIME_ENTRY_TABLES)[number];

type Column = readonly [name: string, type: string];
type TableDef = {
  columns: readonly Column[];
  /** Table constraints after the columns: the keys only. */
  keys: readonly string[];
};

const TEXT = "TEXT";
const TEXT_NN = "TEXT NOT NULL";
const INT = "INTEGER";
const INT_NN = "INTEGER NOT NULL";

const TABLE_DEFS: Record<TimeEntryTable, TableDef> = {
  // id: te:<session>:<n> | tv:<entry> | tr:<entry> | th:<run>:<receipt>
  time_entries: {
    columns: [
      ["id", "TEXT PRIMARY KEY"],
      ["namespace", TEXT_NN],
      ["session_id", TEXT_NN],
      /** 1, 2, 3 … per (namespace, session_id), kind `time` only. */
      ["ordinal", INT],
      /** The node that ran the session. */
      ["origin_node_id", TEXT_NN],
      ["kind", TEXT_NN],
      /** A void's entry; a relog's voided entry. */
      ["refers_to", TEXT],
      ["source", TEXT_NN],
      ["night", TEXT],
      ["work_date", TEXT_NN],
      ["zone", TEXT_NN],
      ["late", INT_NN],
      /** Negative on a void. */
      ["minutes", INT_NN],
      /** intervals | timer | turns (the larger part). */
      ["basis", TEXT_NN],
      /** { interval, counter }, both set only on a switch night. */
      ["basis_ms_json", TEXT],
      /** Counter lane: the readings the time lies between. */
      ["read_from_at", INT],
      ["read_to_at", INT],
      /** Counter lane: the session's counter epoch (0 until a restore; 4.2). */
      ["epoch", INT_NN],
      ["measured_ms", INT_NN],
      ["carry_in_ms", INT_NN],
      ["carry_out_ms", INT_NN],
      ["period_event_id", INT],
      ["period_begin_event_id", INT],
      ["period_from", INT],
      ["period_to", INT],
      /** Null on the counter lane. */
      ["first_ms", INT],
      ["last_ms", INT],
      /** Per launcher kind; on the counter lane the session's kind (OC-11). */
      ["launcher_ms_json", TEXT],
      ["turns_json", TEXT],
      ["project_kind", TEXT_NN],
      ["project_key", TEXT_NN],
      ["project_name", TEXT_NN],
      /** The session's own repository or path, as measured (item 31). */
      ["repo_key", TEXT],
      /** The record's sync selection, as measured. */
      ["external_json", TEXT],
      ["status_made", TEXT_NN],
      ["held", INT_NN],
      /** The status the held period copied (D-5; item 26). */
      ["held_status", TEXT],
      ["category_source", TEXT],
      ["category_id", TEXT],
      ["category_name", TEXT],
      ["default_rate_minor", INT],
      ["default_currency", TEXT],
      ["rate_minor", INT],
      ["currency", TEXT],
      ["rate_note", TEXT],
      ["complete", INT_NN],
      ["value_minor", INT],
      /** Why a value could not be computed (item 30). */
      ["value_reason", TEXT],
      /** A historical entry that is the old path's settlement (Q2). */
      ["settles_baseline", "INTEGER NOT NULL DEFAULT 0"],
      ["session_name", TEXT],
      ["logged_at", INT_NN],
      // The projection: changed only with an event row, in one transaction.
      ["status", TEXT_NN],
      ["billable_since", TEXT],
      ["current_project_kind", TEXT_NN],
      ["current_project_key", TEXT_NN],
      ["current_project_name", TEXT_NN],
      /** The external target after a carry (#6782; item 31). */
      ["current_external_json", TEXT],
      ["voided_by", TEXT],
      ["last_event_id", INT_NN],
    ],
    keys: [],
  },
  // Append-only status history (section 7).
  time_entry_events: {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["namespace", TEXT_NN],
      ["entry_id", TEXT_NN],
      /** made | decision | hold-kept | hold-reversed | hold-lapsed | completed | voided */
      ["kind", TEXT_NN],
      ["status_before", TEXT],
      ["status_after", TEXT],
      /** Project JSON carries the external target too. */
      ["project_before_json", TEXT],
      ["project_after_json", TEXT],
      ["billable_since_before", TEXT],
      ["billable_since_after", TEXT],
      ["effective_date", TEXT],
      /** The zone of effective_date (item 25). */
      ["zone", TEXT],
      ["actor_kind", TEXT_NN],
      ["actor_session_id", TEXT],
      ["actor_user_agent", TEXT],
      ["via", TEXT_NN],
      ["note", TEXT],
      ["source_event_id", INT],
      ["at", INT_NN],
    ],
    keys: [],
  },
  // Which measured time an entry or an exclusion took.
  time_entry_coverage: {
    columns: [
      ["namespace", TEXT_NN],
      ["session_id", TEXT_NN],
      /** interval | counter */
      ["lane", TEXT_NN],
      /** The interval id; on the counter lane 'e<epoch>'. */
      ["key", TEXT_NN],
      ["from_ms", INT_NN],
      ["to_ms", INT_NN],
      /** The entry id, or an exclusion id 'tx:…' (Q1). */
      ["owner_id", TEXT_NN],
    ],
    keys: [
      "PRIMARY KEY (namespace, session_id, lane, key, from_ms)",
      "CHECK (to_ms > from_ms)",
    ],
  },
  // Its own table so #6787's writer never touches a time_entries row.
  time_entry_sync: {
    columns: [
      ["entry_id", "TEXT PRIMARY KEY"],
      ["namespace", TEXT_NN],
      /** not-requested | waiting | synced | failed | change-pending */
      ["state", TEXT_NN],
      ["provider", TEXT],
      ["connection_id", TEXT],
      ["external_task_id", TEXT],
      ["external_entry_id", TEXT],
      ["task_link", TEXT],
      ["entry_link", TEXT],
      ["error_code", TEXT],
      /** A void's row: never sent itself (item 28). */
      ["never_sent", "INTEGER NOT NULL DEFAULT 0"],
      ["updated_at", INT_NN],
    ],
    keys: [],
  },
  // One row per session; three reading slots (item 12).
  time_entry_timer_marks: {
    columns: [
      ["namespace", TEXT_NN],
      ["session_id", TEXT_NN],
      ["origin_node_id", TEXT_NN],
      ["latest_ms", INT],
      ["latest_poll_at", INT],
      ["latest_tick_at", INT],
      ["latest_thinking", INT],
      ["latest_thinking_since", INT],
      ["pending_ms", INT],
      ["pending_poll_at", INT],
      ["pending_tick_at", INT],
      ["pending_thinking", INT],
      ["pending_thinking_since", INT],
      ["confirmed_ms", INT],
      ["confirmed_poll_at", INT],
      ["confirmed_tick_at", INT],
      ["confirmed_mode", TEXT],
      ["confirmed_epoch", INT],
      /** The highest confirmed raw timer of the current epoch (item 2). */
      ["high_raw_ms", INT],
      ["epoch", "INTEGER NOT NULL DEFAULT 0"],
      /** The first of two confirmed readings below high_raw_ms, held while the second is awaited (4.2, N-17). */
      ["fall_ms", INT],
      ["fall_poll_at", INT],
      /** The last confirmed reading in shadow, written when confirmed_mode leaves shadow (4.2, Q3). */
      ["last_shadow_ms", INT],
      ["last_shadow_at", INT],
      /** The session's baseline reading (closed scale). */
      ["baseline_ms", INT],
      /** first (with its node's baseline) | late (adopted later, 5.1). */
      ["baseline_kind", TEXT],
      ["baseline_at", INT],
      /** Whether the session was tracked at its baseline (EA2, N4). */
      ["baseline_tracked", INT],
      /** Set by the settlement import (5.8, Q2). */
      ["baseline_settled", "INTEGER NOT NULL DEFAULT 0"],
      /** The settling receipt, kept with minutes or without (9.2). */
      ["baseline_receipt_id", TEXT],
      ["baseline_receipt_hash", TEXT],
      ["removed_ms", INT],
      ["removed_at", INT],
      ["removed_mode", TEXT],
      /** delete | refresh | registry-exit */
      ["removed_via", TEXT],
    ],
    keys: ["PRIMARY KEY (namespace, session_id)"],
  },
  // The lowered cut of each history row; only ever lowered (items 1, 2).
  time_entry_cuts: {
    columns: [
      ["namespace", TEXT_NN],
      ["session_id", TEXT_NN],
      ["event_id", INT_NN],
      ["epoch", INT_NN],
      ["cut_ms", INT_NN],
      ["lowered_at", INT_NN],
      /** sample | boot */
      ["source", TEXT_NN],
    ],
    keys: ["PRIMARY KEY (namespace, session_id, event_id, epoch)"],
  },
  // One row per session and counter epoch above 0, kept for the session's life in the
  // record: an epoch is bounded at the next epoch's start (4.2, 5.6; revision 3c).
  time_entry_epochs: {
    columns: [
      ["namespace", TEXT_NN],
      ["session_id", TEXT_NN],
      ["epoch", INT_NN],
      /** R: the fallen reading the epoch's counter starts at (raw timer). */
      ["start_ms", INT_NN],
      /** That reading's poll time: the epoch's start, for its bounds only. */
      ["start_at", INT_NN],
      /** The previous epoch's high-water. */
      ["prev_high_raw_ms", INT],
      /** timer-fall | history-resync */
      ["source", TEXT_NN],
      ["opened_at", INT_NN],
    ],
    keys: ["PRIMARY KEY (namespace, session_id, epoch)"],
  },
  // Per origin: what the engine itself saw of the two copies (item 15).
  time_entry_copy_state: {
    columns: [
      ["namespace", TEXT_NN],
      ["origin_node_id", TEXT_NN],
      /** The last sync the engine saw drained (cursor ≥ max). */
      ["history_drained_at", INT],
      ["intervals_drained_at", INT],
      ["origin_mode", TEXT],
      ["origin_incarnation", TEXT],
      ["turn_mirror_off", "INTEGER NOT NULL DEFAULT 0"],
      /** A restore of this origin seen and not yet acknowledged (5.6 step 1); survives a restart. */
      ["restore_pending_at", INT],
      ["updated_at", INT_NN],
    ],
    keys: ["PRIMARY KEY (namespace, origin_node_id)"],
  },
  time_entry_runs: {
    columns: [
      ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
      ["namespace", TEXT_NN],
      ["night", TEXT_NN],
      ["cut_ms", INT_NN],
      ["zone", TEXT_NN],
      /** running | done | blocked (a blocked row is never counted as a cut). */
      ["state", TEXT_NN],
      ["started_at", INT],
      ["finished_at", INT],
      ["sessions", INT],
      ["entries", INT],
      ["minutes", INT],
      /** Per origin, failures by session id, vanished sessions, skipped cuts, epochs opened, steps. */
      ["detail_json", TEXT],
    ],
    keys: ["UNIQUE (namespace, cut_ms)"],
  },
  // One per namespace and origin node (item 6, OC-13).
  time_entry_baselines: {
    columns: [
      ["namespace", TEXT_NN],
      ["origin_node_id", TEXT_NN],
      /** first | handover | released */
      ["kind", TEXT_NN],
      ["at", INT_NN],
      ["log_from", INT_NN],
      ["owner_node_id", TEXT_NN],
      ["detail_json", TEXT],
    ],
    keys: ["PRIMARY KEY (namespace, origin_node_id, kind)"],
  },
  // What the clock's Set, Reset and Disable, or an agent on a person's word,
  // remove (Q1 = RM2; D-7; 7.6), and the engine's and an operator's steps.
  time_entry_exclusions: {
    columns: [
      /** tx:<namespace>:<session>:<n> */
      ["id", "TEXT PRIMARY KEY"],
      ["namespace", TEXT_NN],
      ["session_id", TEXT_NN],
      ["origin_node_id", TEXT_NN],
      /** clock-set | clock-reset | clock-disable | agent | switch-step | restore */
      ["control", TEXT_NN],
      /** The timelog_adjustments row a clock control wrote (Undo, Enable; N3). */
      ["adjustment_id", TEXT],
      /** A Disable's range; null otherwise. */
      ["range_from", INT],
      ["range_to", INT],
      ["up_to_ms", INT_NN],
      ["measured_ms", INT_NN],
      ["epoch", INT_NN],
      ["actor_kind", TEXT_NN],
      ["actor_session_id", TEXT],
      ["actor_user_agent", TEXT],
      ["via", TEXT_NN],
      /** An agent's exclusion: the person's words, quoted. */
      ["words", TEXT],
      ["at", INT_NN],
      /** N3 = RE1: the release. */
      ["released_at", INT],
      ["released_by_kind", TEXT],
      ["released_via", TEXT],
      ["released_adjustment_id", TEXT],
    ],
    keys: [],
  },
};

/** Every column of every table, in table order (what the check compares). */
export const TIME_ENTRY_TABLE_COLUMNS: Readonly<
  Record<TimeEntryTable, readonly string[]>
> = Object.freeze(
  Object.fromEntries(
    TIME_ENTRY_TABLES.map(t => [
      t,
      Object.freeze(TABLE_DEFS[t].columns.map(([name]) => name)),
    ])
  ) as Record<TimeEntryTable, readonly string[]>
);

function tableDdl(table: TimeEntryTable): string {
  const def = TABLE_DEFS[table];
  const lines = [
    ...def.columns.map(([name, type]) => `${name} ${type}`),
    ...def.keys,
  ];
  return `CREATE TABLE IF NOT EXISTS ${table} (\n  ${lines.join(",\n  ")}\n)`;
}

/** The table DDL, one statement per table. */
export const TIME_ENTRY_TABLE_DDL: Readonly<Record<TimeEntryTable, string>> =
  Object.freeze(
    Object.fromEntries(TIME_ENTRY_TABLES.map(t => [t, tableDdl(t)])) as Record<
      TimeEntryTable,
      string
    >
  );

/** The indexes; a missing index is slow, not wrong, so the check skips them. */
export const TIME_ENTRY_INDEXES: Readonly<Record<string, string>> =
  Object.freeze({
    idx_time_entries_ordinal: `CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entries_ordinal
       ON time_entries(namespace, session_id, ordinal) WHERE ordinal IS NOT NULL`,
    idx_time_entries_session: `CREATE INDEX IF NOT EXISTS idx_time_entries_session
       ON time_entries(namespace, session_id)`,
    idx_time_entries_work_date: `CREATE INDEX IF NOT EXISTS idx_time_entries_work_date
       ON time_entries(namespace, work_date)`,
    idx_time_entries_billable_since: `CREATE INDEX IF NOT EXISTS idx_time_entries_billable_since
       ON time_entries(namespace, billable_since)`,
    idx_time_entries_project: `CREATE INDEX IF NOT EXISTS idx_time_entries_project
       ON time_entries(namespace, current_project_key, work_date)`,
    idx_time_entries_status: `CREATE INDEX IF NOT EXISTS idx_time_entries_status
       ON time_entries(namespace, status, work_date)`,
    idx_time_entry_events_entry: `CREATE INDEX IF NOT EXISTS idx_time_entry_events_entry
       ON time_entry_events(entry_id, id)`,
    idx_time_entry_coverage_owner: `CREATE INDEX IF NOT EXISTS idx_time_entry_coverage_owner
       ON time_entry_coverage(owner_id)`,
    idx_time_entry_exclusions_session: `CREATE INDEX IF NOT EXISTS idx_time_entry_exclusions_session
       ON time_entry_exclusions(namespace, session_id)`,
    idx_time_entry_exclusions_adjustment: `CREATE INDEX IF NOT EXISTS idx_time_entry_exclusions_adjustment
       ON time_entry_exclusions(adjustment_id)`,
  });

/** Each CREATE in its own log-and-continue try (#6646's pattern). */
export function migrateTimeEntryTables(db: Database): void {
  for (const table of TIME_ENTRY_TABLES) {
    try {
      db.exec(TIME_ENTRY_TABLE_DDL[table]);
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE ${table} (#6204):`,
        error
      );
    }
  }
  for (const [name, ddl] of Object.entries(TIME_ENTRY_INDEXES)) {
    try {
      db.exec(ddl);
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE INDEX ${name} (#6204):`,
        error
      );
    }
  }
}

/**
 * True only when every table holds every column of section 3.2 (#6778's
 * check, widened to every table): a table left in an older shape by
 * `IF NOT EXISTS` makes the record not ready.
 */
export function hasTimeEntryStorage(db: Database): boolean {
  try {
    for (const table of TIME_ENTRY_TABLES) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      const names = new Set(columns.map(c => c.name));
      if (!TIME_ENTRY_TABLE_COLUMNS[table].every(c => names.has(c))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
