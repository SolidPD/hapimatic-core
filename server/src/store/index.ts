// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- Grandfathered god-file (Epic 0, #2077); decomposition verdict tracked in claudedocs/architecture-hotspot-review.md. */
import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import { MachineStore } from "./machineStore";
import { MessageStore } from "./messageStore";
import { PushStore } from "./pushStore";
import { QueuedMessageStore } from "./queuedMessageStore";
import { RecentPathStore } from "./recentPathStore";
import { HarnessStore } from "./harnessStore";
import { ImpactAnalysisStore } from "./impactAnalysisStore";
import { AuditStore } from "./auditStore";
import { UpdateStatusStore } from "./updateStatusStore";
import { SessionStore } from "./sessionStore";
import { ErrorLogStore } from "./errorLogStore";
import { FeedbackStore } from "./feedbackStore";
import { TimeLogStore } from "./timeLogStore";
import { PeerStore } from "./peerStore";
import { LeaseStore } from "./leaseStore";
import { FileClaimsStore } from "./fileClaimsStore";
import { InitiativeStore } from "./initiativeStore";
import { WatermarkStore } from "./watermarkStore";
import { PredictionAccuracyStore } from "./predictionAccuracyStore";
import { UserStore } from "./userStore";
import { MidnightResetStateStore } from "./midnightResetStateStore";
import { UsageHistoryStore } from "./usageHistoryStore";
import { UsageAlertStore } from "./usageAlertStore";
import { applyTurnsMigrations } from "./turns/schema";
import { seedRateCards } from "./turns/rateCards";
import { TurnStore } from "./turns/turnStore";
import { TurnMirrorStore } from "./turns/turnMirrorStore";
import { PmRosterStore } from "./turns/pmRosterStore";
import { BackgroundAgentUsageStore } from "./turns/backgroundAgentUsage";
import { TurnAnalyticsCounts } from "./turns/analyticsCounts";
import { TimelogAdjustmentsStore } from "./turns/timelogAdjustmentsStore";
import { runLegacyManualRowMigration } from "./turns/legacyManualRowMigration";
import {
  deriveDailyTimeLog,
  deriveDailyBreakdown,
  type DeriveTimelogOptions,
  type DerivedDailyBucket,
  type SessionBreakdownItem,
} from "./turns/timelogDerivation";
import { applyParityMigrations, ParityRunsStore } from "./parityRuns";
import { ExtensionPrefsStore } from "./extensionPrefsStore";
import { BookmarkStore } from "./bookmarkStore";
import { getConfiguration } from "../configuration";

export type {
  DailySummary,
  ErrorLogFilters,
  ErrorLogSeverity,
  ErrorLogSource,
  StoredErrorLog,
  StoredExtensionPref,
  StoredMachine,
  StoredMessage,
  StoredPushSubscription,
  StoredSession,
  StoredTimeLogEntry,
  StoredUser,
  TimeLogFilters,
  VersionedUpdateResult,
  WeeklySummary,
} from "./types";
export type {
  EnqueueResult as QueuedMessageEnqueueResult,
  StoredQueuedMessage,
} from "./queuedMessages";
export { ErrorLogStore } from "./errorLogStore";
export { FeedbackStore } from "./feedbackStore";
export { MachineStore } from "./machineStore";
export { MessageStore } from "./messageStore";
export { PushStore } from "./pushStore";
export { QueuedMessageStore } from "./queuedMessageStore";
export { RecentPathStore } from "./recentPathStore";
export { HarnessStore } from "./harnessStore";
export type { HarnessDetectionUpsert } from "./harnessStore";
export { ImpactAnalysisStore } from "./impactAnalysisStore";
export type {
  ImpactAnalysisUpsert,
  ImpactAnalysisRecord,
} from "./impactAnalysisStore";
export { SessionStore } from "./sessionStore";
export { TimeLogStore } from "./timeLogStore";
export { PeerStore } from "./peerStore";
export { ExtensionPrefsStore } from "./extensionPrefsStore";
export { BookmarkStore } from "./bookmarkStore";
export { LeaseStore } from "./leaseStore";
export type { LeaseAcquireResult, LeaseHolder } from "./leaseStore";
export { FileClaimsStore } from "./fileClaimsStore";
export type {
  CreateFileClaimInput,
  ReleaseClaimsScope,
} from "./fileClaimsStore";
export type {
  StoredFileClaim,
  FileClaimType,
  FileClaimChangeKind,
} from "./types";
export { InitiativeStore } from "./initiativeStore";
export { WatermarkStore } from "./watermarkStore";
export type { PersistedWatermarkRow } from "./watermarkStore";
export type {
  CreateInitiativeInput,
  ListInitiativesFilter,
} from "./initiativeStore";
export type {
  StoredInitiative,
  StoredInitiativeEvent,
  StoredInitiativeRosterEntry,
  InitiativePhase,
  InitiativeEventKind,
} from "./types";
export {
  PredictionAccuracyStore,
  computePrecisionRecall,
} from "./predictionAccuracyStore";
export type { RecordPredictionAccuracyInput } from "./predictionAccuracyStore";
export type { StoredPredictionAccuracy } from "./types";
export { UserStore } from "./userStore";
export { MidnightResetStateStore } from "./midnightResetStateStore";
export type { MidnightResetState } from "./midnightResetStateStore";
export { UsageHistoryStore } from "./usageHistoryStore";
export type {
  UsageSnapshotRow,
  InsertUsageSnapshot,
} from "./usageHistoryStore";
export { UsageAlertStore } from "./usageAlertStore";
export { TurnStore } from "./turns/turnStore";
export { PmRosterStore } from "./turns/pmRosterStore";
export { BackgroundAgentUsageStore } from "./turns/backgroundAgentUsage";
export type { BackgroundAgentUsageUpsert } from "./turns/backgroundAgentUsage";
export type {
  AppendEventsInput,
  FinalizeTurnInput,
  OpenTurnInput,
  RateCardRow,
  TimelogAdjustmentRow,
  TurnEventInput,
  TurnEventKind,
  TurnEventRow,
  TurnRow,
  TurnStatus,
} from "./turns/types";

const SCHEMA_VERSION = 1;
const REQUIRED_TABLES = [
  "sessions",
  "machines",
  "messages",
  "users",
  "push_subscriptions",
] as const;

export class Store {
  private db: Database;
  private readonly dbPath: string;

  // Issue #1266 (Sub-Issue B): extension-contributed migrations queued via
  // `registerExtensionMigration`, executed by `runExtensionMigrations` — which
  // the extension loader (Sub-Issue F) calls AFTER core `initSchema()` so the
  // core-before-extension ordering invariant holds.
  private readonly extensionMigrations: Array<(db: Database) => void> = [];

