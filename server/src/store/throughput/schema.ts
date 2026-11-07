// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Throughput telemetry tables (issue #6164, epic #6163 Sub-Issue A1).
 *
 * Called from `Store.runMigrations()` right after `applyTurnsMigrations` (the
 * `turn_mirror` table must exist for its two new indexes). The house pattern of
 * `turns/schema.ts`: DDL in consts, one fail-open `try/catch` per block, no
 * CHECK constraints, `SCHEMA_VERSION` untouched, and none of these tables in
 * `createSchema()` / `REQUIRED_TABLES`.
 *
 * Every table here is NODE-LOCAL and never replicated: the facts themselves
 * ride `turns.throughput_json` through the #4614 mirror; everything below is
 * either progress bookkeeping or data derived from the ledger (rollups), from
 * GitHub (issue / PR / CI facts) or from usage samples. Not all of it can be
 * rebuilt: GitHub expires CI logs, quota days reach back only as far as the
 * usage-snapshot retention, and a digest is a stored report.
 */

const PROGRESS_DDL = `
  CREATE TABLE IF NOT EXISTS throughput_turn_progress (
    turn_id        TEXT PRIMARY KEY,
    started_at_ms  INTEGER,
    fp             TEXT,
    outcome        TEXT NOT NULL,
    attempts       INTEGER NOT NULL DEFAULT 0,
    last_ms        INTEGER NOT NULL,
    file_size      INTEGER,
    file_mtime_ms  INTEGER,
    bg_fp          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tp_progress_started
    ON throughput_turn_progress(started_at_ms);
  CREATE INDEX IF NOT EXISTS idx_tp_progress_outcome
    ON throughput_turn_progress(outcome, started_at_ms);

  -- Background agents launched by a collected turn: lets a later completion
  -- refold only that turn's bg section from the agent's own file.
  CREATE TABLE IF NOT EXISTS throughput_bg_launches (
    tool_use_id      TEXT PRIMARY KEY,
    turn_id          TEXT NOT NULL,
    hapi_session_id  TEXT NOT NULL,
    agent_id         TEXT,
    launched_at_ms   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tp_bg_launch_turn
    ON throughput_bg_launches(turn_id);

  CREATE TABLE IF NOT EXISTS throughput_state (
    key            TEXT PRIMARY KEY,
    value          TEXT NOT NULL,
    updated_at_ms  INTEGER NOT NULL
  );
`;

/** Token + USD columns shared by the cost-shaped rollups. */
const TOKEN_COLS = `
    tok_in   INTEGER NOT NULL,
    tok_out  INTEGER NOT NULL,
    tok_cr   INTEGER NOT NULL,
    tok_w1   INTEGER NOT NULL,
    tok_w5   INTEGER NOT NULL,
    tok_wu   INTEGER NOT NULL`;

