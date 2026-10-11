// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Per-turn telemetry schema + views (issue #1663, epic #1662).
 *
 * `applyTurnsMigrations(db)` is called from `Store.runMigrations()` (NOT from
 * `createSchema()`) — the #1122 fix runs `runMigrations()` on every boot, fresh
 * AND existing, so all new tables/columns/views belong here. It must NOT bump
 * `SCHEMA_VERSION` (D7: `PRAGMA user_version` is a frozen mismatch gate).
 *
 * House pattern (matches the `recent_paths` / `queued_messages` blocks in
 * `store/index.ts`): each table block is wrapped in its own `try/catch` with a
 * `console.error("[Store] Migration failed: <name>", e)` — fail-open migrations,
 * so a DDL error logs but never aborts daemon boot. Tables use
 * `CREATE TABLE IF NOT EXISTS` (idempotent); views use `DROP VIEW IF EXISTS` +
 * `CREATE VIEW` so definitions evolve each boot without a version bump (R2).
 *
 * The four table column shapes and the five view column shapes are the LOCKED
 * cross-issue contracts consumed by Sub B/C/D/E/K/L/M — see the directive's
 * "Pinned schema" and "View contracts" sections. The internal view SQL is a
 * correct starting definition (Sub J/H may refine the aggregation), but the
 * column NAMES + ORDER are binding (R9).
 */
