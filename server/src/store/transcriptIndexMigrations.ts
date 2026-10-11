// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Versioned schema for `transcripts.db` (issue #3839) — the transcript-browser
 * FTS index. A SEPARATE database from `hapi.db` (precedent: `telemetry.db`,
 * `telemetryMigrations.ts`): the index is derived, rebuildable data, so it must
 * never grow or lock the primary store. Rollback = delete the file.
 *
 * House rules inherited from `telemetryMigrations.ts`:
 *   - **One DDL statement per `run()` call.** Bun's SQLite driver can silently
 *     truncate a multi-statement string, so every statement below is its own
 *     `run`.
 *   - **Stamp only after verifying.** `PRAGMA user_version` is written only once
 *     the expected table + columns are present, so a half-applied migration is
 *     retried on the next boot instead of being marked done.
 *   - **Never abort boot.** The index is observability-grade; a failure logs and
 *     the indexer degrades (the routes answer 503).
 *
 * FTS shape: an EXTERNAL-CONTENT FTS5 table over `transcripts.text` (the
 * scrubbed, extracted text runs). NOT contentless — `snippet()` returns NULL on
 * a contentless table (probed on the arm64 single-exe, 2026-09-23), and the
 * `LIKE` fallback needs the same column. Three triggers keep the FTS table in
 * lockstep with the content table (the FTS5-documented external-content idiom).
 * When the linked SQLite lacks `ENABLE_FTS5` the FTS objects are skipped and
 * search degrades to `LIKE` over `text`.
 *
 * v2 (#4060): the UPDATE trigger fires only when `text` actually changes
 * (`AFTER UPDATE OF text … WHEN old.text IS NOT new.text`). The v1 trigger fired
 * on ANY column, so every re-index — and every `relinkChain()` update of a
 * resume-chain member — FTS-deleted and re-inserted unchanged text. A v1 DB is
 * upgraded by dropping the old trigger so the `IF NOT EXISTS` DDL re-creates it.
 *
 * v3 (#4053): the indexed `text`/title/first prompt are scrubbed with the
 * broader transcript scrub. Upgrading zeroes every row's `mtime_ms` once, so
 * each row mismatches its file stat and the budgeted pass re-extracts it; the
 * text-guarded trigger then rewrites FTS only where the text changed.
 */

export const TRANSCRIPT_INDEX_SCHEMA_VERSION = 3;

/** Columns the `transcripts` content table must carry (verified before stamping). */
export const TRANSCRIPT_COLUMNS: ReadonlyArray<string> = [
  "cc_session_id",
  "path",
  "mtime_ms",
  "size_bytes",
  "namespace",
  "hapi_session_id",
  "has_session_row",
  "parent_cc_session_id",
  "first_uuid",
  "title",
  "cwd",
  "git_branch",
  "repo",
  "harness",
  "account",
  "linked_issue",
  "started_at_ms",
  "last_activity_ms",
  "message_count",
  "subagent_count",
  "first_prompt",
  "text",
  "indexed_at_ms",
];

const CONTENT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS transcripts (
  cc_session_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL,
  namespace TEXT,
  hapi_session_id TEXT,
  has_session_row INTEGER NOT NULL DEFAULT 0,
  parent_cc_session_id TEXT,
  first_uuid TEXT,
  title TEXT,
  cwd TEXT,
  git_branch TEXT,
  repo TEXT,
  harness TEXT NOT NULL DEFAULT 'claude',
  account TEXT,
  linked_issue INTEGER,
  started_at_ms INTEGER,
  last_activity_ms INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  subagent_count INTEGER NOT NULL DEFAULT 0,
  first_prompt TEXT,
  text TEXT NOT NULL DEFAULT '',
  indexed_at_ms INTEGER NOT NULL
)`;

const INDEX_DDL: ReadonlyArray<string> = [
  "CREATE INDEX IF NOT EXISTS idx_transcripts_last_activity ON transcripts(last_activity_ms)",
  "CREATE INDEX IF NOT EXISTS idx_transcripts_namespace ON transcripts(namespace)",
  "CREATE INDEX IF NOT EXISTS idx_transcripts_first_uuid ON transcripts(first_uuid)",
  "CREATE INDEX IF NOT EXISTS idx_transcripts_linked_issue ON transcripts(linked_issue)",
];

const FTS_DDL: ReadonlyArray<string> = [
  "CREATE VIRTUAL TABLE IF NOT EXISTS transcripts_fts USING fts5(text, content='transcripts', content_rowid='rowid', tokenize='unicode61')",
  "CREATE TRIGGER IF NOT EXISTS transcripts_ai AFTER INSERT ON transcripts BEGIN INSERT INTO transcripts_fts(rowid, text) VALUES (new.rowid, new.text); END",
  "CREATE TRIGGER IF NOT EXISTS transcripts_ad AFTER DELETE ON transcripts BEGIN INSERT INTO transcripts_fts(transcripts_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END",
  "CREATE TRIGGER IF NOT EXISTS transcripts_au AFTER UPDATE OF text ON transcripts WHEN old.text IS NOT new.text BEGIN INSERT INTO transcripts_fts(transcripts_fts, rowid, text) VALUES ('delete', old.rowid, old.text); INSERT INTO transcripts_fts(rowid, text) VALUES (new.rowid, new.text); END",
];

/**
 * True when the linked SQLite was compiled with FTS5. Checked via
 * `PRAGMA compile_options` (the documented probe) — never by attempting a
 * CREATE and catching, which would leave a half-created object behind.
 */
export function hasFts5(db: Database): boolean {
  try {
    const rows = db.prepare("PRAGMA compile_options").all() as Array<{
      compile_options: string;
    }>;
    return rows.some(r => r.compile_options === "ENABLE_FTS5");
  } catch {
    return false;
  }
}

function readUserVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as
    | { user_version?: number }
    | undefined;
  return row?.user_version ?? 0;
}

function columnNames(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map(r => r.name));
}

/** True when `transcripts_au` is the v2 text-guarded form (#4060). */
function updateTriggerIsTextGuarded(db: Database): boolean {
  const row = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'transcripts_au'"
    )
    .get() as { sql?: string } | undefined;
  return row?.sql?.includes("UPDATE OF text") ?? false;
}

/**
 * Create (or verify) the schema. Returns whether FTS5 is in use. Idempotent:
 * every statement is `IF NOT EXISTS`, so it is safe on every boot. `forceNoFts`
 * lets tests exercise the LIKE fallback on an FTS5-capable SQLite.
 */
export function applyTranscriptIndexMigrations(
  db: Database,
  opts: { forceNoFts?: boolean } = {}
): { fts5: boolean } {
  const fts5 = !opts.forceNoFts && hasFts5(db);
  // True only once the FTS objects exist (#4053): a migration that aborts
  // part-way must not report FTS5 search the database cannot run.
  let ftsReady = false;
  try {
    db.run(CONTENT_TABLE_DDL);
    for (const ddl of INDEX_DDL) db.run(ddl);
    if (fts5) {
      // v1 → v2 (#4060): drop the any-column update trigger so the loop below
      // re-creates it in its text-guarded form.
      if (readUserVersion(db) < 2)
        db.run("DROP TRIGGER IF EXISTS transcripts_au");
      for (const ddl of FTS_DDL) db.run(ddl);
      ftsReady = true;
    } else {
      console.warn(
        "[TranscriptIndex] FTS5 unavailable — search degrades to LIKE over the text column"
      );
    }

    if (readUserVersion(db) >= TRANSCRIPT_INDEX_SCHEMA_VERSION) {
      return { fts5 };
    }
    const present = columnNames(db, "transcripts");
    const missing = TRANSCRIPT_COLUMNS.filter(c => !present.has(c));
    if (missing.length > 0) {
      console.error(
        `[TranscriptIndex] Schema v${TRANSCRIPT_INDEX_SCHEMA_VERSION} incomplete — missing columns: ${missing.join(", ")}. Leaving user_version unstamped so the next boot retries.`
      );
      return { fts5 };
    }
    if (fts5 && !updateTriggerIsTextGuarded(db)) {
      console.error(
        `[TranscriptIndex] Schema v${TRANSCRIPT_INDEX_SCHEMA_VERSION} incomplete — transcripts_au is not the text-guarded trigger. Leaving user_version unstamped so the next boot retries.`
      );
      return { fts5 };
    }
    // v2 → v3 (#4053): force one re-extract under the broader scrub.
    if (readUserVersion(db) < 3) db.run("UPDATE transcripts SET mtime_ms = 0");
    db.run(`PRAGMA user_version = ${TRANSCRIPT_INDEX_SCHEMA_VERSION}`);
  } catch (error) {
    console.error("[TranscriptIndex] Migration aborted:", error);
    return { fts5: ftsReady };
  }
  return { fts5 };
}
