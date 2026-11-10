// SPDX-License-Identifier: AGPL-3.0-only
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { applyTelemetryMigrations } from "./telemetryMigrations";
import { TelemetryQueries, type DailyAggregate } from "./telemetryQueries";
import { TELEMETRY_EVENT_RETENTION_DAYS } from "./telemetryRetention";

// ── Types ──────────────────────────────────────────────────

// Issue #3742: `"capability"` widens the closed file_type vocabulary so the
// cataloged() middleware can persist capability-invocation events. The `event_type`
// union is NOT widened — `"invocation"` already fits. Mirrored in the fresh-DB
// CHECK in createSchema() and the table-rebuild migrateV2 in telemetryMigrations.ts.
export type TelemetryFileType = "skill" | "hook" | "agent" | "capability";
export type TelemetryEventType = "invocation" | "completion" | "skip" | "error";

export interface TelemetryEvent {
  id: string;
  filePath: string;
  fileType: TelemetryFileType;
  eventType: TelemetryEventType;
  sessionId: string | null;
  timestamp: number;
  durationMs: number | null;
  outcome: string | null;
  contextJson: string | null;
  /** #2154. Null means "not measured", never "measured zero" — see telemetryMigrations. */
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Spawn-time session role. Null until hapimatic-private#2155 sources one; the
   * writer must send NULL rather than substituting the post-hoc `classifySession`
   * archetype, which is a different thing derived from event counts.
   */
  sessionRole: string | null;
  repo: string | null;
}

export interface TelemetryEventInput {
  filePath: string;
  fileType: TelemetryFileType;
  eventType: TelemetryEventType;
  sessionId?: string;
  durationMs?: number;
  outcome?: string;
  context?: Record<string, unknown>;
  /**
   * #2154 attribution/measurement fields. All optional: hooks deploy independently
   * of the server, so an older writer that omits them must keep succeeding.
   */
  inputTokens?: number;
  outputTokens?: number;
  sessionRole?: string;
  repo?: string;
}

// Read-side types moved with the queries to `./telemetryQueries` (issue #6516);
// re-exported so existing importers keep importing them from here.
export type {
  AnomalyRecord,
  DailyAggregate,
  DurationStats,
  OutcomeRate,
  PeriodComparison,
  SessionAggregate,
  TelemetryFileInfo,
  TelemetrySummary,
  TelemetryTimeseriesBucket,
} from "./telemetryQueries";

/** One date whose today-refresh was skipped while the query worker was unusable (#6516 R12). */
export interface AggregateDebt {
  date: string;
  firstSkippedAt: number;
  skips: number;
}

// ── Constants ──────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

// ── TelemetryStore ─────────────────────────────────────────

export class TelemetryStore {
  private readonly db: Database;
  /**
   * The read queries over this main connection (issue #6516). The in-thread
   * executor runs them directly; the query worker builds its own
   * `TelemetryQueries` over a read-only connection.
   */
  readonly queries: TelemetryQueries;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:" && !dbPath.startsWith("file::memory:")) {
      const dir = dirname(dbPath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // Directory may already exist with correct permissions
      }