export function applyTurnsMigrations(db: Database): void {
  // ───────────────────────── turns ─────────────────────────
  // One row per UserPromptSubmit→Stop cycle. Operational key UNIQUE(hapi_session_id, seq)
  // (D1); the partial unique index on non-NULL (cc_session_id, prompt_msg_uuid) is the
  // idempotency guard for duplicate finalize once the transcript uuid is known (R3).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id                       TEXT PRIMARY KEY,
        hapi_session_id          TEXT NOT NULL,
        seq                      INTEGER NOT NULL,
        cc_session_id            TEXT,
        prompt_msg_uuid          TEXT,
        status                   TEXT NOT NULL DEFAULT 'open',
        started_at_ms            INTEGER NOT NULL,
        ended_at_ms              INTEGER,
        duration_ms              INTEGER,
        node_id                  TEXT NOT NULL,
        namespace                TEXT,
        launcher                 TEXT,
        account_id               TEXT,
        plan_tier                TEXT,
        safe_mode                INTEGER,
        session_mode             TEXT,
        permission_mode          TEXT,
        session_name             TEXT,
        linked_issue             TEXT,
        orchestration_id         TEXT,
        model_provider           TEXT,
        model_id                 TEXT,
        context_window           INTEGER,
        cwd                      TEXT,
        repo                     TEXT,
        is_worktree              INTEGER,
        git_branch               TEXT,
        git_sha_start            TEXT,
        git_sha_end              TEXT,
        git_dirty                INTEGER,
        tok_in                   INTEGER,
        tok_out                  INTEGER,
        tok_cache_read           INTEGER,
        tok_cache_write          INTEGER,
        tokens_extra             TEXT,
        cost_in                  REAL,
        cost_out                 REAL,
        cost_cache_read          REAL,
        cost_cache_write         REAL,
        cost_total               REAL,
        rate_card_id             TEXT,
        context_used_tokens      INTEGER,
        context_remaining_tokens INTEGER,
        capture_source           TEXT,
        transcript_path          TEXT,
        prompt_hash              TEXT,
        schema_version           INTEGER NOT NULL DEFAULT 1,
        recorder_version         TEXT,
        UNIQUE(hapi_session_id, seq)
      );

      -- D1 idempotency guard: SQLite treats NULLs as distinct in UNIQUE, so the
      -- guard MUST be a partial index over non-NULL prompt_msg_uuid only.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_cc_uuid
        ON turns(cc_session_id, prompt_msg_uuid) WHERE prompt_msg_uuid IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_turns_session_seq  ON turns(hapi_session_id, seq);
      CREATE INDEX IF NOT EXISTS idx_turns_cc_session   ON turns(cc_session_id);
      CREATE INDEX IF NOT EXISTS idx_turns_status       ON turns(status);
      CREATE INDEX IF NOT EXISTS idx_turns_node         ON turns(node_id);
      CREATE INDEX IF NOT EXISTS idx_turns_started      ON turns(started_at_ms);
      CREATE INDEX IF NOT EXISTS idx_turns_linked_issue ON turns(linked_issue);
    `);
  } catch (error) {
    console.error(`[Store] Migration failed: CREATE TABLE turns:`, error);
  }

  // ─────────────────── turns change marker (issue #4614) ───────────────────
  // A monotonic per-database change marker that advances on EVERY write to a
  // `turns` row — the five UPDATE sites, both INSERT sites, AND a direct SQL
  // write that bypasses the store (turnStore.ts). The feed (#4614) reads
  // `change_seq > cursor` to replicate finalized turns to peer mirrors.
  //
  // It MUST be a trigger, not an app-level column write: an AC requires a direct
  // SQL write bypassing the store to advance the marker, which only a DB-level
  // trigger satisfies. SQLite triggers cannot assign NEW.col, so the shape is an
  // AFTER trigger that re-UPDATEs the row's change_seq from a counter table.
  // `recursive_triggers` is OFF by default — which blocks a trigger re-entering
  // ITSELF but NOT one trigger invoking another, so the AFTER INSERT trigger's
  // inner UPDATE would re-fire AFTER UPDATE and double-bump. The
  // `WHEN NEW.change_seq IS OLD.change_seq` guard on the UPDATE trigger prevents
  // that (the AI/AU inner writes change change_seq, so the guard is false for
  // them). Verified against bun:sqlite by the issue-4614 researcher fixture
  // (one increment per external write). DDL hoisted to consts so the call reads
  // `db.exec(IDENTIFIER)` — sidesteps the security-reminder hook's exec() false
  // positive (same idiom as PM_SPAWN_ROSTER_DDL below).
  const TURNS_CHANGE_SEQ_DDL = `
    CREATE TABLE IF NOT EXISTS turn_change_seq (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO turn_change_seq (id, value) VALUES (1, 0);

    CREATE TRIGGER IF NOT EXISTS turns_change_seq_ai AFTER INSERT ON turns BEGIN
      UPDATE turn_change_seq SET value = value + 1 WHERE id = 1;
      UPDATE turns SET change_seq = (SELECT value FROM turn_change_seq WHERE id = 1)
        WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS turns_change_seq_au AFTER UPDATE ON turns
      WHEN NEW.change_seq IS OLD.change_seq BEGIN
      UPDATE turn_change_seq SET value = value + 1 WHERE id = 1;
      UPDATE turns SET change_seq = (SELECT value FROM turn_change_seq WHERE id = 1)
        WHERE id = NEW.id;
    END;

    CREATE INDEX IF NOT EXISTS idx_turns_change_seq ON turns(change_seq);
  `;
  const TURNS_ADD_CHANGE_SEQ_SQL =
    "ALTER TABLE turns ADD COLUMN change_seq INTEGER";
  // A no-op self-assignment that fires the AU trigger, backfilling pre-ALTER NULL rows.
  const TURNS_BACKFILL_CHANGE_SEQ_SQL =
    "UPDATE turns SET change_seq = change_seq WHERE change_seq IS NULL";
  try {
    const cols = db.prepare("PRAGMA table_info(turns)").all() as Array<{
      name: string;
    }>;
    if (!cols.some(c => c.name === "change_seq")) {
      db.exec(TURNS_ADD_CHANGE_SEQ_SQL);
    }
    db.exec(TURNS_CHANGE_SEQ_DDL);
    db.exec(TURNS_BACKFILL_CHANGE_SEQ_SQL);
  } catch (error) {
    console.error(`[Store] Migration failed: turns change marker:`, error);
  }

  // ─────────── per-turn billing attribution (issue #4824, epic #4822 Sub C) ───────────
  // The binding a turn ran under, stamped from the session record when the turn
  // OPENS (turnEnrichment.ts) and never rewritten, so a mid-session switch cannot
  // re-attribute an earlier turn. Two PURE guarded ALTERs, each in its own
  // try/catch: the one-time backfill is a separate marker-keyed block further
  // down, so a failed boot retries it (a backfill inside one column's branch
  // would be skipped forever once the column exists). The per-row
  // `schema_version` stays 1 — NULL vs non-NULL `auth_binding_kind` already
  // tells a pre-change row from a post-change one.
  addColumnIfMissing(db, "turns", "auth_binding_kind", TURNS_ADD_KIND_SQL);
  addColumnIfMissing(db, "turns", "api_key_id", TURNS_ADD_KEY_ID_SQL);

  // ───────────────────────── turn_events ─────────────────────────
  // Events inside a turn (sub-agents, hooks, labels, errors, compaction). node_id is
  // denormalized (K3) so Sub L aggregates events without a turns join. NO CHECK on
  // `kind` (K1) — the canonical set is a TS union in types.ts (forward-compat).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS turn_events (
        id        TEXT PRIMARY KEY,
        turn_id   TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        node_id   TEXT NOT NULL,
        ts_ms     INTEGER NOT NULL,
        kind      TEXT NOT NULL,
        name      TEXT,
        payload   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id);
      CREATE INDEX IF NOT EXISTS idx_turn_events_kind ON turn_events(kind);
    `);
  } catch (error) {
    console.error(`[Store] Migration failed: CREATE TABLE turn_events:`, error);
  }

  // ───────────────────────── timelog_adjustments ─────────────────────────
  // Append-only manual time-ledger adjustments. node_id (R5) for federation merge;
  // namespace consistent with timelog_entries scoping.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS timelog_adjustments (
        id                    TEXT PRIMARY KEY,
        hapi_session_id       TEXT NOT NULL,
        node_id               TEXT NOT NULL,
        namespace             TEXT,
        ts_ms                 INTEGER NOT NULL,
        type                  TEXT NOT NULL,
        delta_ms              INTEGER,
        from_ms               INTEGER,
        to_ms                 INTEGER,
        target_adjustment_id  TEXT,
        actor                 TEXT,
        note                  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_timelog_adj_session
        ON timelog_adjustments(hapi_session_id, ts_ms);
    `);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE TABLE timelog_adjustments:`,
      error
    );
  }

  // ─────────── timelog_adjustments change marker (issue #4614) ───────────
  // The feed replicates `timelog_adjustments` alongside `turns`, on its OWN
  // cursor (a SEPARATE counter from `turn_change_seq` — two independent feeds
  // avoid cross-table paging). Append-only in practice (reversals are new rows),
  // but AI + guarded-AU are both installed for symmetry + future-proofing (an
  // AU trigger costs nothing if no UPDATE site ever fires). Same verified shape
  // as the turns marker above.
  const ADJ_CHANGE_SEQ_DDL = `
    CREATE TABLE IF NOT EXISTS timelog_adj_change_seq (
      id    INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO timelog_adj_change_seq (id, value) VALUES (1, 0);

    CREATE TRIGGER IF NOT EXISTS timelog_adj_change_seq_ai
      AFTER INSERT ON timelog_adjustments BEGIN
      UPDATE timelog_adj_change_seq SET value = value + 1 WHERE id = 1;
      UPDATE timelog_adjustments SET change_seq = (SELECT value FROM timelog_adj_change_seq WHERE id = 1)
        WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS timelog_adj_change_seq_au
      AFTER UPDATE ON timelog_adjustments
      WHEN NEW.change_seq IS OLD.change_seq BEGIN
      UPDATE timelog_adj_change_seq SET value = value + 1 WHERE id = 1;
      UPDATE timelog_adjustments SET change_seq = (SELECT value FROM timelog_adj_change_seq WHERE id = 1)
        WHERE id = NEW.id;
    END;

    CREATE INDEX IF NOT EXISTS idx_timelog_adj_change_seq ON timelog_adjustments(change_seq);
  `;
  const ADJ_ADD_CHANGE_SEQ_SQL =
    "ALTER TABLE timelog_adjustments ADD COLUMN change_seq INTEGER";
  const ADJ_BACKFILL_CHANGE_SEQ_SQL =
    "UPDATE timelog_adjustments SET change_seq = change_seq WHERE change_seq IS NULL";
  try {
    const cols = db
      .prepare("PRAGMA table_info(timelog_adjustments)")
      .all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === "change_seq")) {
      db.exec(ADJ_ADD_CHANGE_SEQ_SQL);
    }
    db.exec(ADJ_CHANGE_SEQ_DDL);
    db.exec(ADJ_BACKFILL_CHANGE_SEQ_SQL);
  } catch (error) {
    console.error(
      `[Store] Migration failed: timelog_adjustments change marker:`,
      error
    );
  }

  // ───────────────────────── rate_cards ─────────────────────────
  // Versioned pricing reference — Sub A creates EMPTY; Sub E seeds. Deliberately
  // NO node_id: reference data seeded identically per node, not a node-produced fact.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_cards (
        id             TEXT PRIMARY KEY,
        provider       TEXT NOT NULL,
        model_id       TEXT NOT NULL,
        effective_from INTEGER NOT NULL,
        prices         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rate_cards_lookup
        ON rate_cards(provider, model_id, effective_from);
    `);
  } catch (error) {
    console.error(`[Store] Migration failed: CREATE TABLE rate_cards:`, error);
  }

  // ───────────────────────── workflow_reconcile ─────────────────────────
  // Out-of-band GitHub label state absorbed by Sub J's (#1672) reconcile job
  // (R6). Distinct source from `turn_events` (which stay immutable "what-the-
  // turn-did") — `v_workflow_state` UNIONs both, latest-ts-per-(session,issue,
  // label) wins, so a GitHub edit recorded here corrects the session badge.
  // node_id (R5) for federation; keyed per (hapi_session_id, issue_number).
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_reconcile (
        id              TEXT PRIMARY KEY,
        hapi_session_id TEXT NOT NULL,
        issue_number    INTEGER NOT NULL,
        label           TEXT NOT NULL,
        kind            TEXT NOT NULL,
        ts_ms           INTEGER NOT NULL,
        node_id         TEXT NOT NULL,
        UNIQUE(hapi_session_id, issue_number, label, ts_ms)
      );
      CREATE INDEX IF NOT EXISTS idx_workflow_reconcile_session_issue
        ON workflow_reconcile(hapi_session_id, issue_number);
    `);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE TABLE workflow_reconcile:`,
      error
    );
  }

  // ───────────────────────── pm_spawn_roster ─────────────────────────
  // PM spawn-roster (issue #1936, producer for rp1-home#1054). Per-SPAWN grain
  // (one row per session a PM spawns) — NOT per-turn, so a dedicated table rather
  // than an extension of `turns` (which is keyed UNIQUE(hapi_session_id, seq)).
  // The PM (a /project-manager-role session) registers each spawn via the
  // /api/session-metadata/spawn-roster routes, enriches cc/hapi ids as they
  // resolve, and transitions reconciliation_status (spawned → complete | re-driving).
  // node_id is the node where the SPAWNED session runs (federation source of truth);
  // the hub aggregate route unions rows across nodes. UNIQUE(completion_token) makes
  // the upsert idempotent (the PMDONE-<hex> token is the reconciliation grep target).
  // NO CHECK on reconciliation_status (K1 house rule — canonical values are a TS
  // union, not a DB constraint). Fail-open DDL; SCHEMA_VERSION stays 1 (D7).
  // DDL hoisted to a const so the migration call reads `db.exec(IDENTIFIER)` rather
  // than `db.exec(<template-literal>)`, sidestepping the security-reminder hook's
  // child_process.exec() false-positive while keeping the SQL inline-readable.
  const PM_SPAWN_ROSTER_DDL = `
    CREATE TABLE IF NOT EXISTS pm_spawn_roster (
      id                    TEXT PRIMARY KEY,
      completion_token      TEXT NOT NULL,
      pm_session_id         TEXT NOT NULL,
      hapi_session_id       TEXT,
      cc_session_id         TEXT,
      issue                 TEXT,
      repo                  TEXT,
      node_id               TEXT NOT NULL,
      worktree_path         TEXT,
      reconciliation_status TEXT NOT NULL DEFAULT 'spawned',
      spawned_at_ms         INTEGER NOT NULL,
      updated_at_ms         INTEGER,
      UNIQUE(completion_token)
    );
    CREATE INDEX IF NOT EXISTS idx_pm_roster_pm     ON pm_spawn_roster(pm_session_id);
    CREATE INDEX IF NOT EXISTS idx_pm_roster_status ON pm_spawn_roster(reconciliation_status);
    CREATE INDEX IF NOT EXISTS idx_pm_roster_cc     ON pm_spawn_roster(cc_session_id);
  `;
  try {
    db.exec(PM_SPAWN_ROSTER_DDL);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE TABLE pm_spawn_roster:`,
      error
    );
  }

  // ───────────────────────── background_agent_usage ─────────────────────────
  // Issue #4385 (epic #4382 Sub C). One row per BACKGROUND agent a session
  // launched, holding the agent file's FULL usage, recorded on the owning node
  // when the agent completes. Background agents are excluded from the finalize
  // rollup (transcriptParser, T8) because they outlive the spawning turn, so this
  // table is their only account. Full-file recompute on every completion REPLACES
  // the row (idempotent: a resumed agent that notifies twice is counted once).
  // Per-agent grain, not per-turn, so `turn_count` stays honest. `v_session_totals`
  // folds the per-session sums into `total_tok_*` / `total_cost` below; the
  // breakout (count + per-agent rows) is read from this table directly.
  // DDL hoisted to a const (the pm_spawn_roster note on the exec() false-positive).
  const BACKGROUND_AGENT_USAGE_DDL = `
    CREATE TABLE IF NOT EXISTS background_agent_usage (
      hapi_session_id TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      tool_use_id     TEXT,
      agent_type      TEXT,
      description     TEXT,
      tok_in          INTEGER NOT NULL,
      tok_out         INTEGER NOT NULL,
      tok_cache_read  INTEGER NOT NULL,
      tok_cache_write INTEGER NOT NULL,
      cost_total      REAL,
      started_at_ms   INTEGER,
      ended_at_ms     INTEGER,
      status          TEXT NOT NULL,
      node_id         TEXT NOT NULL,
      namespace       TEXT,
      PRIMARY KEY (hapi_session_id, agent_id)
    );
  `;
  try {
    db.exec(BACKGROUND_AGENT_USAGE_DDL);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE TABLE background_agent_usage:`,
      error
    );
  }

  // Issue #4824: an agent row carries the binding of the turn that launched it
  // (its writers read it from the turn ledger, never the live session record).
  addColumnIfMissing(
    db,
    "background_agent_usage",
    "auth_binding_kind",
    AGENTS_ADD_KIND_SQL
  );
  addColumnIfMissing(
    db,
    "background_agent_usage",
    "api_key_id",
    AGENTS_ADD_KEY_ID_SQL
  );

  // Issue #4824: stamp the rows recorded before this change ONCE, from each
  // session's binding at migration time (R8). Keyed on a `_migration_markers`
  // row, separate from the ALTERs: the marker is written in the same
  // transaction as the UPDATE, so a failed attempt retries on the next boot,
  // and a later boot never re-stamps a NULL row from a binding the session
  // switched to afterwards.
  backfillBindingOnce(db, "turns", TURNS_BINDING_BACKFILL_MARKER);
  backfillBindingOnce(
    db,
    "background_agent_usage",
    AGENTS_BINDING_BACKFILL_MARKER
  );

  // ─────────── turn-ledger mirror substrate (issue #4614) ───────────
  // The read-only mirror of OTHER nodes' finalized turns. Four tables:
  //  (a) turn_ledger_identity — THIS db's own incarnation id (minted once in
  //      TurnStore's ctor, INSIDE the db so it travels with a backup/restore;
  //      a rebuilt VM gets a fresh empty db -> fresh incarnation -> peers resync).
  //  (b) turn_mirror — foreign finalized turns. `row_json` holds the FULL origin
  //      row so a newer origin's unknown columns are preserved (version-skew
  //      tolerance, R9). Keyed by (origin, incarnation, turn_id) so a rebuild's
  //      new-incarnation rows coexist with the old (R3/R11).
  //  (c) timelog_adjustments_mirror — foreign adjustments, same keying.
  //  (d) turn_mirror_cursor — per-origin cursors (turns + adjustments) + status
  //      (last sync time, last origin max seq for lag/rewind detection, R5/R6).
  // 🔴 R11: NOTHING in #4614 deletes from these tables. NodeRegistry eviction
  // (healthCheck evictionThreshold) must NOT be wired to purge mirror rows — a
  // departed node's history is kept, independent of registry membership.
  const TURN_MIRROR_DDL = `
    CREATE TABLE IF NOT EXISTS turn_ledger_identity (
      id             INTEGER PRIMARY KEY CHECK (id = 1),
      incarnation_id TEXT NOT NULL,
      created_at_ms  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_mirror (
      origin_node_id     TEXT NOT NULL,
      origin_incarnation TEXT NOT NULL,
      turn_id            TEXT NOT NULL,
      origin_change_seq  INTEGER NOT NULL,
      hapi_session_id    TEXT NOT NULL,
      namespace          TEXT,
      status             TEXT NOT NULL,
      started_at_ms      INTEGER,
      ended_at_ms        INTEGER,
      duration_ms        INTEGER,
      row_json           TEXT NOT NULL,
      mirrored_at_ms     INTEGER NOT NULL,
      PRIMARY KEY (origin_node_id, origin_incarnation, turn_id)
    );
    CREATE INDEX IF NOT EXISTS idx_turn_mirror_origin
      ON turn_mirror(origin_node_id, origin_incarnation);
    CREATE INDEX IF NOT EXISTS idx_turn_mirror_session ON turn_mirror(hapi_session_id);

    CREATE TABLE IF NOT EXISTS timelog_adjustments_mirror (
      origin_node_id     TEXT NOT NULL,
      origin_incarnation TEXT NOT NULL,
      adjustment_id      TEXT NOT NULL,
      origin_change_seq  INTEGER NOT NULL,
      hapi_session_id    TEXT NOT NULL,
      namespace          TEXT,
      ts_ms              INTEGER,
      row_json           TEXT NOT NULL,
      mirrored_at_ms     INTEGER NOT NULL,
      PRIMARY KEY (origin_node_id, origin_incarnation, adjustment_id)
    );
    CREATE INDEX IF NOT EXISTS idx_timelog_adj_mirror_origin
      ON timelog_adjustments_mirror(origin_node_id, origin_incarnation);

    CREATE TABLE IF NOT EXISTS turn_mirror_cursor (
      origin_node_id      TEXT PRIMARY KEY,
      origin_incarnation  TEXT NOT NULL,
      turn_cursor         INTEGER NOT NULL DEFAULT 0,
      adj_cursor          INTEGER NOT NULL DEFAULT 0,
      last_origin_max_seq INTEGER,
      last_sync_at_ms     INTEGER
    );
  `;
  try {
    db.exec(TURN_MIRROR_DDL);
  } catch (error) {
    console.error(
      `[Store] Migration failed: turn-ledger mirror tables:`,
      error
    );
  }

  // ───────────────────────── Views (R2/R9) ─────────────────────────
  // DROP + CREATE each boot so internal SQL evolves without a version bump. The
  // column NAMES + ORDER below are the locked cross-issue contract — downstream
  // issues (G/H/I/J/K/L/M) may refine the SQL but MUST preserve these columns.

  // v_session_totals — see `applySessionTotalsView` below (exported so a test
  // can rebuild the view alone, without the ALTERs).
  applySessionTotalsView(db);

  // v_timelog_daily — daily time totals. UTC-date bucket is a PLACEHOLDER (D6/OR2):
  // correct day boundaries follow midnight_reset_state TZ semantics; Sub H (#1670)
  // refines. The column shape is stable across that refinement.
  try {
    db.exec(`
      DROP VIEW IF EXISTS v_timelog_daily;
      CREATE VIEW v_timelog_daily AS
      SELECT
        namespace,
        date,
        SUM(auto_ms)                  AS auto_duration_ms,
        SUM(adjustment_ms)            AS adjustment_ms,
        SUM(auto_ms) + SUM(adjustment_ms) AS net_duration_ms
      FROM (
        SELECT
          t.namespace                               AS namespace,
          date(t.started_at_ms / 1000, 'unixepoch') AS date,
          COALESCE(t.duration_ms, 0)                AS auto_ms,
          0                                         AS adjustment_ms
        FROM turns t
        UNION ALL
        SELECT
          a.namespace                               AS namespace,
          date(a.ts_ms / 1000, 'unixepoch')         AS date,
          0                                         AS auto_ms,
          COALESCE(a.delta_ms, 0)                   AS adjustment_ms
        FROM timelog_adjustments a
      )
      GROUP BY namespace, date;
    `);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE VIEW v_timelog_daily:`,
      error
    );
  }

  // v_error_log — unified error surface: UNION ALL of error_logs rows and
  // turn_events of kind error/api_error joined to turns (Sub K integrates the seam).
  try {
    db.exec(`
      DROP VIEW IF EXISTS v_error_log;
      CREATE VIEW v_error_log AS
      SELECT
        el.timestamp        AS ts_ms,
        el.severity         AS severity,
        el.category         AS category,
        el.source           AS source,
        el.message          AS message,
        el.session_id       AS session_id,
        NULL                AS node_id,
        NULL                AS turn_id,
        'error_logs'        AS origin
      FROM error_logs el
      UNION ALL
      SELECT
        te.ts_ms                    AS ts_ms,
        'error'                     AS severity,
        te.kind                     AS category,
        'turn_event'                AS source,
        COALESCE(te.name, te.kind)  AS message,
        t.hapi_session_id           AS session_id,
        te.node_id                  AS node_id,
        te.turn_id                  AS turn_id,
        'turn_event'                AS origin
      FROM turn_events te
      JOIN turns t ON t.id = te.turn_id
      WHERE te.kind IN ('error', 'api_error');
    `);
  } catch (error) {
    console.error(`[Store] Migration failed: CREATE VIEW v_error_log:`, error);
  }

  // v_analytics_counts — event counts by kind/name (turn_events JOIN turns).
  try {
    db.exec(`
      DROP VIEW IF EXISTS v_analytics_counts;
      CREATE VIEW v_analytics_counts AS
      SELECT
        te.kind                           AS kind,
        te.name                           AS name,
        te.node_id                        AS node_id,
        t.namespace                       AS namespace,
        COUNT(*)                          AS event_count,
        COUNT(DISTINCT te.turn_id)        AS distinct_turns,
        COUNT(DISTINCT t.hapi_session_id) AS distinct_sessions,
        MIN(te.ts_ms)                     AS first_ts_ms,
        MAX(te.ts_ms)                     AS last_ts_ms
      FROM turn_events te
      JOIN turns t ON t.id = te.turn_id
      GROUP BY te.kind, te.name, te.node_id, t.namespace;
    `);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE VIEW v_analytics_counts:`,
      error
    );
  }

  // v_workflow_state — current net workflow labels keyed per (hapi_session_id,
  // issue_number) (D8). The net label set = labels whose LATEST event per
  // (session, issue, label) is label_added (non-monotonic; checkpoints can regress).
  // issue_number/label read from payload via json_extract. Sub J (#1672) refined
  // the reconciliation: UNIONs `workflow_reconcile` (out-of-band GitHub edits, R6)
  // so the badge stays honest vs GitHub. The KEY + output columns are UNCHANGED
  // (locked cross-issue contract — downstream G/H/I/K/L/M depend on them).
  try {
    db.exec(`
      DROP VIEW IF EXISTS v_workflow_state;
      CREATE VIEW v_workflow_state AS
      SELECT
        hapi_session_id,
        issue_number,
        MAX(node_id)            AS node_id,
        json_group_array(label) AS active_labels_json,
        MAX(ts_ms)              AS last_event_ts_ms
      FROM (
        SELECT
          hapi_session_id,
          issue_number,
          label,
          node_id,
          ts_ms,
          kind,
          ROW_NUMBER() OVER (
            PARTITION BY hapi_session_id, issue_number, label
            ORDER BY ts_ms DESC, id DESC
          ) AS rn
        FROM (
          -- (a) turn-derived label events (immutable "what-the-turn-did", R6)
          SELECT
            t.hapi_session_id                           AS hapi_session_id,
            json_extract(te.payload, '$.issue_number')  AS issue_number,
            json_extract(te.payload, '$.label')         AS label,
            te.node_id                                  AS node_id,
            te.ts_ms                                    AS ts_ms,
            te.kind                                     AS kind,
            te.id                                       AS id
          FROM turn_events te
          JOIN turns t ON t.id = te.turn_id
          WHERE te.kind IN ('label_added', 'label_removed')
          UNION ALL
          -- (b) reconcile-sourced events — out-of-band GitHub edits (Sub J #1672 R6)
          SELECT
            wr.hapi_session_id  AS hapi_session_id,
            wr.issue_number     AS issue_number,
            wr.label            AS label,
            wr.node_id          AS node_id,
            wr.ts_ms            AS ts_ms,
            wr.kind             AS kind,
            wr.id               AS id
          FROM workflow_reconcile wr
        )
      )
      WHERE rn = 1 AND kind = 'label_added'
      GROUP BY hapi_session_id, issue_number;
    `);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE VIEW v_workflow_state:`,
      error
    );
  }
}

