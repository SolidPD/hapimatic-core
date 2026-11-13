#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * billable-reconcile-v1 — the billable daily check, read-only (issue #6586).
 *
 *   bun run server/scripts/billable-reconcile-v1.ts
 *     [--db=PATH]          default: $DB_PATH, else $HAPI_HOME/hapi.db, else ~/.hapi/hapi.db
 *     [--since=EPOCH_MS]   examine stretch rows recorded and intervals closed after
 *                          this time, whatever earlier runs compared
 *     [--format=text|json] default: text
 *
 * Opens the database read-only and runs the stored comparisons of the daily check
 * (`timer`, `shadow`, `silence`) with no running server, then prints the switch
 * criterion and every open interval. It writes nothing, so a second run prints the
 * same period again. It works in any mode and under any deployed binary: the mode
 * is an environment value of the server unit and is not stored, and the tables
 * stay in place under `off`. Its `timer` section is each session's drift (stored
 * timer minus stored interval sum). It cannot print `memory` or `orphan_open`
 * rows, because those need the running server's state.
 *
 * Exit 0 after printing; 2 when the database is missing or has no
 * `thinking_intervals` table, or on a bad argument.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  computeBillableReconcile,
  evaluateBillableFlip,
  type ReconcileDetail,
} from "../src/billable/reconcile";

const SCRIPT = "billable-reconcile-v1";
const USAGE = `${SCRIPT}\nUsage: bun run server/scripts/billable-reconcile-v1.ts [--db=PATH] [--since=EPOCH_MS] [--format=text|json]`;
const TP1_LINE =
  "also required before a switch to on (ruling TP-1): the process-identity issue has landed (not checked by this script)";
const CARRIED_FORWARD_ID_LINE =
  "also required before a switch to on (ruling on review finding F3): the carried_forward id rule has landed (not checked by this script)";

interface Args {
  db: string | null;
  sinceMs: number | undefined;
  format: "text" | "json";
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: null,
    sinceMs: undefined,
    format: "text",
    help: false,
  };
  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a.startsWith("--db=")) {
      args.db = a.slice("--db=".length).replace(/^~/, homedir());
    } else if (a.startsWith("--since=")) {
      const raw = a.slice("--since=".length);
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--since must be epoch milliseconds, got: ${raw}`);
      }
      args.sinceMs = n;
    } else if (a.startsWith("--format=")) {
      const f = a.slice("--format=".length);
      if (f !== "text" && f !== "json") {
        throw new Error(`--format must be text or json, got: ${f}`);
      }
      args.format = f;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

function defaultDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH.replace(/^~/, homedir());
  const dataDir = process.env.HAPI_HOME
    ? process.env.HAPI_HOME.replace(/^~/, homedir())
    : join(homedir(), ".hapi");
  return join(dataDir, "hapi.db");
}

interface OpenRow {
  id: string;
  hapi_session_id: string;
  namespace: string;
  recorded_mode: string;
  started_at_ms: number;
  last_seen_at_ms: number;
}

function formatDetail(d: ReconcileDetail): string {
  const parts = [
    `session=${d.hapiSessionId ?? "-"}`,
    `namespace=${d.namespace ?? "-"}`,
  ];
  if (d.intervalId) parts.push(`interval=${d.intervalId}`);
  if (d.stretchStartedAtMs !== null)
    parts.push(`stretch=${d.stretchStartedAtMs}`);
  if (d.aMs !== null) parts.push(`a=${d.aMs}`);
  if (d.bMs !== null) parts.push(`b=${d.bMs}`);
  if (d.diffMs !== null) parts.push(`diff=${d.diffMs}`);
  if (d.detail) parts.push(JSON.stringify(d.detail));
  return `  ${parts.join(" ")}`;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const dbPath = args.db ?? defaultDbPath();
  if (args.format === "text") {
    console.log(SCRIPT);
    console.log(`database: ${dbPath}`);
  }
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    return 2;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thinking_intervals'"
      )
      .get();
    if (!table) {
      console.error(
        `No thinking_intervals table in ${dbPath}: this database predates billable intervals.`
      );
      return 2;
    }
    const nowMs = Date.now();
    const result = await computeBillableReconcile({
      db,
      nowMs,
      sections: ["timer", "shadow", "silence"],
      live: null,
      sinceMs: args.sinceMs,
    });
    const flip = evaluateBillableFlip(db, nowMs);
    const open = db
      .prepare(
        "SELECT id, hapi_session_id, namespace, recorded_mode, started_at_ms, last_seen_at_ms " +
          "FROM thinking_intervals WHERE ended_at_ms IS NULL ORDER BY started_at_ms, id"
      )
      .all() as OpenRow[];

    if (args.format === "json") {
      console.log(
        JSON.stringify(
          {
            script: SCRIPT,
            database: dbPath,
            nowMs,
            flip,
            tp1: TP1_LINE,
            carriedForwardIdRule: CARRIED_FORWARD_ID_LINE,
            run: result.run,
            details: result.details,
            open,
          },
          null,
          2
        )
      );
      return 0;
    }

    console.log(
      `flip criterion: ${flip.met ? "met" : "not met"}${
        flip.reasons.length > 0 ? ` (${flip.reasons.join("; ")})` : ""
      }`
    );
    console.log(TP1_LINE);
    console.log(CARRIED_FORWARD_ID_LINE);
    console.log(
      `sections: timer, shadow, silence (memory and orphan_open need the running server and are not printed)`
    );
    console.log(`run: ${JSON.stringify(result.run)}`);
    const byKind = new Map<string, ReconcileDetail[]>();
    for (const d of result.details) {
      const list = byKind.get(d.kind) ?? [];
      list.push(d);
      byKind.set(d.kind, list);
    }
    if (byKind.size === 0) {
      console.log("rows: none");
    }
    for (const [kind, rows] of [...byKind.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      console.log(`${kind} (${rows.length})`);
      for (const d of rows) console.log(formatDetail(d));
    }
    console.log(`open (ownership unknown) (${open.length})`);
    for (const r of open) {
      console.log(
        `  interval=${r.id} session=${r.hapi_session_id} namespace=${r.namespace} mode=${r.recorded_mode} started=${r.started_at_ms} lastSeen=${r.last_seen_at_ms}`
      );
    }
    return 0;
  } finally {
    db.close();
  }
}

process.exit(await main());
