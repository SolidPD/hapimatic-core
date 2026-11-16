#!/usr/bin/env bun
/**
 * backfill-orphan-durations v2 — fill the duration of orphaned turns from their
 * transcripts (issues #2248, #6678).
 *
 * Fills `duration_ms` on `status='orphaned' AND duration_ms IS NULL` turns with
 * the live orphan sweep's lower bound (the transcript's largest timestamp at or
 * below the session's next-turn start) and records an `orphan_close` event, so
 * a backfilled row stays distinguishable as an estimate. Its inputs are rows
 * orphaned before #2248 and the live sweep's own hand-off: a turn whose bounded
 * tail read could not reach the watermark is left NULL for this exact read
 * (#6264).
 *
 * v2 (#6678):
 * - Each distinct transcript is streamed once, in bounded memory (v1 read every
 *   transcript whole, once per turn, and was killed on ms1).
 * - `--dry-run` opens the database read-only and reports the hours it would
 *   recover; it writes nothing.
 * - A turn whose transcript is missing is left NULL unless `--floor-missing`
 *   (v1 floored it to a permanent 0). An unreadable transcript is always left NULL.
 * - The script never migrates the schema: it runs this checkout's code against
 *   the database of whatever server is deployed. A missing column is an error.
 *
 * Usage (the `package.json` alias keeps the v1 name):
 *   bun run backfill-orphan-durations --dry-run                # report only, read-only
 *   bun run backfill-orphan-durations --dry-run --db=/path.db  # a specific DB file
 *   bun run backfill-orphan-durations                          # write the durations
 *   bun run backfill-orphan-durations --floor-missing          # also floor missing transcripts
 *   bun run backfill-orphan-durations --help
 *
 * The real run reads every transcript before it opens its one short write
 * transaction; WAL + busy_timeout tolerate the live server writing meanwhile.
 * Co-located with the single DB writer (mirrors `backfill-costs.ts`); the core
 * lives in `server/src/store/turns/backfillOrphanDurations.ts`.
 */

import { constants, Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  backfillOrphanDurations,
  type OrphanBackfillSummary,
} from "../src/store/turns/backfillOrphanDurations";

export const SCRIPT_VERSION = "v2";

/** Columns the backfill reads from `turns` (all in its original CREATE TABLE). */
const TURNS_READ_COLUMNS = [
  "id",
  "hapi_session_id",
  "seq",
  "status",
  "started_at_ms",
  "duration_ms",
  "node_id",
  "transcript_path",
  "cc_session_id",
  "cwd",
];
/** Columns a real run also writes. */
const TURNS_WRITE_COLUMNS = ["ended_at_ms"];
const TURN_EVENTS_COLUMNS = [
  "id",
  "turn_id",
  "node_id",
  "ts_ms",
  "kind",
  "name",
  "payload",
];

export interface BackfillArgs {
  dryRun: boolean;
  floorMissing: boolean;
  dbPath: string | null;
  help: boolean;
}

export type ParsedArgs =
  | { ok: true; args: BackfillArgs }
  | { ok: false; error: string };

export interface BackfillIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const CONSOLE_IO: BackfillIo = {
  log: line => console.log(line),
  error: line => console.error(line),
};

export function parseArgs(argv: string[]): ParsedArgs {
  const args: BackfillArgs = {
    dryRun: false,
    floorMissing: false,
    dbPath: null,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--floor-missing") args.floorMissing = true;
    else if (arg.startsWith("--db=")) {
      args.dbPath = arg.split("=").slice(1).join("=");
    } else return { ok: false, error: `Unknown argument: ${arg}` };
  }
  return { ok: true, args };
}

// Resolve the DB path the same way backfill-costs.ts / configuration.ts do.
function defaultDbPath(): string {
  if (process.env.DB_PATH) {
    return process.env.DB_PATH.replace(/^~/, homedir());
  }
  const dataDir = process.env.HAPI_HOME
    ? process.env.HAPI_HOME.replace(/^~/, homedir())
    : join(homedir(), ".hapi");
  return join(dataDir, "hapi.db");
}

const HELP = `
Usage: bun run backfill-orphan-durations [options]   (backfill-orphan-durations ${SCRIPT_VERSION})

Fills NULL duration_ms on orphaned turns with a lower-bound estimate (the
transcript's last timestamp before the session's next turn) and records an
orphan_close event. Reads each transcript once, in bounded memory. Idempotent;
never touches a turn whose duration is already set. Never migrates the schema.

Options:
  --dry-run        Open the database read-only, compute and report the counts
                   and the hours it would recover; write nothing
  --floor-missing  Also floor turns whose transcript is missing (or whose path
                   cannot be resolved) to duration 0. PERMANENT: the backfill
                   never revisits a floored turn. Without it they stay NULL, so
                   a transcript restored to a known path can still fill them.
                   A turn with no stored transcript_path is looked up under
                   $CLAUDE_CONFIG_DIR or ~/.claude of the shell running this.
  --db=PATH        Target a specific database file (default: $DB_PATH or
                   $HAPI_HOME/hapi.db or ~/.hapi/hapi.db)
  --help, -h       Show this help message

A transcript that exists but cannot be read is always left NULL and reported.
`;