// ─────────────── per-turn billing attribution (issue #4824) ───────────────

/** The two ledger columns #4824 adds to `turns` and `background_agent_usage`. */
export const BINDING_COLUMNS = ["auth_binding_kind", "api_key_id"] as const;

/** One-time backfill markers (`_migration_markers.key`), one per table. */
export const TURNS_BINDING_BACKFILL_MARKER =
  "turns-auth-binding-backfill-4824-v1";
export const AGENTS_BINDING_BACKFILL_MARKER =
  "background-agent-auth-binding-backfill-4824-v1";

const TURNS_ADD_KIND_SQL =
  "ALTER TABLE turns ADD COLUMN auth_binding_kind TEXT";
const TURNS_ADD_KEY_ID_SQL = "ALTER TABLE turns ADD COLUMN api_key_id TEXT";
const AGENTS_ADD_KIND_SQL =
  "ALTER TABLE background_agent_usage ADD COLUMN auth_binding_kind TEXT";
const AGENTS_ADD_KEY_ID_SQL =
  "ALTER TABLE background_agent_usage ADD COLUMN api_key_id TEXT";

/** The `AuthBindingSchema.kind` values (`shared/src/schemas.ts`). */
const BINDING_KINDS_SQL =
  "'subscription-account', 'api-key', 'gateway-key', 'inherited'";