      if (!existsSync(dbPath)) {
        try {
          const fd = openSync(dbPath, "a", 0o600);
          closeSync(fd);
        } catch {
          // File creation may fail if dir permissions are wrong
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
    this.queries = new TelemetryQueries(this.db);

    this.createSchema();
    // Must follow createSchema(): `CREATE TABLE IF NOT EXISTS` cannot add columns
    // to an existing DB, so the ALTER path here is what reaches deployed databases
    // (issue #2154). Idempotent on fresh DBs — createSchema() already made the
    // columns, so each ALTER is guard-skipped and only the version stamp lands.
    applyTelemetryMigrations(this.db);
    this.pruneOldEvents(TELEMETRY_EVENT_RETENTION_DAYS);

    if (dbPath !== ":memory:" && !dbPath.startsWith("file::memory:")) {
      for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          chmodSync(path, 0o600);
        } catch {
          // WAL/SHM files may not exist yet
        }
      }
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL CHECK (file_type IN ('skill', 'hook', 'agent', 'capability')),
        event_type TEXT NOT NULL CHECK (event_type IN ('invocation', 'completion', 'skip', 'error')),
        session_id TEXT,
        timestamp INTEGER NOT NULL,
        duration_ms INTEGER,
        outcome TEXT,
        context_json TEXT,
        -- #2154: mirrored in telemetryMigrations.ts migrateV1. BOTH are required —
        -- this branch serves fresh DBs, the ALTER path serves existing ones.
        -- Nullable by contract: absent tokens must stay distinguishable from 0.
        input_tokens INTEGER,
        output_tokens INTEGER,
        session_role TEXT,
        repo TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_file_timestamp ON events(file_path, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_file_type ON events(file_type);
    `);

    // Separate exec — Bun SQLite can silently truncate multi-statement strings
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_aggregates (
        file_path TEXT NOT NULL,
        file_type TEXT NOT NULL,
        date TEXT NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0,
        invocation_count INTEGER NOT NULL DEFAULT 0,
        completion_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        skip_count INTEGER NOT NULL DEFAULT 0,
        duration_p50_ms REAL,
        duration_p95_ms REAL,
        duration_p99_ms REAL,
        duration_avg_ms REAL,
        duration_max_ms INTEGER,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        block_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (file_path, date)
      )
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_daily_agg_date ON daily_aggregates(date)"
    );
    // Issue #6516 R12: dates whose today-refresh was skipped while the query
    // worker was unusable. CREATE TABLE IF NOT EXISTS reaches existing
    // databases on the next boot; the old binary ignores the table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_aggregate_debt (
        date TEXT PRIMARY KEY,
        first_skipped_at INTEGER NOT NULL,
        skips INTEGER NOT NULL DEFAULT 1
      )
    `);
  }

  // ── Insert ─────────────────────────────────────────────

  insertEvent(input: TelemetryEventInput): TelemetryEvent {
    const now = Date.now();
    const id = randomUUID();
    const contextJson = input.context ? JSON.stringify(input.context) : null;

    this.db
      .prepare(
        `INSERT INTO events (id, file_path, file_type, event_type, session_id, timestamp, duration_ms, outcome, context_json, input_tokens, output_tokens, session_role, repo)
         VALUES (@id, @file_path, @file_type, @event_type, @session_id, @timestamp, @duration_ms, @outcome, @context_json, @input_tokens, @output_tokens, @session_role, @repo)`
      )
      .run({
        id,
        file_path: input.filePath,
        file_type: input.fileType,
        event_type: input.eventType,
        session_id: input.sessionId ?? null,
        timestamp: now,
        duration_ms: input.durationMs ?? null,
        outcome: input.outcome ?? null,
        context_json: contextJson,
        input_tokens: input.inputTokens ?? null,
        output_tokens: input.outputTokens ?? null,
        session_role: input.sessionRole ?? null,
        repo: input.repo ?? null,
      });

    return {
      id,
      filePath: input.filePath,
      fileType: input.fileType,
      eventType: input.eventType,
      sessionId: input.sessionId ?? null,
      timestamp: now,
      durationMs: input.durationMs ?? null,
      outcome: input.outcome ?? null,
      contextJson: contextJson,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      sessionRole: input.sessionRole ?? null,
      repo: input.repo ?? null,
    };
  }

  insertEvents(inputs: TelemetryEventInput[]): TelemetryEvent[] {
    const results: TelemetryEvent[] = [];
    const insertFn = this.db.transaction(() => {
      for (const input of inputs) {
        results.push(this.insertEvent(input));
      }
    });
    insertFn();
    return results;
  }

  // ── Queries (delegates to TelemetryQueries, issue #6516) ──

