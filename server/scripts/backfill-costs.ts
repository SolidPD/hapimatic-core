#!/usr/bin/env bun
/**
 * Backfill per-turn cost columns for turns recorded before a rate card existed
 * (issue #1667, epic #1662, Sub E).
 *
 * Fills `cost_in/out/cache_read/cache_write/cost_total/rate_card_id` for turns
 * where `cost_total IS NULL` and a rate card now resolves, pricing each turn
 * against ITS OWN `started_at_ms`. NEVER overwrites a non-NULL cost (history is
 * never silently recomputed). Rows whose model has no card stay NULL.
 *
 * Co-located with the single DB writer (mirrors `cleanup-sessions.ts` +
 * `clean-session`). The reusable backfill core lives in
 * `server/src/store/turns/backfill.ts` so it is unit-testable without spawning.
 *
 * Usage:
 *   bun run backfill-costs                # backfill the default DB
 *   bun run backfill-costs --dry-run      # report what would change, write nothing
 *   bun run backfill-costs --db=/path.db  # target a specific DB file
 *   bun run backfill-costs --help
 *
 * WAL + busy_timeout tolerate brief contention with the daemon writer; prefer
 * running when the node is idle (disjoint NULL-cost rows; idempotent).
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { applyTurnsMigrations } from "../src/store/turns/schema";
import { seedRateCards } from "../src/store/turns/rateCards";
import { backfillCosts } from "../src/store/turns/backfill";

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

// Resolve the DB path the same way cleanup-sessions.ts / configuration.ts do.
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
Usage: bun run backfill-costs [options]

Fills NULL cost columns on turns where a rate card now resolves, pricing each
turn against its own started_at_ms. Never overwrites a non-NULL cost.

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
    // Idempotent: ensure the turns schema + rate-card seed exist before pricing.
    applyTurnsMigrations(db);
    seedRateCards(db);

    const summary = backfillCosts(db, { dryRun });
    console.log(
      `Backfill ${dryRun ? "(dry run) " : ""}complete: ` +
        `scanned=${summary.scanned} priced=${summary.priced} ` +
        `still-unknown=${summary.stillUnknown}`
    );
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main();
}
