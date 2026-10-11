// SPDX-License-Identifier: AGPL-3.0-only
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { applyScorecardMigrations } from "./scorecardMigrations";

// ── Types ──────────────────────────────────────────────────
//
// The Harness Scorecard (issue #3128, epic #3117 Sub-Issue N). Aggregates
// per-(skill × harness × model) evidence from four sources so harness/model
// fitness decisions are data, not vibes. Modeled on `telemetryStore.ts` (#866) —
// `bun:sqlite`, `*Migrations.ts`, `aggregateMissing()` rollup, and the
// null-means-not-measured discipline (KD1).

/** The four evidence kinds a scorecard event can carry (directive Task 1). */
export type ScorecardEventKind =
  | "run"
  | "gate_violation"
  | "conformance"
  | "rating";

export interface ScorecardEvent {
  id: string;
  /**
   * Skill under test, or NULL for a harness-level event (gate violation,
   * harness-level conformance scenario, skill-less run). Rolls up as a
   * harness-level row, mirroring #3129's nullable-`skill` report rows (KD4,
   * ruling 1B-22i). NEVER a guessed skill.
   */
  skill: string | null;
  /** #3130 `runtime.harness.id` verbatim (CG-4), or `"unattributed"` (OR4). */
  harness: string;
  /** #3130 `model` verbatim; NULL for a harness-default / not-applicable run. */
  model: string | null;
  kind: ScorecardEventKind;
  /** Numeric payload: the rating (1–5) for `kind:"rating"`; NULL otherwise. */
  value: number | null;
  sessionId: string | null;
  timestamp: number;
  /** Raw source context (provenance manifest / webhook fields) for retro-attribution. */
  provenanceJson: string | null;
  // ── conformance-only columns (KD6b — the #3129 report row) ──
  /** Conformance scenario id (e.g. `skill-invocation`); NULL for non-conformance. */
  scenario: string | null;
  /** Conformance CLI version; NULL when not resolved (e.g. dry-run). */
  version: string | null;
  /** Conformance status `pass|fail|skip`; NULL for non-conformance. */
  status: string | null;
}

export interface ScorecardEventInput {
  skill?: string | null;
  harness: string;
  model?: string | null;
  kind: ScorecardEventKind;
  value?: number | null;
  sessionId?: string | null;
  /** Serialized to `provenanceJson`. */
  provenance?: Record<string, unknown>;
  scenario?: string | null;
  version?: string | null;
  status?: string | null;
}

/**
 * One per-(skill × harness × model) rollup row — the admin-view + export shape.
 * `conformanceRate` / `avgRating` are NULL when not measured (never 0), per the
 * null-means-not-measured discipline (OR4: a mis-keyed or absent measurement must
 * be visible, never silently zero).
 */
export interface ScorecardRow {
  skill: string | null;
  harness: string;
  model: string | null;
  runs: number;
  gateViolations: number;
  conformancePass: number;
  conformanceTotal: number;
  /** pass / (pass+fail); NULL when no conformance rows (skips excluded). */
  conformanceRate: number | null;
  ratingCount: number;
  /** mean of `kind:"rating"` values; NULL when unrated. */
  avgRating: number | null;
}

export interface ScorecardFilters {
  harness?: string;
  model?: string;
  skill?: string;
}

// ── Constants ──────────────────────────────────────────────

const RETENTION_DAYS = 180;
const MS_PER_DAY = 86_400_000;

// DDL kept as module constants (not inline template args) — the one-statement-
// per-call discipline plus the codebase's execFile-injection guard, which flags
// a backtick literal passed directly to `.exec(`.
const CREATE_EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    skill TEXT,
    harness TEXT NOT NULL,
    model TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('run', 'gate_violation', 'conformance', 'rating')),
    value REAL,
    session_id TEXT,
    timestamp INTEGER NOT NULL,
    provenance_json TEXT,
    scenario TEXT,
    version TEXT,
    status TEXT
  );