/**
 * Open the database for the dry run without changing the database or its WAL.
 * A plain read-only connection to a WAL database creates the `-wal` and `-shm`
 * files when they are absent (a checkpointed copy at rest), so when they are,
 * open with SQLite's `immutable=1`, which reads the main file only and makes
 * no side file. When a `-wal` exists, a server (or a crash) may hold rows in
 * it, and `immutable` would not see them: open read-only through it instead.
 * That reads those rows and leaves the main file and the `-wal` byte-identical;
 * SQLite's reader bookkeeping creates or updates the `-shm` index.
 *
 * The path is resolved first, because SQLite keeps the `-wal` beside the real
 * file: through a symlinked `--db` the check would miss it and the immutable
 * open would silently skip the WAL's rows (#6678 review).
 *
 * `bun:sqlite` takes a `file:` URI only through the numeric open flags
 * (`SQLITE_OPEN_URI`); without `strict`, named parameters still bind by bare
 * name. Each path segment is percent-encoded, so `#`, `?` or `%` in a
 * directory name cannot end the path early.
 */
function openReadOnly(dbPath: string): Database {
  const real = realpathSync(dbPath);
  if (existsSync(`${real}-wal`)) {
    return new Database(real, { readonly: true, strict: true });
  }
  const path = real.split("/").map(encodeURIComponent).join("/");
  return new Database(
    `file:${path}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI
  );
}

/** The columns of `table`, or null when the table does not exist. */
function tableColumns(db: Database, table: string): Set<string> | null {
  const exists = db
    .prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?"
    )
    .get(table);
  if (!exists) return null;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return new Set(cols.map(c => c.name));
}

function hours(ms: number): string {
  return (ms / 3_600_000).toFixed(2);
}

function report(
  io: BackfillIo,
  s: OrphanBackfillSummary,
  args: BackfillArgs
): void {
  const mode = args.dryRun ? "(dry run) " : "";
  io.log(
    `Orphan-duration backfill ${mode}complete: scanned=${s.scanned} ` +
      `updated=${s.updated} from-transcript=${s.fromTranscript} ` +
      `floored=${s.floored}` +
      (args.floorMissing ? ` floored-missing=${s.flooredMissing}` : "")
  );
  io.log(
    `${args.dryRun ? "recoverable" : "recovered"}=${hours(s.recoveredMs)} h`
  );
  io.log(
    `transcripts read: ${s.transcriptFiles} files, ` +
      `${(s.transcriptBytes / 1e9).toFixed(2)} GB`
  );
  if (s.skippedMissing > 0) {
    io.log(
      `${s.skippedMissing} turns left NULL: transcript missing or path unknown ` +
        `(kept NULL: a restored transcript can still fill those with a known path; ` +
        `--floor-missing would floor them to 0 permanently)`
    );
  }
  if (s.skippedReadError > 0) {
    io.log(`${s.skippedReadError} turns left NULL: transcript unreadable`);
  }
  if (s.alreadyResolved > 0) {
    io.log(
      `${s.alreadyResolved} turns skipped: already resolved by another writer`
    );
  }
  if (s.boundChanged > 0) {
    io.log(
      `${s.boundChanged} turns left NULL: their session started a later turn ` +
        `during the run; run the backfill again to close them`
    );
  }
}

/** Run the CLI; returns the exit code (0 ok, 1 usage or no DB, 2 schema). */
export function runBackfill(
  argv: string[],
  io: BackfillIo = CONSOLE_IO
): number {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.error(parsed.error);
    io.error("Use --help for usage information");
    return 1;
  }
  const args = parsed.args;
  if (args.help) {
    io.log(HELP);
    return 0;
  }

  const dbPath = args.dbPath ?? defaultDbPath();
  io.log(
    `backfill-orphan-durations ${SCRIPT_VERSION} — ` +
      `${args.dryRun ? "dry run, read-only" : "REAL RUN"} — database ${dbPath}`
  );
  if (!existsSync(dbPath)) {
    io.error(`Database not found: ${dbPath}`);
    return 1;
  }

  const db = args.dryRun
    ? openReadOnly(dbPath)
    : new Database(dbPath, { strict: true });
  try {
    db.run("PRAGMA busy_timeout = 5000");

    const turns = tableColumns(db, "turns");
    if (turns === null) {
      io.log("no turns table: nothing to backfill");
      return 0;
    }
    const needTurns = args.dryRun
      ? TURNS_READ_COLUMNS
      : [...TURNS_READ_COLUMNS, ...TURNS_WRITE_COLUMNS];
    const missingTurns = needTurns.filter(c => !turns.has(c));
    if (missingTurns.length > 0) {
      io.error(
        `turns table is missing column(s): ${missingTurns.join(", ")}; ` +
          `this script does not migrate the schema`
      );
      return 2;
    }
    if (!args.dryRun) {
      const events = tableColumns(db, "turn_events");
      const missingEvents =
        events === null
          ? ["(table turn_events)"]
          : TURN_EVENTS_COLUMNS.filter(c => !events.has(c));
      if (missingEvents.length > 0) {
        io.error(
          `turn_events is missing: ${missingEvents.join(", ")}; ` +
            `this script does not migrate the schema`
        );
        return 2;
      }
      db.run("PRAGMA journal_mode = WAL");
    }

    const summary = backfillOrphanDurations(db, {
      dryRun: args.dryRun,
      floorMissing: args.floorMissing,
      onReadError: (path, error) =>
        io.error(
          `transcript unreadable, its turns left NULL: ${path}: ` +
            (error instanceof Error ? error.message : String(error))
        ),
    });
    report(io, summary, args);
    return 0;
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(runBackfill(process.argv.slice(2)));
}
