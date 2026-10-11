#!/usr/bin/env bun
/**
 * Backfill lower-bound durations for historical orphaned turns (issue #2248).
 *
 * Before #2248 the orphan sweep left `duration_ms` NULL, so every orphaned turn
 * (crash / server-restart mid-turn) was dropped from all time aggregation
 * (840/8,125 = 10.3% in the prod audit). This one-shot fills each historical
 * `status='orphaned' AND duration_ms IS NULL` row with the SAME lower-bound the
 * forward sweep now writes: the transcript's last-message timestamp (bounded by
 * the session's next-turn start), else the `started_at_ms` floor when the
 * transcript is gone. It records an `orphan_close` provenance turn_event so a
 * backfilled row stays distinguishable as an estimate.
 *
 * Idempotent (only touches NULL-duration orphans) and best-effort (a pruned
 * transcript floors to duration 0; the row stays `status='orphaned'`,
 * re-derivable later). Alternatives considered — a `_migration_markers`-guarded
 * boot migration (adds transcript I/O to every boot) and leave-as-is (leaves the
 * 840 rows permanently under-counted) — were rejected in favor of this explicit,
 * re-runnable one-shot (see the issue's directive D4).
 *
 * Co-located with the single DB writer (mirrors `backfill-costs.ts`). The
 * reusable core lives in `server/src/store/turns/backfillOrphanDurations.ts` so
 * it is unit-testable without spawning.
 *
 * Usage:
 *   bun run backfill-orphan-durations                # backfill the default DB
 *   bun run backfill-orphan-durations --dry-run      # report what would change
 *   bun run backfill-orphan-durations --db=/path.db  # target a specific DB file
 *   bun run backfill-orphan-durations --help
 *
 * WAL + busy_timeout tolerate brief contention with the daemon writer; prefer
 * running when the node is idle (disjoint NULL-duration rows; idempotent).
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { applyTurnsMigrations } from "../src/store/turns/schema";
import { backfillOrphanDurations } from "../src/store/turns/backfillOrphanDurations";

interface Args {
  dryRun: boolean;
  dbPath: string | null;
  help: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let dryRun = false;
  let dbPath: string | null = null;
  let help = false;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--db=")) {
      dbPath = arg.split("=").slice(1).join("=");
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error("Use --help for usage information");
      process.exit(1);
    }
  }

  return { dryRun, dbPath, help };
}

// Resolve the DB path the same way backfill-costs.ts / configuration.ts do.
function getDbPath(): string {
  if (process.env.DB_PATH) {
    return process.env.DB_PATH.replace(/^~/, homedir());
  }
  const dataDir = process.env.HAPI_HOME
    ? process.env.HAPI_HOME.replace(/^~/, homedir())
    : join(homedir(), ".hapi");
  return join(dataDir, "hapi.db");
}

function main(): void {
  const { dryRun, dbPath: dbOverride, help } = parseArgs();

  if (help) {
    console.log(`
Usage: bun run backfill-orphan-durations [options]

Fills NULL duration_ms on historical orphaned turns with a lower-bound estimate
(transcript last-message watermark, else the started_at_ms floor). Records an
orphan_close provenance event. Idempotent; never touches non-NULL durations.

Options:
  --dry-run        Compute + report counts, but write nothing
  --db=PATH        Target a specific database file (default: $DB_PATH or
                   $HAPI_HOME/hapi.db or ~/.hapi/hapi.db)
  --help, -h       Show this help message
`);
    process.exit(0);
  }

  const dbPath = dbOverride ?? getDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  console.log(`Database: ${dbPath}${dryRun ? " (dry run)" : ""}`);

  const db = new Database(dbPath, { strict: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");

  try {
    // Idempotent: ensure the turns schema exists before scanning.
    applyTurnsMigrations(db);

    const summary = backfillOrphanDurations(db, { dryRun });
    console.log(
      `Orphan-duration backfill ${dryRun ? "(dry run) " : ""}complete: ` +
        `scanned=${summary.scanned} updated=${summary.updated} ` +
        `from-transcript=${summary.fromTranscript} floored=${summary.floored}`
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main();
}