const ROLLUP_DDL = `
  CREATE TABLE IF NOT EXISTS throughput_rollup_cost (
    ns       TEXT,
    origin   TEXT NOT NULL,
    day      TEXT NOT NULL,
    account  TEXT NOT NULL,
    model    TEXT NOT NULL,
    stage    TEXT NOT NULL,
    src      TEXT NOT NULL,
    turns    INTEGER NOT NULL,
    calls    INTEGER NOT NULL,${TOKEN_COLS},
    usd_in       REAL NOT NULL,
    usd_out      REAL NOT NULL,
    usd_cr       REAL NOT NULL,
    usd_w1       REAL NOT NULL,
    usd_w5       REAL NOT NULL,
    usd_wu       REAL NOT NULL,
    usd_total    REAL NOT NULL,
    usd_fallback REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tp_cost_day ON throughput_rollup_cost(day, origin);

  CREATE TABLE IF NOT EXISTS throughput_rollup_effort (
    ns       TEXT,
    origin   TEXT NOT NULL,
    day      TEXT NOT NULL,
    account  TEXT NOT NULL,
    model    TEXT NOT NULL,
    effort   TEXT NOT NULL,
    calls    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tp_effort_day ON throughput_rollup_effort(day, origin);

  CREATE TABLE IF NOT EXISTS throughput_rollup_ctx (
    ns       TEXT,
    origin   TEXT NOT NULL,
    day      TEXT NOT NULL,
    kind     TEXT NOT NULL,
    bin      INTEGER NOT NULL,
    n        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tp_ctx_day ON throughput_rollup_ctx(day, origin);

  CREATE TABLE IF NOT EXISTS throughput_rollup_idle (
    ns       TEXT,
    origin   TEXT NOT NULL,
    day      TEXT NOT NULL,
    cls      TEXT NOT NULL,
    n        INTEGER NOT NULL,
    w1       INTEGER NOT NULL,
    w5       INTEGER NOT NULL,
    usd      REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tp_idle_day ON throughput_rollup_idle(day, origin);

  CREATE TABLE IF NOT EXISTS throughput_rollup_session (
    ns         TEXT,
    origin     TEXT NOT NULL,
    day        TEXT NOT NULL,
    session_id TEXT NOT NULL,
    label      TEXT,
    account    TEXT NOT NULL,
    issue_key  TEXT,
    turns      INTEGER NOT NULL,
    calls      INTEGER NOT NULL,${TOKEN_COLS},
    usd_total  REAL NOT NULL,
    first_ms   INTEGER,
    last_ms    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tp_session_day ON throughput_rollup_session(day, origin);

  CREATE TABLE IF NOT EXISTS throughput_rollup_issue (
    ns         TEXT,
    origin     TEXT NOT NULL,
    day        TEXT NOT NULL,
    issue_key  TEXT NOT NULL,
    stage      TEXT NOT NULL,
    turns      INTEGER NOT NULL,
    calls      INTEGER NOT NULL,${TOKEN_COLS},
    usd_total  REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tp_issue_day ON throughput_rollup_issue(day, origin);
  CREATE INDEX IF NOT EXISTS idx_tp_issue_key ON throughput_rollup_issue(issue_key);

  CREATE TABLE IF NOT EXISTS throughput_rollup_tests (
    ns         TEXT,
    origin     TEXT NOT NULL,
    day        TEXT NOT NULL,
    unit       TEXT NOT NULL,
    fail_runs  INTEGER NOT NULL,
    sessions   INTEGER NOT NULL,
    first_ms   INTEGER,
    last_ms    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tp_tests_day ON throughput_rollup_tests(day, origin);

  CREATE TABLE IF NOT EXISTS throughput_rollup_cov (
    ns                 TEXT,
    origin             TEXT NOT NULL,
    day                TEXT NOT NULL,
    turns              INTEGER NOT NULL,
    with_facts         INTEGER NOT NULL,
    recovered          INTEGER NOT NULL,
    tok_null_no_facts  INTEGER NOT NULL,
    orphaned           INTEGER NOT NULL,
    calls              INTEGER NOT NULL,
    test_runs          INTEGER NOT NULL,
    test_fail          INTEGER NOT NULL,
    usd_total          REAL NOT NULL,
    usd_unattributed   REAL NOT NULL,
    usd_fallback       REAL NOT NULL,
    latest_ms          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tp_cov_day ON throughput_rollup_cov(day, origin);

  CREATE TABLE IF NOT EXISTS throughput_rollup_dirty (
    origin        TEXT NOT NULL,
    day           TEXT NOT NULL,
    marked_at_ms  INTEGER NOT NULL,
    PRIMARY KEY (origin, day)
  );
`;

const GITHUB_DDL = `
  CREATE TABLE IF NOT EXISTS throughput_issue_facts (
    repo               TEXT NOT NULL,
    number             INTEGER NOT NULL,
    title              TEXT NOT NULL,
    state              TEXT NOT NULL,
    state_reason       TEXT,
    created_at_ms      INTEGER,
    closed_at_ms       INTEGER,
    updated_at_ms      INTEGER,
    labels_json        TEXT NOT NULL,
    milestones_json    TEXT NOT NULL,
    lane               TEXT,
    lane_first         TEXT,
    lane_history_json  TEXT NOT NULL,
    complexity         TEXT,
    reopens            INTEGER NOT NULL,
    reopens_json       TEXT NOT NULL,
    closes_json        TEXT NOT NULL,
    follow_ups_json    TEXT NOT NULL,
    timeline_etag      TEXT,
    events             INTEGER NOT NULL,
    fetched_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (repo, number)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_issue_facts_closed
    ON throughput_issue_facts(closed_at_ms);

  CREATE TABLE IF NOT EXISTS throughput_prs (
    repo           TEXT NOT NULL,
    number         INTEGER NOT NULL,
    title          TEXT NOT NULL,
    head_ref       TEXT,
    merged_at_ms   INTEGER,
    code_lines     INTEGER,
    test_lines     INTEGER,
    doc_lines      INTEGER,
    code_files     INTEGER,
    -- The code files' paths (danger is judged at read time, so a change to the
    -- danger list needs no re-collection; issue-level file counts are distinct).
    code_paths_json TEXT,
    files_fetched  INTEGER NOT NULL DEFAULT 0,
    fetched_at_ms  INTEGER NOT NULL,
    PRIMARY KEY (repo, number)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_prs_merged ON throughput_prs(merged_at_ms);

  -- Which issues a merged PR delivers (head branch issue-N-… or a closing keyword).
  CREATE TABLE IF NOT EXISTS throughput_pr_issues (
    repo   TEXT NOT NULL,
    pr     INTEGER NOT NULL,
    issue  INTEGER NOT NULL,
    PRIMARY KEY (repo, pr, issue)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_pr_issues_issue
    ON throughput_pr_issues(repo, issue);

  CREATE TABLE IF NOT EXISTS throughput_ci_runs (
    repo             TEXT NOT NULL,
    run_id           INTEGER NOT NULL,
    workflow         TEXT,
    event            TEXT,
    head_branch      TEXT,
    head_sha         TEXT,
    status           TEXT,
    conclusion       TEXT,
    created_at_ms    INTEGER,
    updated_at_ms    INTEGER,
    pr_numbers_json  TEXT NOT NULL,
    logs_parsed      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, run_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_ci_runs_created
    ON throughput_ci_runs(repo, created_at_ms);

  CREATE TABLE IF NOT EXISTS throughput_ci_catches (
    repo           TEXT NOT NULL,
    run_id         INTEGER NOT NULL,
    job_id         INTEGER NOT NULL,
    unit           TEXT NOT NULL,
    created_at_ms  INTEGER,
    PRIMARY KEY (repo, run_id, job_id, unit)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_ci_catches_created
    ON throughput_ci_catches(created_at_ms);

  -- Each failed job's log is parsed ONCE (a job with no failing unit leaves no
  -- catch row, so the parse itself is recorded here).
  CREATE TABLE IF NOT EXISTS throughput_ci_jobs (
    repo           TEXT NOT NULL,
    job_id         INTEGER NOT NULL,
    run_id         INTEGER NOT NULL,
    units          INTEGER NOT NULL,
    truncated      INTEGER NOT NULL DEFAULT 0,
    log_missing    INTEGER NOT NULL DEFAULT 0,
    created_at_ms  INTEGER,
    parsed_at_ms   INTEGER NOT NULL,
    PRIMARY KEY (repo, job_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tp_ci_jobs_run ON throughput_ci_jobs(repo, run_id);
`;