  getSummary(
    filters?: Parameters<TelemetryQueries["getSummary"]>[0]
  ): ReturnType<TelemetryQueries["getSummary"]> {
    return this.queries.getSummary(filters);
  }

  getTimeseries(
    params: Parameters<TelemetryQueries["getTimeseries"]>[0]
  ): ReturnType<TelemetryQueries["getTimeseries"]> {
    return this.queries.getTimeseries(params);
  }

  getFiles(fileType?: string): ReturnType<TelemetryQueries["getFiles"]> {
    return this.queries.getFiles(fileType);
  }

  getDurationStats(
    filters?: Parameters<TelemetryQueries["getDurationStats"]>[0]
  ): ReturnType<TelemetryQueries["getDurationStats"]> {
    return this.queries.getDurationStats(filters);
  }

  getOutcomeRates(
    filters?: Parameters<TelemetryQueries["getOutcomeRates"]>[0]
  ): ReturnType<TelemetryQueries["getOutcomeRates"]> {
    return this.queries.getOutcomeRates(filters);
  }

  getAnomalies(
    options?: Parameters<TelemetryQueries["getAnomalies"]>[0]
  ): ReturnType<TelemetryQueries["getAnomalies"]> {
    return this.queries.getAnomalies(options);
  }

  getComparison(
    period1Start: number,
    period1End: number,
    period2Start: number,
    period2End: number
  ): ReturnType<TelemetryQueries["getComparison"]> {
    return this.queries.getComparison(
      period1Start,
      period1End,
      period2Start,
      period2End
    );
  }

  getSessionAggregates(
    filters?: Parameters<TelemetryQueries["getSessionAggregates"]>[0]
  ): ReturnType<TelemetryQueries["getSessionAggregates"]> {
    return this.queries.getSessionAggregates(filters);
  }

  // ── Aggregation ─────────────────────────────────────────

  /**
   * Recompute daily_aggregates for a given date (YYYY-MM-DD).
   * If no date is given, aggregates the current day.
   *
   * In-thread: computes on this connection, then writes through
   * {@link replaceDayAggregates}. The query worker computes the same rows
   * off-thread and hands them to `replaceDayAggregates` (issue #6516).
   */
  aggregateDay(date?: string): void {
    const targetDate =
      date ?? new Date().toISOString().slice(0, 10); /* YYYY-MM-DD in UTC */
    this.replaceDayAggregates(
      targetDate,
      this.queries.computeDayAggregates(targetDate)
    );
  }

  /** Aggregate all days that have events but no aggregates yet. */
  aggregateMissing(): number {
    const days = this.queries.missingAggregateDays();
    for (const d of days) {
      this.aggregateDay(d);
    }
    return days.length;
  }