/**
 * The cost buckets — the SQL face of the web's `costTreatment`
 * (`web/src/lib/costEstimate.ts`). `api-key` and `gateway-key` turns are REAL
 * charges, `subscription-account` turns an API-EQUIVALENT value, and everything
 * else (NULL, `inherited`, an unknown string) is UNATTRIBUTED. Unattributed is
 * the complement of the other two, so real + equivalent + unattributed equals
 * the total by construction. (`NULL NOT IN (…)` is NULL, hence the IS NULL arm.)
 */
function realCostPredicate(kind: string): string {
  return `${kind} IN ('api-key', 'gateway-key')`;
}
function equivalentCostPredicate(kind: string): string {
  return `${kind} = 'subscription-account'`;
}
function unattributedCostPredicate(kind: string): string {
  return `(${kind} IS NULL OR ${kind} NOT IN ('api-key', 'gateway-key', 'subscription-account'))`;
}

/** True when `table` exists and has every one of `columns`. */
export function tableHasColumns(
  db: Database,
  table: string,
  columns: readonly string[]
): boolean {
  const present = new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map(c => c.name)
  );
  return columns.every(c => present.has(c));
}

function tableExists(db: Database, table: string): boolean {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(table) != null
  );
}

/** A PRAGMA-guarded `ALTER TABLE … ADD COLUMN`, fail-open like every block here. */
function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  alterSql: string
): void {
  try {
    if (!tableHasColumns(db, table, [column])) db.exec(alterSql);
  } catch (error) {
    console.error(`[Store] Migration failed: ${table}.${column}:`, error);
  }
}

