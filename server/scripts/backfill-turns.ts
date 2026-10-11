#!/usr/bin/env bun
/**
 * Backfill & repair the per-turn telemetry DB from on-disk transcripts (issue #1668,
 * epic #1662, Sub F — the disaster-recovery tool).
 *
 * Two modes:
 *   --repair  (default)  Re-derive ONLY the parser column group + parser events for
 *                        EXISTING turn rows (after a parser fix). Daemon-enriched,
 *                        cost, and lifecycle columns are left byte-unchanged. Low-risk;
 *                        tolerates WAL contention with a live daemon.
 *   --rebuild            (Re)construct a session's turns from its transcript + the
 *                        daemon's `sessions` record, upserting on (hapi_session_id, seq).
 *                        For a FULL rebuild, run with the daemon STOPPED (single writer).
 *
 * NODE-LOCAL by architecture (R5): runs against THIS node's hapi.db + THIS node's
 * transcripts. Account-isolated sessions resolve their transcript under the account
 * config dir via metadata.accountUuid (R6). Missing/purged transcripts degrade to a
 * reported-unparseable tally, never abort (R7). Cost columns are NOT recomputed unless
 * --reprice (R8). NEVER writes `timelog_adjustments` (R11).
 *
 * Co-located with the single DB writer (mirrors `cleanup-sessions.ts` + `backfill-costs.ts`).
 * The reusable core lives in `server/src/store/turns/backfillTurns.ts` (unit-testable).
 *
 * Usage:
 *   bun run backfill-turns                         # repair all rows in the default DB
 *   bun run backfill-turns --dry-run               # report, write nothing
 *   bun run backfill-turns --session=<hapiId>      # scope to one session
 *   bun run backfill-turns --since=2026-06-01      # scope by turn start time
 *   bun run backfill-turns --reprice               # also re-derive NULL cost columns (E)
 *   bun run backfill-turns --rebuild --session=<hapiId>           # rebuild a session
 *   bun run backfill-turns --rebuild --session=<id> --transcript=/path.jsonl
 *   bun run backfill-turns --db=/path.db
 *   bun run backfill-turns --help
 *
 * WAL + busy_timeout tolerate brief contention; prefer running --rebuild daemon-stopped.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { applyTurnsMigrations } from "../src/store/turns/schema";
import { seedRateCards } from "../src/store/turns/rateCards";
import {
  repairTurns,
  rebuildSession,
  type ConfigDirResolver,
} from "../src/store/turns/backfillTurns";

interface Args {
  mode: "repair" | "rebuild";
  dryRun: boolean;
  dbPath: string | null;
  sessionId: string | null;
  sinceMs: number | null;
  untilMs: number | null;
  transcript: string | null;
  reprice: boolean;
  help: boolean;
}

function parseDateMs(value: string): number | null {
  // Accept a bare ms epoch or an ISO-ish date string.
  if (/^[0-9]+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    mode: "repair",
    dryRun: false,
    dbPath: null,
    sessionId: null,
    sinceMs: null,
    untilMs: null,
    transcript: null,
    reprice: false,
    help: false,
  };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--repair") args.mode = "repair";
    else if (arg === "--rebuild") args.mode = "rebuild";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--reprice") args.reprice = true;
    else if (arg.startsWith("--db=")) args.dbPath = arg.slice("--db=".length);
    else if (arg.startsWith("--session="))
      args.sessionId = arg.slice("--session=".length);
    else if (arg.startsWith("--transcript="))
      args.transcript = arg.slice("--transcript=".length);
    else if (arg.startsWith("--since=")) {
      const ms = parseDateMs(arg.slice("--since=".length));
      if (ms === null) {
        console.error(`Invalid --since value: ${arg}`);
        process.exit(1);
      }
      args.sinceMs = ms;
    } else if (arg.startsWith("--until=")) {
      const ms = parseDateMs(arg.slice("--until=".length));
      if (ms === null) {
        console.error(`Invalid --until value: ${arg}`);
        process.exit(1);
      }
      args.untilMs = ms;
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Use --help for usage information");
      process.exit(1);
    }
  }
  return args;
}

// Resolve the DB path the same way cleanup-sessions.ts / backfill-costs.ts do.
function getDbPath(): string {
  if (process.env.DB_PATH) {
    return process.env.DB_PATH.replace(/^~/, homedir());
  }
  const dataDir = process.env.HAPI_HOME
    ? process.env.HAPI_HOME.replace(/^~/, homedir())
    : join(homedir(), ".hapi");
  return join(dataDir, "hapi.db");
}

// Account-isolated transcript dir resolver (#1573, R6): an account-bound session writes
// its transcript under <HAPI_HOME>/account-configs/<accountUuid>; host-credential
// sessions (no accountUuid) fall back to ~/.claude via resolveTranscriptPaths' default.
function makeGetConfigDir(): ConfigDirResolver {
  const home = homedir();
  const dataDir = process.env.HAPI_HOME
    ? process.env.HAPI_HOME.replace(/^~/, home)
    : join(home, ".hapi");
  return accountUuid =>
    accountUuid ? join(dataDir, "account-configs", accountUuid) : undefined;
}

function printHelp(): void {
  console.log(`
Usage: bun run backfill-turns [options]

Re-derive or rebuild per-turn telemetry rows from on-disk transcripts.

Modes:
  --repair             (default) Re-derive parser columns + parser events for existing
                       rows in place (force-overwrite). Daemon/cost/lifecycle untouched.
  --rebuild            Rebuild a session's turns from its transcript + sessions record
                       (upsert on (hapi_session_id, seq)). Run daemon-STOPPED for a full
                       rebuild. Requires --session; resolves the transcript from a
                       surviving row's transcript_path or an explicit --transcript=PATH.

Options:
  --dry-run            Compute + report counts, write nothing
  --session=<hapiId>   Scope to a single hapi session
  --since=<iso|ms>     Only turns started at/after this time (repair scoping)
  --until=<iso|ms>     Only turns started at/before this time (repair scoping)
  --transcript=PATH    (rebuild) explicit transcript path when no row survives
  --reprice            Also fill NULL cost columns via the rate-card backfill (Sub E)
  --db=PATH            Target DB (default: $DB_PATH or $HAPI_HOME/hapi.db or ~/.hapi/hapi.db)
  --help, -h           Show this help
`);
}

function main(): void {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const dbPath = args.dbPath ?? getDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }
  console.log(
    `Database: ${dbPath}${args.dryRun ? " (dry run)" : ""} — mode: ${args.mode}`
  );

  const db = new Database(dbPath, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");

  try {
    // Idempotent: ensure the turns schema + rate-card seed exist before operating.
    applyTurnsMigrations(db);
    seedRateCards(db);

    const getConfigDir = makeGetConfigDir();
    const common = {
      dryRun: args.dryRun,
      sessionId: args.sessionId ?? undefined,
      sinceMs: args.sinceMs ?? undefined,
      untilMs: args.untilMs ?? undefined,
      reprice: args.reprice,
    };

    if (args.mode === "repair") {
      const s = repairTurns(db, { getConfigDir }, common);
      console.log(
        `Repair ${args.dryRun ? "(dry run) " : ""}complete: ` +
          `scanned=${s.scanned} repaired=${s.repaired} skipped=${s.skipped} ` +
          `unparseable=${s.unparseable}` +
          (s.reprice
            ? ` | reprice: priced=${s.reprice.priced} still-unknown=${s.reprice.stillUnknown}`
            : "")
      );
    } else {
      if (!args.sessionId) {
        console.error("--rebuild requires --session=<hapiSessionId>");
        process.exit(1);
      }
      // Resolve the transcript: explicit override, else a surviving row's path.
      let transcriptPath = args.transcript;
      if (!transcriptPath) {
        const row = db
          .prepare(
            `SELECT transcript_path FROM turns
              WHERE hapi_session_id = ? AND transcript_path IS NOT NULL
              LIMIT 1`
          )
          .get(args.sessionId) as { transcript_path: string } | undefined;
        transcriptPath = row?.transcript_path ?? null;
      }
      if (!transcriptPath) {
        console.error(
          `Cannot resolve a transcript for session ${args.sessionId}: no surviving ` +
            `row carries a transcript_path and no --transcript=PATH was given.\n` +
            `Pass --transcript=<path/to/ccSessionId.jsonl> (see the recovery runbook).`
        );
        process.exit(1);
      }
      const s = rebuildSession(
        db,
        { hapiSessionId: args.sessionId, transcriptPath, getConfigDir },
        common
      );
      console.log(
        `Rebuild ${args.dryRun ? "(dry run) " : ""}complete: ` +
          `sessions=${s.sessionsScanned} upserted=${s.upserted} ` +
          `unparseable=${s.unparseable}` +
          (s.reprice
            ? ` | reprice: priced=${s.reprice.priced} still-unknown=${s.reprice.stillUnknown}`
            : "")
      );
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main();
}