const QUOTA_DIGEST_DDL = `
  CREATE TABLE IF NOT EXISTS throughput_quota_daily (
    account_id        TEXT NOT NULL,
    day               TEXT NOT NULL,
    first_util        REAL,
    last_util         REAL,
    first_ms          INTEGER,
    last_ms           INTEGER,
    samples           INTEGER NOT NULL,
    reset_crossed     INTEGER NOT NULL,
    tok_in            INTEGER NOT NULL,
    tok_out           INTEGER NOT NULL,
    tok_cr            INTEGER NOT NULL,
    tok_w1            INTEGER NOT NULL,
    tok_w5            INTEGER NOT NULL,
    tok_wu            INTEGER NOT NULL DEFAULT 0,
    unattributed_tok  INTEGER NOT NULL,
    updated_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (account_id, day)
  );

  CREATE TABLE IF NOT EXISTS throughput_digests (
    id                   TEXT PRIMARY KEY,
    created_at_ms        INTEGER NOT NULL,
    window_from_ms       INTEGER NOT NULL,
    window_to_ms         INTEGER NOT NULL,
    headline             TEXT NOT NULL,
    report_path          TEXT,
    notified             INTEGER NOT NULL,
    collector            TEXT NOT NULL,
    markdown             TEXT NOT NULL,
    summary_json         TEXT NOT NULL,
    rate_card_ids_json   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tp_digests_created
    ON throughput_digests(created_at_ms);
`;

/**
 * Two `turn_mirror` indexes for the rollup loop: the per-(origin, incarnation)
 * change cursor (dirty-bucket discovery) and per-origin day scans (bucket
 * recompute and the report CLI). `turn_mirror` keeps every incarnation's rows
 * forever (#4614 R11), so both scans must stay index-bounded.
 */
const MIRROR_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_turn_mirror_origin_seq
    ON turn_mirror(origin_node_id, origin_incarnation, origin_change_seq);
  CREATE INDEX IF NOT EXISTS idx_turn_mirror_origin_started
    ON turn_mirror(origin_node_id, started_at_ms);
`;

/** Every rollup table rebuilt per (origin, day) bucket. */
export const ROLLUP_TABLES = [
  "throughput_rollup_cost",
  "throughput_rollup_effort",
  "throughput_rollup_ctx",
  "throughput_rollup_idle",
  "throughput_rollup_session",
  "throughput_rollup_issue",
  "throughput_rollup_tests",
  "throughput_rollup_cov",
] as const;

const MIGRATION_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["progress/state", PROGRESS_DDL],
  ["rollups", ROLLUP_DDL],
  ["github", GITHUB_DDL],
  ["quota/digests", QUOTA_DIGEST_DDL],
  ["turn_mirror indexes", MIRROR_INDEX_DDL],
];

export function applyThroughputMigrations(db: Database): void {
  for (const [name, DDL] of MIGRATION_BLOCKS) {
    try {
      db.exec(DDL);
    } catch (error) {
      console.error(`[Store] Migration failed: throughput ${name}:`, error);
    }
  }
}

/** Read a `throughput_state` value (null when absent). */
export function readThroughputState(db: Database, key: string): string | null {
  const row = db
    .prepare("SELECT value FROM throughput_state WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Upsert a `throughput_state` value. */
export function writeThroughputState(
  db: Database,
  key: string,
  value: string,
  nowMs: number = Date.now()
): void {
  db.prepare(
    `INSERT INTO throughput_state (key, value, updated_at_ms)
     VALUES (@key, @value, @now)
     ON CONFLICT (key) DO UPDATE SET
       value = excluded.value,
       updated_at_ms = excluded.updated_at_ms`
  ).run({ key, value, now: nowMs });
}
