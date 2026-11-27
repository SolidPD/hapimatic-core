#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * context-reset-report-v1 — the context-reset outcome report (issue #6559, Task 12).
 *
 * Opens hapi.db READ-ONLY (as `throughput-report.ts` does), reads the
 * `context_reset` turn events of a window, and prints per seam
 * (`fromStage>toStage`) the terminal outcomes in time order and the current run
 * of consecutive `delivered_reset`, and over all seams the share of armed
 * requests that ended `delivered_reset` with the reason of every other outcome.
 *
 *   bun run server/scripts/context-reset-report-v1.ts [--db PATH] [--from ISO|ms]
 *     [--to ISO|ms] [--format=md|json]
 *     [--check-streak=N --seams=from>to,from>to]
 *
 * `--check-streak` exits 0 only when, for each named seam, the latest N terminal
 * outcomes are all `delivered_reset` (ruling Q10's activation check); 1 when not.
 * Exit 2 is a usage error or a missing database.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_RESET_REPORT_VERSION,
  buildReport,
  checkStreak,
  readContextResetEvents,
  renderMarkdown,
} from "../src/contextReset/report";

const DAY_MS = 24 * 60 * 60 * 1000;

const HELP = `${CONTEXT_RESET_REPORT_VERSION}: context-reset outcomes from a node's hapi.db (read-only)

Usage: bun run server/scripts/context-reset-report-v1.ts [options]

  --db PATH             the database (default: $DB_PATH, else $HAPI_HOME/hapi.db, else ~/.hapi/hapi.db)
  --from ISO|ms         window start (default: 30 days before --to)
  --to ISO|ms           window end, exclusive (default: now)
  --format=md|json      output format (default: md)
  --check-streak=N      exit 0 only if each seam's latest N outcomes are all delivered_reset
  --seams=a>b,c>d       the seams --check-streak judges (required with it)
  --help                this text
`;

interface Args {
  db: string | null;
  from: number | null;
  to: number | null;
  format: "md" | "json";
  streak: number | null;
  seams: string[];
  help: boolean;
}

function parseTime(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function parseArgs(argv: string[]): Args | string {
  const args: Args = {
    db: null,
    from: null,
    to: null,
    format: "md",
    streak: null,
    seams: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const inline = eq === -1 ? null : raw.slice(eq + 1);
    const value = (): string | null => inline ?? argv[++i] ?? null;
    switch (key) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--db":
        args.db = value();
        if (!args.db) return "--db needs a path";
        break;
      case "--from":
      case "--to": {
        const v = value();
        const t = v === null ? null : parseTime(v);
        if (t === null) return `${key} needs an ISO time or epoch ms`;
        if (key === "--from") args.from = t;
        else args.to = t;
        break;
      }
      case "--format": {
        const v = value();
        if (v !== "md" && v !== "json") return "--format is md or json";
        args.format = v;
        break;
      }
      case "--check-streak": {
        const v = value();
        const n = v === null ? NaN : Number(v);
        if (!Number.isInteger(n) || n < 1)
          return "--check-streak needs a whole number of 1 or more";
        args.streak = n;
        break;
      }
      case "--seams": {
        const v = value();
        if (!v) return "--seams needs a list like a>b,c>d";
        args.seams = v
          .split(",")
          .map(s => s.trim())
          .filter(Boolean);
        break;
      }
      default:
        return `unknown argument: ${raw}`;
    }
  }
  if (args.streak !== null && args.seams.length === 0) {
    return "--check-streak needs --seams";
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

function main(argv: string[]): number {
  const parsed = parseArgs(argv);
  if (typeof parsed === "string") {
    console.error(`${CONTEXT_RESET_REPORT_VERSION}: ${parsed}`);
    console.error(HELP);
    return 2;
  }
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  const dbPath = parsed.db ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(
      `${CONTEXT_RESET_REPORT_VERSION}: database not found: ${dbPath}`
    );
    return 2;
  }
  const toMs = parsed.to ?? Date.now();
  const fromMs = parsed.from ?? toMs - 30 * DAY_MS;
  const db = new Database(dbPath, { readonly: true });
  try {
    const report = buildReport(readContextResetEvents(db, fromMs, toMs), {
      fromMs,
      toMs,
    });
    const streak =
      parsed.streak === null
        ? null
        : checkStreak(report, parsed.seams, parsed.streak);
    if (parsed.format === "json") {
      console.log(
        JSON.stringify({ ...report, ...(streak ? { streak } : {}) }, null, 2)
      );
    } else {
      console.log(renderMarkdown(report));
      if (streak) {
        console.log("");
        console.log(
          `Streak check (latest ${parsed.streak} per seam): ${streak.ok ? "PASS" : "FAIL"}`
        );
        for (const s of streak.seams) {
          console.log(
            `- ${s.seam}: ${s.ok ? "pass" : "fail"} [${s.latest.join(", ") || "none"}]`
          );
        }
      }
    }
    return streak && !streak.ok ? 1 : 0;
  } finally {
    db.close();
  }
}

process.exit(main(process.argv.slice(2)));
