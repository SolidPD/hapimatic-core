#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * billable-reconcile-v4 — the billable daily check, read-only (issue #6586).
 *
 *   bun run server/scripts/billable-reconcile-v4.ts
 *     [--db=PATH]          default: $DB_PATH, else $HAPI_HOME/hapi.db, else ~/.hapi/hapi.db
 *     [--since=EPOCH_MS]   examine stretch rows recorded and intervals closed after
 *                          this time, whatever earlier runs compared; interval groups
 *                          with no old-clock row are read from the later of this time
 *                          and now minus 90 days (the daily run deletes stretch rows
 *                          after 90 days, so an older group would read as having none);
 *                          a group that ends on a wait or a rollover is read from 24
 *                          hours before this time, at its 24-hour mark. `--since` does not
 *                          move the `writes` and `balance` comparison, which is always
 *                          against the latest run row that holds its figures; losses that
 *                          earlier checks listed are in their stored detail rows (F-2)
 *     [--format=text|json] default: text
 *
 * Opens the database read-only and runs the stored comparisons of the daily check
 * (`timer`, `shadow`, `silence`, the stored totals of `writes`, and `balance`) with
 * no running server, then prints the switch criterion and every open interval.
 * The criterion includes condition 3 (#6651), read from the latest stored run
 * row. It writes nothing, so a second run prints the
 * same period again. It works in any mode and under any deployed binary: the mode
 * is an environment value of the server unit and is not stored, and the tables
 * stay in place under `off`. Its `timer` section is each session's drift (stored
 * timer minus stored interval sum). It cannot print `memory` or `orphan_open`
 * rows, because those need the running server's state. For the same reason it
 * cannot print `write_lag` or a lost-write count that is still pending. Without
 * the running server it cannot tell a stretch the old clock is still running, so
 * a healthy wait of more than 24 hours prints as `no_legacy`; and it takes each
 * group's restart evidence from the first stored run whose period reached that
 * group's 24-hour mark, so its answer for a group is the one the daily check gave
 * or would have given. A wait-ended group whose mark only an older build's run
 * passed is printed as `unverified`: neither explained nor listed.
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
  countRunsOf6670,
  evaluateBillableFlip,
  isRunOf6670,
  type ReconcileDetail,
} from "../src/billable/reconcile";

const SCRIPT = "billable-reconcile-v4";
const USAGE = [
  SCRIPT,
  `Usage: bun run server/scripts/${SCRIPT}.ts [--db=PATH] [--since=EPOCH_MS] [--format=text|json]`,
  "  --db=PATH           default: $DB_PATH, else $HAPI_HOME/hapi.db, else ~/.hapi/hapi.db",
  "  --since=EPOCH_MS    examine stretch rows recorded and intervals closed after this time,",
  "                      whatever earlier runs compared; interval groups with no old-clock row",
  "                      are read from the later of this time and now minus 90 days; a group",
  "                      that ends on a wait or a rollover is read from 24 hours before this time.",
  "                      --since does not move the writes and balance comparison, which is always",
  "                      against the latest run row that holds its figures; losses that earlier",
  "                      checks listed are in their stored detail rows",
  "  --format=text|json  default: text",
].join("\n");
// #6647 (Task 15a): ruling TP-1 as rulings COND-1 and COND-WIDE word it, all
// three parts in one line. The JSON key stays `tp1`.
const TP1_LINE =
  "also required before a switch to on (ruling TP-1, as worded by COND-1 and COND-WIDE), all three for this node: the process-identity issue #6647 has landed (both of its pull requests merged); this node runs HAPI_RUNNER_IDENTITY=enforce; and its GET /cli/runner-identity route, read at least two minutes after a server start, lists no unidentified live runner node-wide (not checked by this script, which checks none of the three)";
const CARRIED_FORWARD_ID_LINE =
  "also required before a switch to on (ruling on review finding F3): the carried_forward id rule of issue #6651 is in the release this node runs (checked: the latest stored daily check states the rule; see the line below for its stored value)";

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
      sections: ["timer", "shadow", "silence", "writes", "balance"],
      live: null,
      sinceMs: args.sinceMs,
    });
    const flip = evaluateBillableFlip(db, nowMs);
    // Conditions 3 (#6651) and 4 (ruling M9), read by this script from the
    // latest run row, the one evaluateBillableFlip reads.
    const latestRun = db
      .prepare(
        "SELECT run_at_ms, detail_json FROM billable_reconcile WHERE row_type = 'run' ORDER BY run_at_ms DESC, rowid DESC LIMIT 1"
      )
      .get() as { run_at_ms: number; detail_json: string | null } | null;
    let latestDetail: Record<string, unknown> | null = null;
    try {
      latestDetail = latestRun?.detail_json
        ? (JSON.parse(latestRun.detail_json) as Record<string, unknown>)
        : null;
    } catch {
      latestDetail = null;
    }
    // The stored value, not this checkout's constant: the node's own record.
    const storedRule = latestDetail?.carriedForwardIdRule;
    const carriedForwardIdRuleStored = {
      runAtMs: latestRun?.run_at_ms ?? null,
      value: typeof storedRule === "string" ? storedRule : null,
    };
    const storedRuleLine =
      latestRun === null
        ? "latest stored daily check: none"
        : `latest stored daily check: run_at=${new Date(latestRun.run_at_ms).toISOString()} carriedForwardIdRule=${carriedForwardIdRuleStored.value ?? "absent"}`;
    const condition4Met = isRunOf6670(latestDetail);
    const condition4 = {
      text: `also required before a switch to on (ruling M9): issue #6670, the daily check's open items, runs on this node (checked by this script through the latest run row: ${condition4Met ? "yes" : "no"})`,
      met: condition4Met,
    };
    const runsOf6670 = countRunsOf6670(db, nowMs);
    const runsLine = `runs of the last 7 days written by a build with #6670: ${runsOf6670.inWindow} of ${runsOf6670.runsInWindow} (first such run: ${
      runsOf6670.firstAtMs === null
        ? "none"
        : new Date(runsOf6670.firstAtMs).toISOString()
    })`;
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
            carriedForwardIdRuleStored,
            condition4,
            runsOf6670,
            run: result.run,
            details: result.details,
            unverifiedGroups: result.unverifiedGroups,
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
    console.log(storedRuleLine);
    console.log(condition4.text);
    console.log(runsLine);
    if (result.unverifiedGroups.length > 0) {
      console.log(
        `unverified (${result.unverifiedGroups.length}): wait-ended groups whose 24-hour mark only an older build's run passed; neither explained nor listed`
      );
      for (const g of result.unverifiedGroups) {
        console.log(
          `  session=${g.hapiSessionId} namespace=${g.namespace} stretch=${g.stretchStartedAtMs} intervals=${g.intervalsMs} lastEnd=${g.lastEndMs} lastEndCause=${g.lastEndCause}`
        );
      }
    }
    console.log(
      `sections: timer, shadow, silence, writes (stored totals only), balance (memory, orphan_open, write_lag and a pending lost-write count need the running server and are not printed)`
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