  readonly sessions: SessionStore;
  readonly machines: MachineStore;
  readonly messages: MessageStore;
  readonly users: UserStore;
  readonly push: PushStore;
  readonly recentPaths: RecentPathStore;
  readonly harness: HarnessStore;
  readonly impactAnalysis: ImpactAnalysisStore;
  /** Non-droppable audit log for privileged self-update actions (#1774). */
  readonly audit: AuditStore;
  /** In-flight lock for the self-update flow (#1774): the 409-producer + the
   *  poll's prior_version interlock. */
  readonly updateStatus: UpdateStatusStore;
  readonly timeLogs: TimeLogStore;
  readonly errorLogs: ErrorLogStore;
  readonly feedback: FeedbackStore;
  readonly peers: PeerStore;
  readonly leases: LeaseStore;
  readonly fileClaims: FileClaimsStore;
  readonly initiatives: InitiativeStore;
  readonly watermark: WatermarkStore;
  readonly predictionAccuracy: PredictionAccuracyStore;
  readonly midnightResetState: MidnightResetStateStore;
  readonly queuedMessages: QueuedMessageStore;
  readonly usageHistory: UsageHistoryStore;
  readonly usageAlertState: UsageAlertStore;
  readonly turns: TurnStore;
  readonly turnMirror: TurnMirrorStore;
  readonly pmRoster: PmRosterStore;
  /** Issue #4385: background agents' full usage, recorded at completion. */
  readonly backgroundAgentUsage: BackgroundAgentUsageStore;
  /**
   * Count-shaped analytics reader over `turn_events` (issue #1889, Sub K2).
   * Re-points the telemetry summary/timeseries/files endpoints onto the
   * per-turn core for skill/subagent/mcp_call; needs the private `db` handle,
   * so it is constructed here like `turns` rather than wired in `index.ts`.
   */
  readonly turnAnalytics: TurnAnalyticsCounts;
  readonly parityRuns: ParityRunsStore;
  readonly timelogAdjustments: TimelogAdjustmentsStore;
  readonly extensionPrefs: ExtensionPrefsStore;
  readonly bookmarks: BookmarkStore;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:" && !dbPath.startsWith("file::memory:")) {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch (error) {
        console.warn(`[Store] Failed to chmod directory ${dir}:`, error);
      }

      if (!existsSync(dbPath)) {
        try {
          const fd = openSync(dbPath, "a", 0o600);
          closeSync(fd);
        } catch (error) {
          console.warn(
            `[Store] Failed to create database file ${dbPath}:`,
            error
          );
        }
      }
    }

    this.db = new Database(dbPath, {
      create: true,
      readwrite: true,
      strict: true,
    });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initSchema();

    // #2447: long-lived-connection first-open form for SQLite's optimize pragma.
    // 0x10002 = run ANALYZE on tables that might benefit (0x00002) + check all
    // table sizes for growth (0x10000); bounded by the default analysis_limit.
    // Runs after initSchema() so it also covers "optimize after CREATE INDEX".
    this.db.exec("PRAGMA optimize=0x10002");
    console.log(
      "[Store] SQLite planner stats seeded at boot (optimize=0x10002)"
    );

    if (dbPath !== ":memory:" && !dbPath.startsWith("file::memory:")) {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          chmodSync(path, 0o600);
        } catch (error) {
          // WAL/SHM files may not exist yet — only warn for the main DB file
          if (path === dbPath) {
            console.warn(`[Store] Failed to chmod ${path}:`, error);
          }
        }
      }
    }

    this.sessions = new SessionStore(this.db);
    this.machines = new MachineStore(this.db);
    this.messages = new MessageStore(this.db);
    this.users = new UserStore(this.db);
    this.push = new PushStore(this.db);
    this.recentPaths = new RecentPathStore(this.db);
    this.harness = new HarnessStore(this.db);
    this.impactAnalysis = new ImpactAnalysisStore(this.db);
    this.audit = new AuditStore(this.db);
    this.updateStatus = new UpdateStatusStore(this.db);
    this.timeLogs = new TimeLogStore(this.db);
    this.errorLogs = new ErrorLogStore(this.db);
    this.feedback = new FeedbackStore(this.db);
    this.peers = new PeerStore(this.db);
    this.leases = new LeaseStore(this.db);
    this.fileClaims = new FileClaimsStore(this.db);
    this.initiatives = new InitiativeStore(this.db);
    this.watermark = new WatermarkStore(this.db);
    this.predictionAccuracy = new PredictionAccuracyStore(this.db);
    this.midnightResetState = new MidnightResetStateStore(this.db);
    this.queuedMessages = new QueuedMessageStore(this.db);
    this.usageHistory = new UsageHistoryStore(this.db);
    this.usageAlertState = new UsageAlertStore(this.db);
    this.turns = new TurnStore(this.db);
    this.turnMirror = new TurnMirrorStore(this.db);
    this.pmRoster = new PmRosterStore(this.db);
    this.backgroundAgentUsage = new BackgroundAgentUsageStore(this.db);
    this.turnAnalytics = new TurnAnalyticsCounts(this.db);
    this.parityRuns = new ParityRunsStore(this.db);
    this.timelogAdjustments = new TimelogAdjustmentsStore(this.db);
    this.extensionPrefs = new ExtensionPrefsStore(this.db);
    this.bookmarks = new BookmarkStore(this.db);
  }

  /**
   * Issue #1670 (Sub H1, PR-2): TS-derived daily time-log read.
   * Encapsulates the private `db` handle so the time-log route can compute the
   * per-namespace, timezone-aware daily buckets without exposing the raw DB.
   * Dormant until the cutover gate is green (see `cutoverGate.ts`).
   */
  deriveDailyTimeLog(
    opts: DeriveTimelogOptions
  ): Map<string, DerivedDailyBucket> {
    return deriveDailyTimeLog(this.db, opts);
  }

  /**
   * Issue #1892 Task 3B: turns-derived per-session breakdown per local-day bucket.
   * Surfaced on `GET /timelogs/derived` to populate the TimeLogModal breakdown
   * post-cutover (archive fallback for pre-turns days is applied on the client).
   */
  deriveDailyBreakdown(
    opts: DeriveTimelogOptions
  ): Map<string, SessionBreakdownItem[]> {
    return deriveDailyBreakdown(this.db, opts);
  }

  private initSchema(): void {
    const currentVersion = this.getUserVersion();
    if (currentVersion === 0) {
      if (this.hasAnyUserTables()) {
        this.setUserVersion(SCHEMA_VERSION);
        this.runMigrations();
        return;
      }

      this.createSchema();
      this.setUserVersion(SCHEMA_VERSION);
      // Issue #1122: run migrations even on fresh DBs so post-baseline
      // additions (e.g. `_migration_markers`, one-time data cleanups)
      // apply alongside the base schema. All migration blocks are
      // idempotent — `IF NOT EXISTS`, `migrateAddColumn` PRAGMA check,
      // and marker-guarded data mutations — so re-running here is safe.
      this.runMigrations();
      return;
    }

    if (currentVersion !== SCHEMA_VERSION) {
      throw this.buildSchemaMismatchError(currentVersion);
    }

    this.assertRequiredTablesPresent();
    this.runMigrations();
  }

  private runMigrations(): void {
    this.migrateAddColumn("sessions", "notes", "TEXT");
    // Issue #3286 (View Picker): server-persisted selected view. Additive/nullable
    // so existing session rows stay valid (rollback-safe, mirrors the notes column).
    this.migrateAddColumn("sessions", "persisted_view", "TEXT");
    this.migrateAddColumn("sessions", "prompt_draft", "TEXT");
    this.migrateAddColumn("sessions", "emoji", "TEXT");
    this.migrateAddColumn("sessions", "timer_data", "TEXT");
    this.migrateAddColumn("sessions", "linked_issue", "TEXT");
    this.migrateAddColumn("sessions", "resolved_model", "TEXT");
    // Issue #1469: first-order context window + live usage (per-turn push)
    this.migrateAddColumn("sessions", "context_window_tokens", "INTEGER");
    this.migrateAddColumn("sessions", "context_used_tokens", "INTEGER");
    this.migrateAddColumn("sessions", "context_percentage", "INTEGER");
    this.migrateAddColumn("sessions", "needs_review_override", "TEXT");
    this.migrateAddColumn("sessions", "auto_recover_from_api_error", "INTEGER");
    this.migrateAddColumn("sessions", "ui_collapse_state", "TEXT");
    this.migrateAddColumn(
      "sessions",
      "server_accumulated_ms",
      "INTEGER DEFAULT 0"
    );

    // Conversation branching (#229)
    this.migrateAddColumn("sessions", "parent_session_id", "TEXT");
    // Parent relationship discriminator (#2479): "branch" | "spawn"
    this.migrateAddColumn("sessions", "parent_relationship", "TEXT");
    this.migrateAddColumn("sessions", "branch_label", "TEXT");
    this.migrateAddColumn("sessions", "branch_created_at", "INTEGER");

    // Denormalized user-message counter (#1032): removes the O(messages)
    // json_extract scan from /api/sessions. Maintained by MessageStore.addMessage.
    this.migrateAddColumn(
      "sessions",
      "user_message_count",
      "INTEGER NOT NULL DEFAULT 0"
    );
    this.backfillUserMessageCount();

    // Denormalized last-operator-message timestamp (#5254 R2): the runaway
    // ceiling guard's inactivity gate reads it at every turn finalize, where a
    // json_extract scan of `messages` took 6.7 s cold. Maintained by
    // MessageStore.addMessage. Deliberately NOT in CREATE TABLE so every DB
    // takes this path and the grace seed below is its only bulk writer.
    this.migrateAddLastOperatorMessageAt();

    // Issue #1120: provenance, timezone, reset-epoch columns on timelog_entries.
    // event_type carries a CHECK constraint inline — SQLite supports CHECK in
    // ALTER TABLE ADD COLUMN, and the constraint only applies to values written
    // after this migration runs (NULL values in pre-migration rows are tolerated).
    this.migrateAddColumn(
      "timelog_entries",
      "event_type",
      "TEXT DEFAULT 'flush' CHECK(event_type IN ('flush','midnight-reset','manual','session-end','backfill'))"
    );
    this.migrateAddColumn("timelog_entries", "timezone", "TEXT");
    this.migrateAddColumn("timelog_entries", "reset_epoch", "INTEGER");

    // Issue #1244 finding #4: capture client-side enqueuedAt for replayed
    // error reports as a separate fact from `timestamp` (= INSERT time).
    // Live POSTs leave this NULL; replays populate it from the persisted
    // `enqueuedAt`. New column avoids changing existing
    // idx_error_logs_timestamp / getEntries(startTime/endTime) semantics.
    this.migrateAddColumn("error_logs", "original_timestamp", "INTEGER");

    // Create recent_paths table if it doesn't exist
    try {
      const hasRecentPaths = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_paths'"
        )
        .get() as { name: string } | undefined;

      if (!hasRecentPaths) {
        this.db.exec(`
                    CREATE TABLE IF NOT EXISTS recent_paths (
                        machine_id TEXT NOT NULL,
                        namespace TEXT NOT NULL DEFAULT 'default',
                        path TEXT NOT NULL,
                        used_at INTEGER NOT NULL,
                        PRIMARY KEY (machine_id, namespace, path)
                    );
                `);
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE recent_paths:`,
        error
      );
    }

    // Issue #1770: harness self-update detection state, keyed (node_id,
    // harness_id) — the epic #1769 foundation. Deliberately additive via
    // runMigrations() and NOT in REQUIRED_TABLES / SCHEMA_VERSION (adding it
    // there would crash existing DBs). `prior_version` is the rollback slot,
    // written only by #1774; the poll upsert preserves it. `changelog_text`
    // (~126 KB) is read back server-side only (HarnessStore.getChangelogText).
    try {
      this.db.exec(`
                    CREATE TABLE IF NOT EXISTS harness_detection_state (
                        node_id TEXT NOT NULL,
                        harness_id TEXT NOT NULL,
                        installed_version TEXT,
                        latest_version TEXT,
                        prior_version TEXT,
                        update_available INTEGER NOT NULL DEFAULT 0,
                        changelog_text TEXT,
                        last_checked_at INTEGER,
                        last_error TEXT,
                        last_error_at INTEGER,
                        PRIMARY KEY (node_id, harness_id)
                    );
                `);
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE harness_detection_state:`,
        error
      );
    }

    // Issue #1772 (Sub C, epic #1769): on-demand impact-analysis artifacts,
    // keyed (node_id, harness_id, version_range) where version_range is the
    // canonical versionRangeKey(from, to). Additive via runMigrations() and NOT
    // in REQUIRED_TABLES / SCHEMA_VERSION (adding it there would crash existing
    // DBs — mirrors harness_detection_state above). `artifact_json` holds the
    // validated ImpactArtifact; `seed_span_json` persists the UpdateSpan that
    // seeded the analysis so a fresh companion can be re-seeded later (#1774).
    // A re-analysis of a range UPSERTs in place (no duplicate rows).
    try {
      this.db.exec(`
                    CREATE TABLE IF NOT EXISTS claude_update_analysis (
                        node_id TEXT NOT NULL,
                        harness_id TEXT NOT NULL,
                        version_range TEXT NOT NULL,
                        version_from TEXT NOT NULL,
                        version_to TEXT NOT NULL,
                        analyzed_at INTEGER NOT NULL,
                        peer_session_id TEXT,
                        artifact_json TEXT NOT NULL,
                        seed_span_json TEXT NOT NULL,
                        PRIMARY KEY (node_id, harness_id, version_range)
                    );
                `);
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE claude_update_analysis:`,
        error
      );
    }

    // Issue #1774 (Sub E, epic #1769): non-droppable audit log for privileged
    // self-update actions. One row per update/rollback (actor, node, harness,
    // from→to, outcome, detail). Written SYNCHRONOUSLY via AuditStore.append —
    // NOT errorLogger (rate-limited + drops on flood). Additive via
    // runMigrations() and NOT in REQUIRED_TABLES / SCHEMA_VERSION (adding it
    // there would crash existing DBs — mirrors harness_detection_state above).
    try {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS audit_logs (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
          "timestamp INTEGER NOT NULL, " +
          "actor TEXT, " +
          "node_id TEXT NOT NULL, " +
          "harness_id TEXT NOT NULL, " +
          "action TEXT NOT NULL, " +
          "from_version TEXT, " +
          "to_version TEXT, " +
          "outcome TEXT NOT NULL, " +
          "detail TEXT)"
      );
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp " +
          "ON audit_logs(timestamp)"
      );
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE audit_logs:`,
        error
      );
    }

    // Issue #1774 (Sub E, epic #1769): in-flight lock for the self-update flow,
    // keyed (node_id, harness_id). The 409-producer (a second concurrent apply
    // while one is `updating` cannot acquire → update_in_flight) AND the
    // interlock #1770's poll cites: while this reads `updating`, the poll must
    // not clobber the prior_version rollback slot. Additive; NOT in
    // REQUIRED_TABLES / SCHEMA_VERSION.
    try {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS harness_update_status (" +
          "node_id TEXT NOT NULL, " +
          "harness_id TEXT NOT NULL, " +
          "status TEXT NOT NULL CHECK (status IN ('idle','updating')), " +
          "started_at INTEGER, " +
          "PRIMARY KEY (node_id, harness_id))"
      );
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE harness_update_status:`,
        error
      );
    }

    // Issue #1325: server-backed message queue. Drains on session idle
    // (thinking false-after-true) and on reconnect (active false-after-true).
    // The partial unique index on (session_id, client_generated_id) enforces
    // migration-idempotency for the one-shot legacy sessionStorage cutover.
    try {
      const hasQueuedMessages = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'queued_messages'"
        )
        .get() as { name: string } | undefined;

      if (!hasQueuedMessages) {
        this.db.exec(`
                    CREATE TABLE IF NOT EXISTS queued_messages (
                        id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        namespace TEXT NOT NULL,
                        body TEXT NOT NULL,
                        position INTEGER NOT NULL,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL,
                        client_generated_id TEXT
                    );
                    CREATE INDEX IF NOT EXISTS idx_queued_msgs_session_pos
                        ON queued_messages(session_id, position);
                    CREATE INDEX IF NOT EXISTS idx_queued_msgs_session_ns
                        ON queued_messages(session_id, namespace);
                    CREATE UNIQUE INDEX IF NOT EXISTS idx_queued_msgs_session_client
                        ON queued_messages(session_id, client_generated_id)
                        WHERE client_generated_id IS NOT NULL;
                `);
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE queued_messages:`,
        error
      );
    }

    // Create timelog_entries table if it doesn't exist
    try {
      const tables = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timelog_entries'"
        )
        .get() as { name: string } | undefined;

      if (!tables) {
        this.db.exec(`
                    CREATE TABLE IF NOT EXISTS timelog_entries (
                        id TEXT PRIMARY KEY,
                        session_id TEXT NOT NULL,
                        session_name TEXT NOT NULL,
                        project_directory TEXT NOT NULL,
                        date TEXT NOT NULL,
                        duration_ms INTEGER NOT NULL DEFAULT 0,
                        created_at INTEGER NOT NULL,
                        namespace TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_timelog_date ON timelog_entries(date);
                    CREATE INDEX IF NOT EXISTS idx_timelog_session ON timelog_entries(session_id);
                    CREATE INDEX IF NOT EXISTS idx_timelog_namespace ON timelog_entries(namespace);
                    CREATE INDEX IF NOT EXISTS idx_timelog_date_namespace ON timelog_entries(date, namespace);
                `);
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE timelog_entries:`,
        error
      );
    }

    // Create error_logs table if it doesn't exist
    try {
      const hasErrorLogs = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'error_logs'"
        )
        .get() as { name: string } | undefined;

      if (!hasErrorLogs) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS error_logs (
            id TEXT PRIMARY KEY,
            timestamp INTEGER NOT NULL,
            severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error','fatal')),
            category TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('server','client','cli')),
            message TEXT NOT NULL,
            stack TEXT,
            session_id TEXT,
            namespace TEXT,
            context TEXT,
            user_agent TEXT,
            request_path TEXT,
            request_method TEXT,
            status_code INTEGER,
            original_timestamp INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs(timestamp);
          CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs(severity);
          CREATE INDEX IF NOT EXISTS idx_error_logs_category ON error_logs(category);
          CREATE INDEX IF NOT EXISTS idx_error_logs_session_id ON error_logs(session_id);
          CREATE INDEX IF NOT EXISTS idx_error_logs_source ON error_logs(source);
          CREATE INDEX IF NOT EXISTS idx_error_logs_severity_timestamp ON error_logs(severity, timestamp);
        `);
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE error_logs:`,
        error
      );
    }

    // Create feedback table if it doesn't exist (issue #2664, epic #2663).
    // Persist-first record for in-app user feedback: the row survives even when
    // the email send fails (R7/R10). Mirrors the error_logs create block above.
    try {
      const hasFeedback = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback'"
        )
        .get() as { name: string } | undefined;

      if (!hasFeedback) {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS feedback (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            namespace TEXT,
            category TEXT NOT NULL,
            description TEXT NOT NULL,
            submitter_email TEXT,
            metadata_json TEXT NOT NULL,
            attachments_json TEXT,
            emailed INTEGER NOT NULL DEFAULT 0,
            email_error TEXT
          )
        `);
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_feedback_namespace ON feedback(namespace)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_feedback_category ON feedback(category)"
        );
      }
      // Issue #2665: attachment metadata side column. Runs unconditionally
      // (PRAGMA-guarded, idempotent) so a pre-existing #2664 feedback table
      // gains the column too — NOT only brand-new DBs.
      this.migrateAddColumn("feedback", "attachments_json", "TEXT");
    } catch (error) {
      console.error(`[Store] Migration failed: CREATE TABLE feedback:`, error);
    }

    // Issue #1119: per-namespace midnight reset state for restart catch-up.
    try {
      const hasMidnightResetState = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'midnight_reset_state'"
        )
        .get() as { name: string } | undefined;

      if (!hasMidnightResetState) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS midnight_reset_state (" +
            "namespace TEXT PRIMARY KEY, " +
            "timezone TEXT NOT NULL, " +
            "last_reset_date TEXT NOT NULL, " +
            "last_reset_epoch INTEGER NOT NULL, " +
            "updated_at INTEGER NOT NULL)"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE midnight_reset_state:`,
        error
      );
    }

    // Issue #1122: generic marker table for one-time data migrations.
    // Distinct from `midnight_reset_state` (which drives runtime catch-up
    // logic in SyncEngine) so cleanup-marker keys can never collide with
    // namespace-based reset state.
    try {
      const hasMigrationMarkers = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_migration_markers'"
        )
        .get() as { name: string } | undefined;

      if (!hasMigrationMarkers) {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS _migration_markers (" +
            "key TEXT PRIMARY KEY, " +
            "applied_at INTEGER NOT NULL, " +
            "rows_affected INTEGER, " +
            "strategy TEXT, " +
            "metadata TEXT)"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE _migration_markers:`,
        error
      );
    }

    // Issue #1644: cross-machine account rotation lease ledger. Hub-authoritative
    // (only the hub's hapi.db is consulted); `account_uuid` IS the refresh-token
    // family key (client_id is constant). See server/src/store/leaseStore.ts.
    try {
      const hasAccountRotationLeases = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'account_rotation_leases'"
        )
        .get() as { name: string } | undefined;

      if (!hasAccountRotationLeases) {
        this.db.run(
          "CREATE TABLE IF NOT EXISTS account_rotation_leases (" +
            "account_uuid TEXT PRIMARY KEY, " +
            "holder_node_id TEXT NOT NULL, " +
            "acquired_at INTEGER NOT NULL, " +
            "heartbeat_at INTEGER NOT NULL, " +
            "expires_at INTEGER NOT NULL)"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE account_rotation_leases:`,
        error
      );
    }

    // Epic #1855, Sub-Issue I (#1864): per-account usage snapshots — one row per
    // (account_uuid, limit_key, sampled_at). Backs the history sparkline +
    // projected-exhaustion estimate. Bounded retention via UsageHistoryStore.
    try {
      const hasUsageSnapshots = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_snapshots'"
        )
        .get() as { name: string } | undefined;

      if (!hasUsageSnapshots) {
        this.db.run(
          "CREATE TABLE IF NOT EXISTS usage_snapshots (" +
            "account_uuid TEXT NOT NULL, " +
            "limit_key TEXT NOT NULL, " +
            "utilization REAL NOT NULL, " +
            "sampled_at INTEGER NOT NULL)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_usage_snapshots_lookup " +
            "ON usage_snapshots(account_uuid, limit_key, sampled_at)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_usage_snapshots_sampled_at " +
            "ON usage_snapshots(sampled_at)"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE usage_snapshots:`,
        error
      );
    }

    // Epic #1855, Sub-Issue H (#1863): per-(account, limit, threshold) alert
    // de-dupe state — one row records the most recent reset window_key for which
    // a usage-threshold push was already sent. Bounded by construction; re-arms
    // on a window change. Backs UsageAlertStore.shouldAlert / recordAlerted.
    try {
      const hasUsageAlertState = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_alert_state'"
        )
        .get() as { name: string } | undefined;

      if (!hasUsageAlertState) {
        this.db.run(
          "CREATE TABLE IF NOT EXISTS usage_alert_state (" +
            "account_uuid TEXT NOT NULL, " +
            "limit_key TEXT NOT NULL, " +
            "threshold INTEGER NOT NULL, " +
            "window_key TEXT NOT NULL, " +
            "alerted_at INTEGER NOT NULL, " +
            "PRIMARY KEY (account_uuid, limit_key, threshold))"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE usage_alert_state:`,
        error
      );
    }

    // Epic #1965, Sub A (#1966): per-session file-claim ledger for the File
    // Conflict Monitor. `path` + `(repo, path)` indexes back the "who claims X"
    // lookup; `session_id` index backs bulk release. Soft-release via released_at
    // (no FK to sessions — history is preserved for #1972; session_id may be
    // FK-less under federation, matching timelog_entries/error_logs). Pure store;
    // lifecycle is #1968. SCHEMA_VERSION stays 1.
    try {
      const hasFileClaims = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_file_claims'"
        )
        .get() as { name: string } | undefined;

      if (!hasFileClaims) {
        this.db.run(
          "CREATE TABLE IF NOT EXISTS session_file_claims (" +
            "id TEXT PRIMARY KEY, " +
            "session_id TEXT NOT NULL, " +
            "repo TEXT NOT NULL, " +
            "path TEXT NOT NULL, " +
            "claim_type TEXT NOT NULL CHECK (claim_type IN ('expected','active')), " +
            "change_kind TEXT NOT NULL CHECK (change_kind IN ('edit','rename','move','delete')), " +
            "claimed_at INTEGER NOT NULL, " +
            "released_at INTEGER)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_file_claims_path " +
            "ON session_file_claims(path)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_file_claims_repo_path " +
            "ON session_file_claims(repo, path)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_file_claims_session " +
            "ON session_file_claims(session_id)"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE session_file_claims:`,
        error
      );
    }

    // File Conflict Monitor follow-up (#2815): time-ordered index backing the
    // conflict-history window scan (`getConflictHistory`'s `claimed_at >= ?` +
    // `ORDER BY claimed_at DESC LIMIT n`). Deliberately OUTSIDE the
    // `!hasFileClaims` guard above — statements inside it never run once the
    // table exists, so an index added there would never reach an existing
    // deployment.
    try {
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_file_claims_claimed_at " +
          "ON session_file_claims(claimed_at)"
      );
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE INDEX idx_file_claims_claimed_at:`,
        error
      );
    }

    // Issue #3115 (epic #3133): server-side chat bookmarks with arbitrary-row
    // anchoring. Surrogate `id` PK + a UNIQUE index over
    // (session_id, message_id, COALESCE(block_id,'')) — NOT a composite PK
    // containing the nullable block_id, because SQLite treats NULLs as pairwise
    // DISTINCT in a UNIQUE/PK, which would let duplicate whole-turn (null-blockId)
    // bookmarks slip past the constraint and break the idempotent upsert. COALESCE
    // maps null → '' so the whole-turn anchor is deduped like any other. FK-less
    // (parity with session_file_claims — a session may live on a peer under
    // federation); node-local per RULING D2=A. SCHEMA_VERSION stays 1.
    try {
      const hasBookmarks = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_bookmarks'"
        )
        .get() as { name: string } | undefined;

      if (!hasBookmarks) {
        // Issue #3146: a bookmark is a scroll POSITION — anchor element +
        // `offset_px` (pixel offset of the tapped spot within that element). The
        // unique index now includes offset_px so ONE message/block can hold
        // MULTIPLE bookmarks at arbitrary spots (a re-tap at the same spot is
        // idempotent; a tap at a different spot is a new bookmark).
        this.db.run(
          "CREATE TABLE IF NOT EXISTS session_bookmarks (" +
            "id TEXT PRIMARY KEY, " +
            "session_id TEXT NOT NULL, " +
            "message_id TEXT NOT NULL, " +
            "block_id TEXT, " +
            "offset_px INTEGER NOT NULL DEFAULT 0, " +
            "anchor_height_px INTEGER, " +
            "created_at INTEGER NOT NULL)"
        );
        this.db.run(
          "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_bookmarks_anchor " +
            "ON session_bookmarks(session_id, message_id, COALESCE(block_id, ''), offset_px)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_session_bookmarks_session " +
            "ON session_bookmarks(session_id)"
        );
      } else {
        // Issue #3146 migration on a pre-existing (#3115, one-day-old) table:
        // add offset_px (legacy rows default to 0 = the block top) and evolve the
        // unique index from (session, message, block) to
        // (session, message, block, offset_px). Idempotent — guarded by a
        // PRAGMA table_info probe so a re-run is a no-op.
        const bookmarkCols = (
          this.db
            .prepare("PRAGMA table_info(session_bookmarks)")
            .all() as Array<{ name: string }>
        ).map(col => col.name);
        const hasOffsetCol = bookmarkCols.includes("offset_px");
        if (!hasOffsetCol) {
          this.db.run(
            "ALTER TABLE session_bookmarks ADD COLUMN offset_px INTEGER NOT NULL DEFAULT 0"
          );
          this.db.run("DROP INDEX IF EXISTS idx_session_bookmarks_anchor");
          this.db.run(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_bookmarks_anchor " +
              "ON session_bookmarks(session_id, message_id, COALESCE(block_id, ''), offset_px)"
          );
        }
        // Issue #3878 (ruling A1′): the anchor element's height at creation, so
        // navigation can scale `offset_px` when the element re-lays out. Its OWN
        // probe, independent of the offset_px one — a #3146-migrated table
        // already has offset_px but not this column. Additive + nullable (legacy
        // rows stay NULL = raw offset); non-uniquing, so the anchor index is
        // untouched. Idempotent: a re-run finds the column and no-ops.
        if (!bookmarkCols.includes("anchor_height_px")) {
          this.db.run(
            "ALTER TABLE session_bookmarks ADD COLUMN anchor_height_px INTEGER"
          );
        }
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE session_bookmarks:`,
        error
      );
    }

    // Epic #1965, Sub G (#1972): prediction-accuracy dataset for the File
    // Conflict Monitor. Persists the predicted-vs-actual file footprint of each
    // closed issue + computed precision/recall — the ground-truth dataset that
    // powers the rp1-home closer's accuracy report and the churn ignore-list
    // auto-suggestion. UNIQUE(repo, issue) backs the idempotent-replace upsert
    // (INSERT ... ON CONFLICT); the `repo` index backs the by-repo read. Pure
    // store; NOT in REQUIRED_TABLES and SCHEMA_VERSION stays 1 (parity with
    // session_file_claims — a reverted binary simply stops touching it).
    try {
      const hasPredictionAccuracy = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'prediction_accuracy'"
        )
        .get() as { name: string } | undefined;

      if (!hasPredictionAccuracy) {
        this.db.run(
          "CREATE TABLE IF NOT EXISTS prediction_accuracy (" +
            "id TEXT PRIMARY KEY, " +
            "repo TEXT NOT NULL, " +
            "issue TEXT NOT NULL, " +
            "predicted TEXT NOT NULL, " +
            "actual TEXT NOT NULL, " +
            "precision REAL NOT NULL, " +
            "recall REAL NOT NULL, " +
            "recorded_at INTEGER NOT NULL, " +
            "UNIQUE(repo, issue))"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_prediction_accuracy_repo " +
            "ON prediction_accuracy(repo)"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE prediction_accuracy:`,
        error
      );
    }

    // Skill-revamp 3.1 (#2156, epic rp1-home#1319): the first-class initiative
    // object — scope ref + session roster + token budget + current phase + an
    // append-only event log. Three tables: `initiatives` (the entity),
    // `initiative_roster` (per-membership child table — a JSON blob column would
    // make "attach appends an event atomically" unqueryable), and
    // `initiative_events` (the append-only log). The `(initiative_id,
    // created_at_ms DESC)` index makes R3's "N most recent events" a single
    // indexed read; the second `(initiative_id, id)` index serves #2157's
    // `id > cursor` event drain (UUIDv7 event ids are time-ordered). NO CHECK on
    // `phase` / `kind` — house rule K1 (canonical values are a TS union at the
    // API edge, not a DB constraint; #2157/#2158 append SUPERSET kinds). No FK to
    // `sessions` — history survives session deletion and `session_id` may be
    // FK-less under federation (parity with session_file_claims). Pure store;
    // NOT in REQUIRED_TABLES and SCHEMA_VERSION stays 1 (a reverted binary simply
    // stops touching these tables).
    try {
      const hasInitiatives = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'initiatives'"
        )
        .get() as { name: string } | undefined;

      if (!hasInitiatives) {
        this.db.run(
          "CREATE TABLE IF NOT EXISTS initiatives (" +
            "id TEXT PRIMARY KEY, " +
            "scope_ref TEXT NOT NULL, " +
            "phase TEXT NOT NULL DEFAULT 'planning', " +
            "token_budget INTEGER, " +
            "tokens_spent INTEGER NOT NULL DEFAULT 0, " +
            "created_at_ms INTEGER NOT NULL, " +
            "updated_at_ms INTEGER, " +
            "reconciled_at_ms INTEGER)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_initiatives_scope " +
            "ON initiatives(scope_ref)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_initiatives_phase " +
            "ON initiatives(phase)"
        );
        this.db.run(
          "CREATE TABLE IF NOT EXISTS initiative_roster (" +
            "initiative_id TEXT NOT NULL, " +
            "session_id TEXT NOT NULL, " +
            "attached_at_ms INTEGER NOT NULL, " +
            "detached_at_ms INTEGER, " +
            "PRIMARY KEY(initiative_id, session_id))"
        );
        this.db.run(
          "CREATE TABLE IF NOT EXISTS initiative_events (" +
            "id TEXT PRIMARY KEY, " +
            "initiative_id TEXT NOT NULL, " +
            "kind TEXT NOT NULL, " +
            "payload TEXT, " +
            "created_at_ms INTEGER NOT NULL)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_initiative_events_initiative " +
            "ON initiative_events(initiative_id, created_at_ms DESC)"
        );
        this.db.run(
          "CREATE INDEX IF NOT EXISTS idx_initiative_events_cursor " +
            "ON initiative_events(initiative_id, id)"
        );
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE initiatives:`,
        error
      );
    }

    // Skill-revamp 3.4 (#2158, epic rp1-home#1319): context-watermark successor
    // handoff. ONE small table `context_watermark_state` persists the two
    // safety-critical facts that MUST survive a restart: the `handing_off` input
    // HOLD (a forgotten hold reopens the reap race) and the disarm `suppressed`
    // flag (a forgotten flag re-arms a manually-disarmed session within one poll).
    // The transient `armed`/`deferredReason`/`contextPercentage` fields are NOT
    // persisted — a restart between arm and fire self-heals on the next poll.
    // Additive, node-local. No FK to `sessions` (the hold survives session churn,
    // parity with session_file_claims); no CHECK on `handoff_state` (house rule
    // K1). Pure store; NOT in REQUIRED_TABLES and SCHEMA_VERSION stays put (a
    // reverted binary simply stops touching this table).
    try {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS context_watermark_state (" +
          "session_id TEXT PRIMARY KEY, " +
          "handoff_state TEXT NOT NULL DEFAULT 'idle', " +
          "suppressed INTEGER NOT NULL DEFAULT 0, " +
          "generation INTEGER NOT NULL DEFAULT 0, " +
          "updated_at_ms INTEGER NOT NULL)"
      );
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE context_watermark_state:`,
        error
      );
    }

    // Skill-revamp 3.2 (#2157, epic rp1-home#1319): event-driven PM support for
    // the GitHub webhook receiver + gap detector. Two small tables:
    // `webhook_deliveries` (R3's exactly-once key — `X-GitHub-Delivery` id,
    // stable across GitHub redeliveries; pruned to 7 days on insert) and
    // `webhook_health` (R6's gap signal — last verified delivery ms per repo).
    // Additive, node-local. Same DDL discipline as every migration here: DDL
    // hoisted to a const, IF NOT EXISTS, try/catch. Pure store; NOT in
    // REQUIRED_TABLES and SCHEMA_VERSION stays 1 (a reverted binary simply stops
    // touching them — the event drain reads `initiative_events`, which #2156
    // owns).
    try {
      this.db.run(
        "CREATE TABLE IF NOT EXISTS webhook_deliveries (" +
          "delivery_id TEXT PRIMARY KEY, " +
          "event TEXT, " +
          "received_at_ms INTEGER NOT NULL)"
      );
      this.db.run(
        "CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received " +
          "ON webhook_deliveries(received_at_ms)"
      );
      this.db.run(
        "CREATE TABLE IF NOT EXISTS webhook_health (" +
          "repo TEXT PRIMARY KEY, " +
          "last_delivery_at_ms INTEGER NOT NULL)"
      );
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE webhook_deliveries/webhook_health:`,
        error
      );
    }

    // Epic #1662, Sub A (#1663): session-metadata / per-turn telemetry core.
    // 4 new sidebar/federation columns on `sessions` + the turns schema (4 tables,
    // indexes, the D1 partial-unique idempotency index, 5 views) via
    // applyTurnsMigrations. node_id is the federation source of truth
    // (metadata.originatingNodeId stays transport-only); parent_session_id /
    // branch_label / branch_created_at already exist (#229) and are untouched.
    // SCHEMA_VERSION stays 1 (D7: user_version is a frozen mismatch gate).
    this.migrateAddColumn("sessions", "node_id", "TEXT");
    this.migrateAddColumn("sessions", "orchestration_id", "TEXT");
    this.migrateAddColumn("sessions", "is_sidebar", "INTEGER DEFAULT 0");
    this.migrateAddColumn("sessions", "parent_hapi_session_id", "TEXT");
    applyTurnsMigrations(this.db);
    // Epic #1662, Sub G (#1669): shadow-mode parity ledger (`parity_runs`).
    // Idempotent + fail-open; SCHEMA_VERSION stays 1 (D7).
    applyParityMigrations(this.db);
    // Epic #1662, Sub E (#1667): idempotent boot-time seed of `rate_cards` from
    // the shared MODEL_PRICING table (A creates the table empty). Guarded by an
    // existence check per (provider, model_id, effective_from); re-seeding never
    // duplicates. Fail-open. SCHEMA_VERSION stays 1 (D7).
    seedRateCards(this.db);

    // Issue #1269 (Sub-Issue E of Epic #1264): extension preferences table.
    // Core-owned (NOT auto-prefixed) — the SOLE authoritative enable store for
    // extensions. Migration-only (precedent: recent_paths, queued_messages);
    // runMigrations runs on fresh DBs too, so no createSchema entry is needed and
    // SCHEMA_VERSION stays 1. See server/src/store/extensionPrefsStore.ts.
    try {
      const hasExtensionPrefs = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extension_prefs'"
        )
        .get() as { name: string } | undefined;

      if (!hasExtensionPrefs) {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS extension_prefs (
            id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 1,
            config TEXT,
            updated_at INTEGER NOT NULL
          );
        `);
      }

      // Issue #1269 (R10, locked contract §7): seed Telegram enablement rows so the
      // introduction of extension_prefs does not silently disable Telegram for
      // installs that already opt in via `telegramBotToken`. Idempotent
      // (INSERT OR IGNORE) — never overwrites an explicit user choice, including a
      // stored `enabled = 0`. Guarded: getConfiguration() throws when a Store is
      // built without createConfiguration() having run (e.g. unit tests), so the
      // seed is skipped there rather than crashing the migration.
      try {
        if (getConfiguration().telegramBotToken) {
          const now = Date.now();
          const seedTelegram = this.db.prepare(
            "INSERT OR IGNORE INTO extension_prefs (id, enabled, config, updated_at) VALUES (?, 1, NULL, ?)"
          );
          seedTelegram.run("builtin.notifications-telegram", now);
          seedTelegram.run("builtin.telegram-miniapp", now);
        }
      } catch {
        // Configuration not initialized (Store constructed outside the normal
        // startup order, e.g. a unit test) — nothing to seed. Non-fatal by design.
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE extension_prefs:`,
        error
      );
    }

    this.runIssue1122Cleanup();
    this.runIssue1508Cleanup();
    this.runIssue1508OrphanCleanup();
    // Issue #1892 (Sub H2, R5/KD-2): one-way reinstatement of legacy `manual`
    // time-log overrides into the turns-derived read path. Runs AFTER the #1508
    // scrubs so it reads the corrected daily totals. Idempotent (actor guard +
    // marker); READ-ONLY over timelog_entries. See legacyManualRowMigration.ts.
    try {
      const result = runLegacyManualRowMigration({
        db: this.db,
        nodeId: "migration:1892",
        defaultTimezone:
          Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      });
      if (!result.skipped) {
        console.log(
          `[Store] Issue #1892 legacy manual-row migration: ` +
            `${result.bucketsMigrated} (namespace,date) bucket(s) set` +
            (result.reason ? ` (${result.reason})` : "")
        );
      }
    } catch (error) {
      console.error(
        "[Store] Migration failed: legacy manual-row migration #1892:",
        error
      );
    }
  }

  /**
   * Issue #1122: read-only audit of inflated `timelog_entries` rows.
   * Produces a structured report used by the cleanup migration to log
   * pre-mutation state.
   */
  private auditTimelogInflation(): {
    saturatedRows: number;
    consecutiveSessions: number;
    sample: Array<{
      sessionId: string;
      date: string;
      durationMs: number;
    }>;
  } {
    const cap = 24 * 60 * 60 * 1000;
    const threshold = cap - 60_000;

    const saturatedRow = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM timelog_entries WHERE duration_ms > ?"
      )
      .get(threshold) as { n: number };

    // Window query: for each (session_id) ordered by date, find rows
    // where the previous row's duration_ms is within 5% of this row's.
    // Count distinct session_ids that have at least one such pair.
    // Bun ships SQLite >= 3.25 so window functions are available.
    const consecutiveRow = this.db
      .prepare(
        "SELECT COUNT(DISTINCT session_id) AS n FROM (" +
          "SELECT session_id, duration_ms, " +
          "LAG(duration_ms) OVER (PARTITION BY session_id ORDER BY date) AS prev_ms " +
          "FROM timelog_entries" +
          ") WHERE prev_ms IS NOT NULL AND duration_ms > 0 " +
          "AND ABS(duration_ms - prev_ms) < 0.05 * duration_ms"
      )
      .get() as { n: number };

    const sampleRows = this.db
      .prepare(
        "SELECT session_id, date, duration_ms FROM timelog_entries " +
          "WHERE duration_ms > ? ORDER BY duration_ms DESC LIMIT 20"
      )
      .all(threshold) as Array<{
      session_id: string;
      date: string;
      duration_ms: number;
    }>;

    return {
      saturatedRows: saturatedRow.n,
      consecutiveSessions: consecutiveRow.n,
      sample: sampleRows.map(r => ({
        sessionId: r.session_id,
        date: r.date,
        durationMs: r.duration_ms,
      })),
    };
  }

  /**
   * Issue #1122: one-time backfill cleanup of inflated timelog_entries rows.
   * Caps any historical row (date < today_in_resolved_tz) where
   * duration_ms > 24h-60s at exactly 24h. Preserves originals in
   * `timelog_entries_backup_1122` for rollback. Idempotent via marker row.
   * Scope is historical-only as defense-in-depth against the upsertEntry
   * MAX(duration_ms) guard interaction.
   */
  private runIssue1122Cleanup(): void {
    try {
      const marker = this.db
        .prepare("SELECT key FROM _migration_markers WHERE key = ?")
        .get("timelog-backfill-1122-v1") as { key: string } | undefined;

      if (marker) return;

      const audit = this.auditTimelogInflation();
      console.log(
        `[Store] Issue #1122 audit: saturatedRows=${audit.saturatedRows} ` +
          `consecutiveSessions=${audit.consecutiveSessions} ` +
          `sample=${JSON.stringify(audit.sample)}`
      );

      const now = Date.now();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(now));

      const cap = 24 * 60 * 60 * 1000;
      const threshold = cap - 60_000;

      this.db.exec("BEGIN");
      try {
        // 1. Backup table — preserves original duration_ms keyed by id.
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS timelog_entries_backup_1122 (" +
            "id TEXT PRIMARY KEY, " +
            "original_duration_ms INTEGER NOT NULL, " +
            "modified_at INTEGER NOT NULL)"
        );

        // 2. Capture originals BEFORE mutation. INSERT OR IGNORE
        //    preserves the first-mutation truth if the cleanup is
        //    re-run after a partial failure (no double-write).
        this.db
          .prepare(
            "INSERT OR IGNORE INTO timelog_entries_backup_1122 " +
              "(id, original_duration_ms, modified_at) " +
              "SELECT id, duration_ms, ? FROM timelog_entries " +
              "WHERE duration_ms > ? AND date < ?"
          )
          .run(now, threshold, today);

        // 3. Cap inflated rows at 24h, tag with provenance.
        //    `timezone` is left unchanged (per issue body — the
        //    cleanup is timezone-agnostic).
        const updateResult = this.db
          .prepare(
            "UPDATE timelog_entries " +
              "SET duration_ms = ?, event_type = 'backfill', reset_epoch = ? " +
              "WHERE duration_ms > ? AND date < ?"
          )
          .run(cap, now, threshold, today);
        const rowsAffected = updateResult.changes;

        // 4. Marker — prevents re-execution. Joinable to mutated
        //    rows via reset_epoch === applied_at.
        this.db
          .prepare(
            "INSERT INTO _migration_markers " +
              "(key, applied_at, rows_affected, strategy, metadata) " +
              "VALUES (?, ?, ?, ?, ?)"
          )
          .run(
            "timelog-backfill-1122-v1",
            now,
            rowsAffected,
            "option1-cap",
            JSON.stringify({
              audit_saturated_rows: audit.saturatedRows,
              audit_consecutive_sessions: audit.consecutiveSessions,
              today_cutoff: today,
              timezone_used: tz,
            })
          );

        this.db.exec("COMMIT");
        console.log(
          `[Store] Issue #1122 cleanup complete: ${rowsAffected} rows capped at 24h`
        );
      } catch (txErr) {
        this.db.exec("ROLLBACK");
        throw txErr;
      }
    } catch (error) {
      console.error(
        `[Store] Migration failed: timelog backfill cleanup #1122:`,
        error
      );
    }
  }

  /**
   * Issue #1508: one-time historical scrub of inflated `timelog_entries`
   * rows that the #1122 cleanup could not touch (those are BELOW the 24h
   * cap — e.g. 9.68h, 15.28h). Caps any historical row (date < today_in_tz)
   * whose `duration_ms` exceeds its per-(session, date) message-span ceiling
   * — `MIN(24h, MAX(created_at) - MIN(created_at))` over that session's
   * messages on that date — which is an upper bound for thinking time
   * (thinking is a subset of the active conversation window). Preserves
   * originals in `timelog_entries_backup_1508`. Idempotent via marker row.
   * Historical-only scope. Rows whose session has no message data on that
   * date (NULL ceiling) are NEVER touched — a legitimate row can never be
   * zeroed.
   *
   * Prerequisite for EPIC #1662 Sub H2 (#1892): the inflated legacy rows are
   * outlier parity buckets that block the cutover gate; this scrub clears them.
   */
  private runIssue1508Cleanup(): void {
    try {
      const marker = this.db
        .prepare("SELECT key FROM _migration_markers WHERE key = ?")
        .get("timelog-backfill-1508-v1") as { key: string } | undefined;

      if (marker) return;

      const now = Date.now();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(now));

      const cap = 24 * 60 * 60 * 1000;

      // Candidate rows: historical rows whose duration exceeds the
      // message-span ceiling. The correlated subquery's HAVING yields a NULL
      // ceiling when the session has no messages on that date (or a zero-width
      // span), so such rows fall out of the JS filter below and are never
      // modified. Computing the candidate list in JS (rather than a correlated
      // UPDATE) guarantees the backup and the cap target the exact same rows
      // and the exact same ceiling values.
      type Candidate = {
        id: string;
        duration_ms: number;
        ceiling: number | null;
      };
      const candidates = (
        this.db
          .prepare(
            "SELECT te.id AS id, te.duration_ms AS duration_ms, (" +
              "SELECT MIN(?, MAX(m.created_at) - MIN(m.created_at)) " +
              "FROM messages m " +
              "WHERE m.session_id = te.session_id " +
              "AND date(m.created_at / 1000, 'unixepoch') = te.date " +
              "HAVING (MAX(m.created_at) - MIN(m.created_at)) > 0" +
              ") AS ceiling " +
              "FROM timelog_entries te WHERE te.date < ?"
          )
          .all(cap, today) as Candidate[]
      ).filter(
        (r): r is { id: string; duration_ms: number; ceiling: number } =>
          r.ceiling !== null && r.duration_ms > r.ceiling
      );

      console.log(
        "[Store] Issue #1508 scrub audit: candidates=" +
          candidates.length +
          " sample=" +
          JSON.stringify(
            candidates.slice(0, 20).map(c => ({
              id: c.id,
              from: c.duration_ms,
              to: c.ceiling,
            }))
          )
      );

      // Backup table — idempotent + additive, so it is safe to create outside
      // the transaction. Preserves original duration_ms keyed by id.
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS timelog_entries_backup_1508 (" +
            "id TEXT PRIMARY KEY, " +
            "original_duration_ms INTEGER NOT NULL, " +
            "modified_at INTEGER NOT NULL)"
        )
        .run();

      const backup = this.db.prepare(
        "INSERT OR IGNORE INTO timelog_entries_backup_1508 " +
          "(id, original_duration_ms, modified_at) VALUES (?, ?, ?)"
      );
      const update = this.db.prepare(
        "UPDATE timelog_entries " +
          "SET duration_ms = ?, event_type = 'backfill', reset_epoch = ? " +
          "WHERE id = ?"
      );
      const insertMarker = this.db.prepare(
        "INSERT INTO _migration_markers " +
          "(key, applied_at, rows_affected, strategy, metadata) " +
          "VALUES (?, ?, ?, ?, ?)"
      );

      // Transaction wrapper (auto-rollback on throw — mirrors the
      // `db.transaction()` pattern used by restoreFromBackup1122). Capture
      // originals BEFORE mutation; INSERT OR IGNORE preserves first-mutation
      // truth if the scrub is re-run after a partial failure (no double-write).
      let rowsAffected = 0;
      const txn = this.db.transaction(() => {
        for (const c of candidates) {
          backup.run(c.id, c.duration_ms, now);
          const result = update.run(c.ceiling, now, c.id);
          if (result.changes > 0) rowsAffected++;
        }
        // Marker — prevents re-execution. Joinable to mutated rows via
        // reset_epoch === applied_at.
        insertMarker.run(
          "timelog-backfill-1508-v1",
          now,
          rowsAffected,
          "option-message-span-cap",
          JSON.stringify({
            candidates: candidates.length,
            today_cutoff: today,
            timezone_used: tz,
          })
        );
      });
      txn();

      console.log(
        "[Store] Issue #1508 scrub complete: " +
          rowsAffected +
          " rows capped at message-span ceiling"
      );
    } catch (error) {
      console.error(
        "[Store] Migration failed: timelog historical scrub #1508:",
        error
      );
    }
  }

  /**
   * Issue #1508 (v2): one-time DELETE of *inflated orphan* `timelog_entries`
   * rows — rows with NO surviving `sessions` row whose `duration_ms` exceeds a
   * plausibility ceiling. These are the inflated buckets the v1 message-span
   * scrub (`runIssue1508Cleanup`) structurally CANNOT bound: `deleteSession`
   * cascade-deletes a session's `messages` (FK ON DELETE CASCADE) while leaving
   * its FK-less `timelog_entries` rows dangling, so the very messages that would
   * measure the row are gone. v1 derives its ceiling from the message span, so
   * an orphan row always yields a NULL ceiling and is skipped — which is exactly
   * the residue the hardened verifier (`scripts/verify-1508-scrub.ts` check #5)
   * flags as remaining inflation.
   *
   * Scope is deliberately narrow (Option A, narrowed — see the #1508 design
   * comment): only HISTORICAL (date < today), OVER-CEILING, ORPHANED, SYNTHETIC
   * timer artifacts (`event_type IN ('flush','midnight-reset')`). It never
   * touches a hand-entered `manual`/`session-end` row, never touches a row whose
   * session still exists, and preserves the large LEGITIMATE ≤-ceiling orphan
   * tail (real productivity history from auto-purged worktree sessions). Each
   * deleted row's FULL original is preserved in
   * `timelog_entries_orphan_backup_1508` for rollback via `restoreOrphans1508`.
   * Idempotent via the `timelog-orphan-cleanup-1508-v2` marker.
   *
   * No forward cascade is added: #1892 deletes `flushTimelogEntries`, freezing
   * the legacy table (no new writes → no new orphans); the forward fix is
   * #1670's turns-derived cutover, not a cascade on a retiring table.
   */
  private runIssue1508OrphanCleanup(): void {
    try {
      const marker = this.db
        .prepare("SELECT key FROM _migration_markers WHERE key = ?")
        .get("timelog-orphan-cleanup-1508-v2") as { key: string } | undefined;

      if (marker) return;

      const now = Date.now();
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const today = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(now));

      // Plausibility ceiling. MUST match scripts/verify-1508-scrub.ts
      // SUSPECT_DEFAULT_MS so the scrub clears exactly the rows that script
      // flags (and a post-scrub --verify reaches suspectCount: 0 by
      // construction). The 2h–6h orphan band (plausible single-session days) is
      // #1669/#1670/#1892 parity-threshold territory and is preserved here.
      const ceilingMs = 6 * 60 * 60 * 1000;

      // Candidate rows computed in JS BEFORE mutating (mirrors
      // runIssue1508Cleanup) so the backup and the DELETE target the identical
      // row set. Orphan-ness keys on session_id (a globally-unique PK), so
      // namespace never confounds it.
      type OrphanRow = {
        id: string;
        session_id: string;
        session_name: string;
        project_directory: string;
        date: string;
        duration_ms: number;
        created_at: number;
        namespace: string;
        event_type: string | null;
        timezone: string | null;
        reset_epoch: number | null;
      };
      const candidates = this.db
        .prepare(
          "SELECT te.id AS id, te.session_id AS session_id, " +
            "te.session_name AS session_name, " +
            "te.project_directory AS project_directory, te.date AS date, " +
            "te.duration_ms AS duration_ms, te.created_at AS created_at, " +
            "te.namespace AS namespace, te.event_type AS event_type, " +
            "te.timezone AS timezone, te.reset_epoch AS reset_epoch " +
            "FROM timelog_entries te " +
            "WHERE te.date < ? " +
            "AND te.duration_ms > ? " +
            "AND te.event_type IN ('flush', 'midnight-reset') " +
            "AND NOT EXISTS (" +
            "SELECT 1 FROM sessions s WHERE s.id = te.session_id" +
            ")"
        )
        .all(today, ceilingMs) as OrphanRow[];

      console.log(
        "[Store] Issue #1508 orphan cleanup audit: candidates=" +
          candidates.length +
          " sample=" +
          JSON.stringify(
            candidates.slice(0, 20).map(c => ({
              id: c.id,
              date: c.date,
              ms: c.duration_ms,
              ev: c.event_type,
            }))
          )
      );

      // Full-row backup table — idempotent + additive, safe to create outside
      // the transaction. Holds every column so a deleted row can be re-INSERTed
      // verbatim by restoreOrphans1508.
      this.db
        .prepare(
          "CREATE TABLE IF NOT EXISTS timelog_entries_orphan_backup_1508 (" +
            "id TEXT PRIMARY KEY, " +
            "session_id TEXT NOT NULL, " +
            "session_name TEXT NOT NULL, " +
            "project_directory TEXT NOT NULL, " +
            "date TEXT NOT NULL, " +
            "duration_ms INTEGER NOT NULL, " +
            "created_at INTEGER NOT NULL, " +
            "namespace TEXT NOT NULL, " +
            "event_type TEXT, " +
            "timezone TEXT, " +
            "reset_epoch INTEGER, " +
            "deleted_at INTEGER NOT NULL)"
        )
        .run();

      const backup = this.db.prepare(
        "INSERT OR IGNORE INTO timelog_entries_orphan_backup_1508 " +
          "(id, session_id, session_name, project_directory, date, " +
          "duration_ms, created_at, namespace, event_type, timezone, " +
          "reset_epoch, deleted_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const del = this.db.prepare("DELETE FROM timelog_entries WHERE id = ?");
      const insertMarker = this.db.prepare(
        "INSERT INTO _migration_markers " +
          "(key, applied_at, rows_affected, strategy, metadata) " +
          "VALUES (?, ?, ?, ?, ?)"
      );

      // Transaction wrapper (auto-rollback on throw). Backup-before-delete on
      // the identical row set; INSERT OR IGNORE preserves first-capture truth if
      // a prior partial run already backed a row up.
      let rowsAffected = 0;
      const txn = this.db.transaction(() => {
        for (const c of candidates) {
          backup.run(
            c.id,
            c.session_id,
            c.session_name,
            c.project_directory,
            c.date,
            c.duration_ms,
            c.created_at,
            c.namespace,
            c.event_type,
            c.timezone,
            c.reset_epoch,
            now
          );
          const result = del.run(c.id);
          if (result.changes > 0) rowsAffected++;
        }
        insertMarker.run(
          "timelog-orphan-cleanup-1508-v2",
          now,
          rowsAffected,
          "option-a-delete-inflated-orphans",
          JSON.stringify({
            candidates: candidates.length,
            today_cutoff: today,
            timezone_used: tz,
            ceiling_ms: ceilingMs,
          })
        );
      });
      txn();

      console.log(
        "[Store] Issue #1508 orphan cleanup complete: " +
          rowsAffected +
          " inflated orphan row(s) deleted " +
          "(originals preserved in timelog_entries_orphan_backup_1508)"
      );
    } catch (error) {
      console.error(
        "[Store] Migration failed: timelog orphan cleanup #1508 (v2):",
        error
      );
    }
  }

  /**
   * Add `sessions.last_operator_message_at` (#5254) and, only on the run that
   * adds it, seed every existing row with the migration time. That gives each
   * pre-existing session one 60-minute grace window after deploy instead of a
   * NULL that the ceiling guard would read as "no operator present". Rows
   * created later start NULL (no operator message has ever arrived).
   * Idempotent: a second boot finds the column and seeds nothing.
   */
  private migrateAddLastOperatorMessageAt(): void {
    try {
      const columns = this.db
        .prepare("PRAGMA table_info(sessions)")
        .all() as Array<{ name: string }>;
      const existed = columns.some(
        col => col.name === "last_operator_message_at"
      );
      this.migrateAddColumn("sessions", "last_operator_message_at", "INTEGER");
      if (existed) return;
      this.db
        .prepare(
          "UPDATE sessions SET last_operator_message_at = ? WHERE last_operator_message_at IS NULL"
        )
        .run(Date.now());
    } catch (error) {
      console.error(
        "[Store] Migration failed: sessions.last_operator_message_at (#5254):",
        error
      );
    }
  }

  private migrateAddColumn(table: string, column: string, type: string): void {
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
      const columns = this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      if (!columns.some(col => col.name === column)) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("duplicate column")) {
        // Expected on re-run — column was added between PRAGMA check and ALTER
        return;
      }
      console.error(
        `[Store] Migration failed: ALTER TABLE ${table} ADD COLUMN ${column} ${type}:`,
        error
      );
    }
  }

  private createSchema(): void {
    this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                tag TEXT,
                namespace TEXT NOT NULL DEFAULT 'default',
                machine_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                agent_state TEXT,
                agent_state_version INTEGER DEFAULT 1,
                todos TEXT,
                todos_updated_at INTEGER,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0,
                notes TEXT,
                persisted_view TEXT,
                prompt_draft TEXT,
                emoji TEXT,
                timer_data TEXT,
                linked_issue TEXT,
                resolved_model TEXT,
                context_window_tokens INTEGER,
                context_used_tokens INTEGER,
                context_percentage INTEGER,
                needs_review_override TEXT,
                auto_recover_from_api_error INTEGER,
                ui_collapse_state TEXT,
                parent_session_id TEXT,
                parent_relationship TEXT,
                branch_label TEXT,
                branch_created_at INTEGER,
                user_message_count INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                daemon_state TEXT,
                daemon_state_version INTEGER DEFAULT 1,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                local_id TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            CREATE INDEX IF NOT EXISTS idx_messages_session_role ON messages(session_id, json_extract(content, '$.role'));
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                platform_user_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                UNIQUE(platform, platform_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
            CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(namespace, endpoint)
            );
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);

            CREATE TABLE IF NOT EXISTS timelog_entries (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                session_name TEXT NOT NULL,
                project_directory TEXT NOT NULL,
                date TEXT NOT NULL,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                namespace TEXT NOT NULL,
                -- Issue #1120: provenance fields
                event_type TEXT DEFAULT 'flush' CHECK(event_type IN ('flush','midnight-reset','manual','session-end','backfill')),
                timezone TEXT,
                reset_epoch INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_timelog_date ON timelog_entries(date);
            CREATE INDEX IF NOT EXISTS idx_timelog_session ON timelog_entries(session_id);
            CREATE INDEX IF NOT EXISTS idx_timelog_namespace ON timelog_entries(namespace);
            CREATE INDEX IF NOT EXISTS idx_timelog_date_namespace ON timelog_entries(date, namespace);

            CREATE TABLE IF NOT EXISTS error_logs (
                id TEXT PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error','fatal')),
                category TEXT NOT NULL,
                source TEXT NOT NULL CHECK (source IN ('server','client','cli')),
                message TEXT NOT NULL,
                stack TEXT,
                session_id TEXT,
                namespace TEXT,
                context TEXT,
                user_agent TEXT,
                request_path TEXT,
                request_method TEXT,
                status_code INTEGER,
                original_timestamp INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_error_logs_timestamp ON error_logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_error_logs_severity ON error_logs(severity);
            CREATE INDEX IF NOT EXISTS idx_error_logs_category ON error_logs(category);
            CREATE INDEX IF NOT EXISTS idx_error_logs_session_id ON error_logs(session_id);
            CREATE INDEX IF NOT EXISTS idx_error_logs_source ON error_logs(source);
            CREATE INDEX IF NOT EXISTS idx_error_logs_severity_timestamp ON error_logs(severity, timestamp);

            CREATE TABLE IF NOT EXISTS midnight_reset_state (
                namespace TEXT PRIMARY KEY,
                timezone TEXT NOT NULL,
                last_reset_date TEXT NOT NULL,
                last_reset_epoch INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);
  }

  private getUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    return row?.user_version ?? 0;
  }

  private setUserVersion(version: number): void {
    this.db.exec(`PRAGMA user_version = ${version}`);
  }

  private hasAnyUserTables(): boolean {
    const row = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
      )
      .get() as { name?: string } | undefined;
    return Boolean(row?.name);
  }

  private assertRequiredTablesPresent(): void {
    const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
      )
      .all(...REQUIRED_TABLES) as Array<{ name: string }>;
    const existing = new Set(rows.map(row => row.name));
    const missing = REQUIRED_TABLES.filter(table => !existing.has(table));

    if (missing.length > 0) {
      throw new Error(
        `SQLite schema is missing required tables (${missing.join(", ")}). ` +
          "Back up and rebuild the database, or run an offline migration to the expected schema version."
      );
    }
  }

  walCheckpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  /**
   * Refresh SQLite planner statistics (`sqlite_stat1`/`sqlite_stat4`) via the
   * `optimize` pragma. Called at graceful shutdown and once per weekly
   * `walCheckpointLoop` tick (#2447). There is no `Store.close()`, so "before
   * close" is just before `process.exit(0)`; any ANALYZE writes land in the WAL
   * and are checkpointed on the next open — which is fine.
   */
  optimize(): void {
    this.db.exec("PRAGMA optimize");
  }

  /**
   * Backfill `sessions.user_message_count` from the `messages` table.
   *
   * Runs on every startup (#1032). On the first run after the migration this
   * performs one O(messages) scan to populate the counter; subsequent startups
   * short-circuit via a cheap pre-check (#1061) and return in O(1).
   *
   * The counter is maintained on insert by `MessageStore.addMessage` and is
   * monotonically non-decreasing, so the only realistic drift case is sessions
   * that pre-date the column migration (count stuck at 0 despite having user
   * messages). The pre-check below detects exactly that case.
   *
   * Safe to run repeatedly.
   */
  private backfillUserMessageCount(): void {
    try {
      // Fast path: short-circuit when no sessions need backfilling.
      const needsBackfill = this.db
        .prepare(
          `SELECT 1 FROM sessions s
           WHERE s.user_message_count = 0
             AND EXISTS (
               SELECT 1 FROM messages m
               WHERE m.session_id = s.id
                 AND json_extract(m.content, '$.role') = 'user'
             )
           LIMIT 1`
        )
        .get();
      if (!needsBackfill) return;

      this.db
        .prepare(
          `UPDATE sessions
           SET user_message_count = (
             SELECT COUNT(*) FROM messages
             WHERE messages.session_id = sessions.id
               AND json_extract(messages.content, '$.role') = 'user'
           )
           WHERE user_message_count != (
             SELECT COUNT(*) FROM messages
             WHERE messages.session_id = sessions.id
               AND json_extract(messages.content, '$.role') = 'user'
           )`
        )
        .run();
    } catch (error) {
      console.error(
        "[Store] Migration failed: backfill user_message_count:",
        error
      );
    }
  }

  private buildSchemaMismatchError(currentVersion: number): Error {
    const location =
      this.dbPath === ":memory:" || this.dbPath.startsWith("file::memory:")
        ? "in-memory database"
        : this.dbPath;
    return new Error(
      `SQLite schema version mismatch for ${location}. ` +
        `Expected ${SCHEMA_VERSION}, found ${currentVersion}. ` +
        "This build does not run compatibility migrations. " +
        "Back up and rebuild the database, or run an offline migration to the expected schema version."
    );
  }

  /**
   * Raw `bun:sqlite` Database handle (issue #1270, Sub-Issue F).
   *
   * B's `ServerExtensionHost` exposes `getRawDb()` for extension store classes;
   * F's loader wires that accessor to this method. Kept as an explicit accessor
   * (rather than making `db` public) so the raw handle is a deliberate,
   * greppable extension-support surface.
   */
  getRawDb(): Database {
    return this.db;
  }

  /**
   * Register an extension-contributed migration (issue #1266, Sub-Issue B).
   *
   * The migration is QUEUED, not executed — {@link runExtensionMigrations}
   * drains the queue. Kept separate from the core migration path so the
   * extension loader (Sub-Issue F) can guarantee core migrations run first.
   */
  registerExtensionMigration(fn: (db: Database) => void): void {
    this.extensionMigrations.push(fn);
  }

  /**
   * Run all queued extension migrations in registration order (issue #1266,
   * Sub-Issue B).
   *
   * Called EXPLICITLY by the extension loader (Sub-Issue F) AFTER the Store is
   * constructed and `initSchema()` has applied every core migration — never
   * auto-invoked here, which preserves the core-before-extension ordering
   * invariant. Each migration runs in its own try/catch so one extension's bad
   * migration is logged and skipped rather than aborting the whole chain
   * (failure isolation, R-sub-4). Extension authors are responsible for
   * idempotent migrations (`CREATE TABLE IF NOT EXISTS`).
   */
  runExtensionMigrations(): void {
    for (const migration of this.extensionMigrations) {
      try {
        migration(this.db);
      } catch (error) {
        console.error(
          "[Store] Extension migration failed (continuing to next):",
          error instanceof Error ? error.message : String(error)
        );
      }
    }
  }
}