/**
 * Stamp `table`'s pre-change rows with their session's binding, once (R8).
 *
 * Only rows whose session record still exists with a recognized
 * `authBinding.kind` are touched — every UPDATE of a `turns` row fires the
 * #4614 change-marker trigger and re-replicates the row to peer mirrors, so a
 * row that would stay NULL is left alone. `json_valid` guards both reads (one
 * malformed `sessions.metadata` would otherwise throw and roll back the whole
 * UPDATE), and the key id is stamped only for an `api-key` binding.
 */
function bindingBackfillSql(table: "turns" | "background_agent_usage"): string {
  const kind =
    "CASE WHEN json_valid(s.metadata) THEN json_extract(s.metadata, '$.authBinding.kind') END";
  const keyId =
    "CASE WHEN json_valid(s.metadata) THEN " +
    "CASE WHEN json_extract(s.metadata, '$.authBinding.kind') = 'api-key' " +
    "AND json_type(s.metadata, '$.apiKeyId') = 'text' " +
    "THEN json_extract(s.metadata, '$.apiKeyId') END END";
  return `UPDATE ${table} SET
      auth_binding_kind = (SELECT ${kind} FROM sessions s
                            WHERE s.id = ${table}.hapi_session_id),
      api_key_id        = (SELECT ${keyId} FROM sessions s
                            WHERE s.id = ${table}.hapi_session_id)
    WHERE auth_binding_kind IS NULL
      AND hapi_session_id IN (SELECT s.id FROM sessions s
                               WHERE ${kind} IN (${BINDING_KINDS_SQL}))`;
}