  /**
   * Replace one day's `daily_aggregates` rows atomically (issue #6516 R4): the
   * DELETE and every INSERT run in one `BEGIN IMMEDIATE` transaction on this
   * main connection, so a failure leaves the previous rows intact. Before
   * #6516 the DELETE autocommitted on its own and a failed insert left the day
   * empty. With `clearDebt`, the date's `daily_aggregate_debt` row is deleted in
   * the same transaction (R12's recovery pass).
   */
  replaceDayAggregates(
    date: string,
    rows: DailyAggregate[],
    options?: { clearDebt?: boolean }
  ): void {
    const insertStmt = this.db.prepare(
      `INSERT INTO daily_aggregates
       (file_path, file_type, date, total_count, invocation_count, completion_count,
        error_count, skip_count, duration_p50_ms, duration_p95_ms, duration_p99_ms,
        duration_avg_ms, duration_max_ms, success_count, failure_count, block_count)
       VALUES (@file_path, @file_type, @date, @total_count, @invocation_count,
        @completion_count, @error_count, @skip_count, @duration_p50_ms, @duration_p95_ms,
        @duration_p99_ms, @duration_avg_ms, @duration_max_ms, @success_count,
        @failure_count, @block_count)`
    );

    const txn = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM daily_aggregates WHERE date = @date")
        .run({ date });
      for (const row of rows) {
        if (row.date !== date) {
          throw new Error(
            `replaceDayAggregates(${date}): row for ${row.filePath} is dated ${row.date}`
          );
        }
        insertStmt.run({
          file_path: row.filePath,
          file_type: row.fileType,
          date,
          total_count: row.totalCount,
          invocation_count: row.invocationCount,
          completion_count: row.completionCount,
          error_count: row.errorCount,
          skip_count: row.skipCount,
          duration_p50_ms: row.durationP50Ms,
          duration_p95_ms: row.durationP95Ms,
          duration_p99_ms: row.durationP99Ms,
          duration_avg_ms: row.durationAvgMs,
          duration_max_ms: row.durationMaxMs,
          success_count: row.successCount,
          failure_count: row.failureCount,
          block_count: row.blockCount,
        });
      }
      if (options?.clearDebt) {
        this.db
          .prepare("DELETE FROM daily_aggregate_debt WHERE date = @date")
          .run({ date });
      }
    });
    txn.immediate();
  }

  // ── Aggregate debt (issue #6516 R12) ───────────────────

  /**
   * Record that `date`'s today-refresh was skipped (the query worker was
   * unusable). A short upsert on the main connection; the executor's recovery
   * pass recomputes the date and clears the row.
   */
  recordAggregateDebt(date: string): void {
    this.db
      .prepare(
        `INSERT INTO daily_aggregate_debt (date, first_skipped_at, skips)
         VALUES (@date, @now, 1)
         ON CONFLICT(date) DO UPDATE SET skips = skips + 1`
      )
      .run({ date, now: Date.now() });
  }

  /**
   * Delete the debt rows of `dates` WITHOUT touching their `daily_aggregates`.
   * The recovery pass uses it for dates past the event retention, whose events
   * are gone: recomputing them would replace their stored rows with fewer or
   * none (issue #6516 IR-1).
   */
  clearAggregateDebt(dates: readonly string[]): void {
    if (dates.length === 0) return;
    const del = this.db.prepare(
      "DELETE FROM daily_aggregate_debt WHERE date = @date"
    );
    this.db
      .transaction(() => {
        for (const date of dates) del.run({ date });
      })
      .immediate();
  }

  listAggregateDebt(): AggregateDebt[] {
    const rows = this.db
      .prepare(
        "SELECT date, first_skipped_at, skips FROM daily_aggregate_debt ORDER BY date"
      )
      .all() as Array<{
      date: string;
      first_skipped_at: number;
      skips: number;
    }>;
    return rows.map(r => ({
      date: r.date,
      firstSkippedAt: r.first_skipped_at,
      skips: r.skips,
    }));
  }

  /**
   * Distinct skill file paths invoked in a session (issue #3128 KD4 — the
   * scorecard run-ingestion join). A `kind:"run"` provenance fans out one
   * scorecard row per skill invoked in the session. Returns `[]` for a session
   * with no recorded skill events (e.g. a native run, or a deployment where
   * #1889 routes skill counts to `turn_events`) — the caller then records ONE
   * `skill: null` harness-level run row, never a guessed skill (KD4 fallback).
   */
  getSessionSkills(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT file_path FROM events
         WHERE session_id = @session_id AND file_type = 'skill'
         ORDER BY file_path`
      )
      .all({ session_id: sessionId }) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  // ── Maintenance ────────────────────────────────────────

  pruneOldEvents(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * MS_PER_DAY;
    const result = this.db
      .prepare("DELETE FROM events WHERE timestamp < @cutoff")
      .run({ cutoff });
    if (result.changes > 0) {
      console.log(
        `[TelemetryStore] Pruned ${result.changes} events older than ${maxAgeDays} days`
      );
    }
    return result.changes;
  }

  walCheckpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
}