`;

const CREATE_AGGREGATES_TABLE = `
  CREATE TABLE IF NOT EXISTS scorecard_aggregates (
    skill TEXT,
    harness TEXT NOT NULL,
    model TEXT,
    runs INTEGER NOT NULL DEFAULT 0,
    gate_violations INTEGER NOT NULL DEFAULT 0,
    conformance_pass INTEGER NOT NULL DEFAULT 0,
    conformance_total INTEGER NOT NULL DEFAULT 0,
    rating_sum REAL NOT NULL DEFAULT 0,
    rating_count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`;

const INSERT_EVENT_SQL = `
  INSERT INTO events (id, skill, harness, model, kind, value, session_id, timestamp, provenance_json, scenario, version, status)
  VALUES (@id, @skill, @harness, @model, @kind, @value, @session_id, @timestamp, @provenance_json, @scenario, @version, @status)
`;

const REBUILD_AGGREGATES_SQL = `
  INSERT INTO scorecard_aggregates
    (skill, harness, model, runs, gate_violations, conformance_pass, conformance_total, rating_sum, rating_count, updated_at)
  SELECT
    skill,
    harness,
    model,
    SUM(CASE WHEN kind = 'run' THEN 1 ELSE 0 END),
    SUM(CASE WHEN kind = 'gate_violation' THEN 1 ELSE 0 END),
    SUM(CASE WHEN kind = 'conformance' AND status = 'pass' THEN 1 ELSE 0 END),
    SUM(CASE WHEN kind = 'conformance' AND status IN ('pass', 'fail') THEN 1 ELSE 0 END),
    COALESCE(SUM(CASE WHEN kind = 'rating' THEN value ELSE 0 END), 0),
    SUM(CASE WHEN kind = 'rating' AND value IS NOT NULL THEN 1 ELSE 0 END),
    @now
  FROM events
  GROUP BY skill, harness, model
`;

// ── ScorecardStore ─────────────────────────────────────────

export class ScorecardStore {
  private readonly db: Database;

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

    this.createSchema();
    // Follows createSchema(): `CREATE TABLE IF NOT EXISTS` cannot add columns to
    // an existing DB, so future column additions live in the migration ALTER
    // path. Idempotent on fresh DBs (columns already present → only the version
    // stamp lands). Own `PRAGMA user_version`, no collision with telemetry.db.
    applyScorecardMigrations(this.db);
    this.pruneOldEvents(RETENTION_DAYS);

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
    // `skill` is NULLABLE — harness-level events record `skill: null` and roll up
    // as a single harness-level row (SQLite GROUP BY folds NULLs together, unlike
    // a UNIQUE/PK constraint). `harness`/`model` carry #3130's id/model verbatim.
    this.db.exec(CREATE_EVENTS_TABLE);

    // Separate exec — Bun SQLite can silently truncate multi-statement strings.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_scorecard_key ON events(harness, model, skill)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_scorecard_kind ON events(kind)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_scorecard_timestamp ON events(timestamp)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_scorecard_session ON events(session_id)"
    );

    // Materialized rollup snapshot (rebuilt by aggregateMissing()). No PRIMARY
    // KEY: the rebuild DELETEs-then-INSERTs, and a nullable (skill, model) PK
    // would treat each NULL as distinct (SQLite) — the exact bug the GROUP-BY
    // rebuild avoids.
    this.db.exec(CREATE_AGGREGATES_TABLE);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_scorecard_agg_harness ON scorecard_aggregates(harness)"
    );
  }

  // ── Insert ─────────────────────────────────────────────

  recordEvent(input: ScorecardEventInput): ScorecardEvent {
    const now = Date.now();
    const id = randomUUID();
    const provenanceJson = input.provenance
      ? JSON.stringify(input.provenance)
      : null;

    this.db.prepare(INSERT_EVENT_SQL).run({
      id,
      skill: input.skill ?? null,
      harness: input.harness,
      model: input.model ?? null,
      kind: input.kind,
      value: input.value ?? null,
      session_id: input.sessionId ?? null,
      timestamp: now,
      provenance_json: provenanceJson,
      scenario: input.scenario ?? null,
      version: input.version ?? null,
      status: input.status ?? null,
    });

    return {
      id,
      skill: input.skill ?? null,
      harness: input.harness,
      model: input.model ?? null,
      kind: input.kind,
      value: input.value ?? null,
      sessionId: input.sessionId ?? null,
      timestamp: now,
      provenanceJson,
      scenario: input.scenario ?? null,
      version: input.version ?? null,
      status: input.status ?? null,
    };
  }

  /** Insert many events atomically (e.g. one conformance report's rows). */
  recordEvents(inputs: ScorecardEventInput[]): ScorecardEvent[] {
    const results: ScorecardEvent[] = [];
    const insertFn = this.db.transaction(() => {
      for (const input of inputs) {
        results.push(this.recordEvent(input));
      }
    });
    insertFn();
    return results;
  }

  // ── Aggregation ─────────────────────────────────────────

  /**
   * Rebuild the materialized `scorecard_aggregates` snapshot from `events`.
   * Named `aggregateMissing()` to match the telemetry registration wiring (the
   * index.ts backfill + WAL-checkpoint tick call it); scorecard volume is low, so
   * a full DELETE-then-INSERT rebuild is both cheap and always-correct (no
   * incremental-staleness bug). GROUP BY folds NULL skill/model into single
   * harness-level rows. Returns the number of rollup rows built.
   */
  aggregateMissing(): number {
    const now = Date.now();
    const rebuild = this.db.transaction(() => {
      this.db.exec("DELETE FROM scorecard_aggregates");
      this.db.prepare(REBUILD_AGGREGATES_SQL).run({ now });
    });
    rebuild();
    const row = this.db
      .prepare("SELECT COUNT(*) as c FROM scorecard_aggregates")
      .get() as { c: number };
    return row.c;
  }

  // ── Query: Scorecard rows ──────────────────────────────

  /**
   * The per-(skill × harness × model) rollup — the admin-view + export shape.
   * Reads the materialized snapshot; callers that need freshness call
   * {@link aggregateMissing} first (mirrors telemetry's aggregate-before-read).
   */
  getScorecard(filters?: ScorecardFilters): ScorecardRow[] {
    const conditions: string[] = [];
    const params: Record<string, string> = {};
    if (filters?.harness) {
      conditions.push("harness = @harness");
      params.harness = filters.harness;
    }
    if (filters?.model) {
      conditions.push("model = @model");
      params.model = filters.model;
    }
    if (filters?.skill) {
      conditions.push("skill = @skill");
      params.skill = filters.skill;
    }
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const rows = this.db
      .prepare(
        `SELECT skill, harness, model, runs, gate_violations,
                conformance_pass, conformance_total, rating_sum, rating_count
         FROM scorecard_aggregates ${where}
         ORDER BY harness ASC, model ASC, skill ASC`
      )
      .all(params) as Array<{
      skill: string | null;
      harness: string;
      model: string | null;
      runs: number;
      gate_violations: number;
      conformance_pass: number;
      conformance_total: number;
      rating_sum: number;
      rating_count: number;
    }>;

    return rows.map(r => ({
      skill: r.skill,
      harness: r.harness,
      model: r.model,
      runs: r.runs,
      gateViolations: r.gate_violations,
      conformancePass: r.conformance_pass,
      conformanceTotal: r.conformance_total,
      // null-means-not-measured: no conformance rows ⇒ null, never 0.
      conformanceRate:
        r.conformance_total > 0
          ? r.conformance_pass / r.conformance_total
          : null,
      ratingCount: r.rating_count,
      avgRating: r.rating_count > 0 ? r.rating_sum / r.rating_count : null,
    }));
  }

  // ── Maintenance ────────────────────────────────────────

  pruneOldEvents(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * MS_PER_DAY;
    const result = this.db
      .prepare("DELETE FROM events WHERE timestamp < @cutoff")
      .run({ cutoff });
    if (result.changes > 0) {
      console.log(
        `[ScorecardStore] Pruned ${result.changes} events older than ${maxAgeDays} days`
      );
    }
    return result.changes;
  }

  walCheckpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
}