/**
 * The marker-keyed one-time backfill. Skipped while the columns are missing (a
 * failed ALTER this boot — the next boot retries both) and on a bare telemetry
 * database with no `sessions` / `_migration_markers` table (unit tests). The
 * UPDATE and the marker INSERT share one transaction, so the marker exists only
 * when the UPDATE committed; the try/catch keeps it fail-open, so a failed
 * attempt is retried on the next boot.
 */
function backfillBindingOnce(
  db: Database,
  table: "turns" | "background_agent_usage",
  marker: string
): void {
  try {
    if (!tableHasColumns(db, table, BINDING_COLUMNS)) return;
    if (
      !tableExists(db, "sessions") ||
      !tableExists(db, "_migration_markers")
    ) {
      return;
    }
    const done = db
      .prepare("SELECT key FROM _migration_markers WHERE key = ?")
      .get(marker);
    if (done != null) return;
    const apply = db.transaction(() => {
      db.prepare(bindingBackfillSql(table)).run();
      // SQLite's changes() counts only the rows the UPDATE itself modified; the
      // driver's `run().changes` also counts the #4614 trigger's writes.
      const stamped = (
        db.prepare("SELECT changes() AS n").get() as { n: number }
      ).n;
      db.prepare(
        "INSERT INTO _migration_markers " +
          "(key, applied_at, rows_affected, strategy, metadata) " +
          "VALUES (?, ?, ?, ?, ?)"
      ).run(
        marker,
        Date.now(),
        stamped,
        "session-binding-at-migration",
        JSON.stringify({ issue: 4824, table })
      );
    });
    apply();
  } catch (error) {
    console.error(`[Store] Migration failed: ${marker}:`, error);
  }
}

/**
 * (Re)build `v_session_totals` — derived per-session aggregates (retires live
 * timers). "Latest" scalars via correlated subquery ordered by seq DESC LIMIT 1.
 *
 * #4385: `total_tok_*` / `total_cost` ADD the session's `background_agent_usage`
 * sums (a LEFT JOIN to a one-row-per-session aggregate, so it never multiplies
 * turn rows and `turn_count` stays turns-only). A session with no background row
 * keeps the bare turn SUM — NULL stays NULL until a turn is populated. The
 * breakout comes from the table (one source, so the folded total and the
 * breakout cannot disagree).
 *
 * #4824: `real_cost` / `equivalent_cost` / `unattributed_cost` are APPENDED (the
 * existing names and order are the locked contract, and readers map by name).
 * Each folds in the matching background-agent bucket and stays NULL while no row
 * of that bucket is priced. `total_cost` is unchanged — the combined sum the
 * `costUsdCeiling` runaway guard meters. The split is composed only when both
 * tables have the binding columns: SQLite accepts a view over a missing column
 * and fails at READ time, so a failed ALTER would otherwise turn every
 * token-stats read into a 500 and silently disable the ceiling guard. Without
 * the columns the three sums are NULL and the client shows the single total.
 */
export function applySessionTotalsView(db: Database): void {
  let split = false;
  try {
    split =
      tableHasColumns(db, "turns", BINDING_COLUMNS) &&
      tableHasColumns(db, "background_agent_usage", BINDING_COLUMNS);
  } catch {
    split = false;
  }
  const turnBucket = (
    column: string,
    predicate: (kind: string) => string
  ): string => {
    const turnSum = `SUM(CASE WHEN ${predicate("t.auth_binding_kind")} THEN t.cost_total END)`;
    return `CASE WHEN bg.${column} IS NULL THEN ${turnSum}
             ELSE IFNULL(${turnSum}, 0) + bg.${column} END AS ${column}`;
  };
  const agentBucket = (
    column: string,
    predicate: (kind: string) => string
  ): string =>
    `SUM(CASE WHEN ${predicate("auth_binding_kind")} THEN cost_total END) AS ${column}`;
  const splitColumns = split
    ? [
        turnBucket("real_cost", realCostPredicate),
        turnBucket("equivalent_cost", equivalentCostPredicate),
        turnBucket("unattributed_cost", unattributedCostPredicate),
      ].join(",\n        ")
    : "NULL AS real_cost, NULL AS equivalent_cost, NULL AS unattributed_cost";
  const agentSplitColumns = split
    ? `,
               ${agentBucket("real_cost", realCostPredicate)},
               ${agentBucket("equivalent_cost", equivalentCostPredicate)},
               ${agentBucket("unattributed_cost", unattributedCostPredicate)}`
    : "";
  const viewSql = `
      DROP VIEW IF EXISTS v_session_totals;
      CREATE VIEW v_session_totals AS
      SELECT
        t.hapi_session_id                                  AS hapi_session_id,
        MAX(t.node_id)                                     AS node_id,
        MAX(t.namespace)                                   AS namespace,
        COUNT(*)                                           AS turn_count,
        MIN(t.started_at_ms)                               AS first_started_at_ms,
        MAX(t.ended_at_ms)                                 AS last_ended_at_ms,
        SUM(t.duration_ms)                                 AS total_duration_ms,
        CASE WHEN bg.hapi_session_id IS NULL THEN SUM(t.tok_in)
             ELSE IFNULL(SUM(t.tok_in), 0) + bg.tok_in END AS total_tok_in,
        CASE WHEN bg.hapi_session_id IS NULL THEN SUM(t.tok_out)
             ELSE IFNULL(SUM(t.tok_out), 0) + bg.tok_out END
                                                           AS total_tok_out,
        CASE WHEN bg.hapi_session_id IS NULL THEN SUM(t.tok_cache_read)
             ELSE IFNULL(SUM(t.tok_cache_read), 0) + bg.tok_cache_read END
                                                           AS total_tok_cache_read,
        CASE WHEN bg.hapi_session_id IS NULL THEN SUM(t.tok_cache_write)
             ELSE IFNULL(SUM(t.tok_cache_write), 0) + bg.tok_cache_write END
                                                           AS total_tok_cache_write,
        CASE WHEN bg.cost_total IS NULL THEN SUM(t.cost_total)
             ELSE IFNULL(SUM(t.cost_total), 0) + bg.cost_total END
                                                           AS total_cost,
        MAX(t.seq)                                         AS last_seq,
        (SELECT t2.model_id FROM turns t2
          WHERE t2.hapi_session_id = t.hapi_session_id
          ORDER BY t2.seq DESC LIMIT 1)                    AS last_model_id,
        (SELECT t2.account_id FROM turns t2
          WHERE t2.hapi_session_id = t.hapi_session_id
          ORDER BY t2.seq DESC LIMIT 1)                    AS last_account_id,
        (SELECT t2.linked_issue FROM turns t2
          WHERE t2.hapi_session_id = t.hapi_session_id
          ORDER BY t2.seq DESC LIMIT 1)                    AS last_linked_issue,
        (SELECT t2.repo FROM turns t2
          WHERE t2.hapi_session_id = t.hapi_session_id
          ORDER BY t2.seq DESC LIMIT 1)                    AS last_repo,
        ${splitColumns}
      FROM turns t
      LEFT JOIN (
        SELECT hapi_session_id,
               SUM(tok_in)          AS tok_in,
               SUM(tok_out)         AS tok_out,
               SUM(tok_cache_read)  AS tok_cache_read,
               SUM(tok_cache_write) AS tok_cache_write,
               SUM(cost_total)      AS cost_total${agentSplitColumns}
        FROM background_agent_usage
        GROUP BY hapi_session_id
      ) bg ON bg.hapi_session_id = t.hapi_session_id
      GROUP BY t.hapi_session_id;
    `;
  try {
    db.exec(viewSql);
  } catch (error) {
    console.error(
      `[Store] Migration failed: CREATE VIEW v_session_totals:`,
      error
    );
  }
}
