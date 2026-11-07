#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Throughput report (issue #6164, A1 — R12, AC1).
 *
 * Computes the throughput metrics for an EXACT window from a hapi.db opened
 * READ-ONLY (never a write, never a migration), optionally computing missing
 * facts in memory from this node's transcripts, optionally counting merged PRs
 * on GitHub (read-only), and optionally comparing with the census baseline.
 * The tested core is `server/src/throughput/report.ts`.
 *
 * Usage:
 *   bun run server/scripts/throughput-report.ts --from=ISO --to=ISO
 *     [--db=PATH]                 default: $DB_PATH, else $HAPI_HOME/hapi.db, else ~/.hapi/hapi.db
 *     [--origin=ID|local]         default: local rows and every mirror origin
 *     [--facts=stored|compute]    compute: missing facts in memory (local rows only)
 *     [--github] [--repos=a/b,c/d]
 *     [--format=md|json]
 *     [--baseline=census-2026-11-02]
 *
 * AC1 example (SL7, RP1's mirrored ledger):
 *   bun run server/scripts/throughput-report.ts --db="$HOME/.hapimatic-sl7/hapi.db" \
 *     --origin=rp1-prod --from=2026-10-02T20:00:00Z --to=2026-11-02T20:00:00Z \
 *     --baseline=census-2026-11-02
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getKnownSecretLiterals } from "../src/services/knownSecretLiterals";
import {
  GithubClient,
  resolveCollectorToken,
} from "../src/throughput/github/client";
import {
  BASELINE_EXCLUSIONS,
  CENSUS_BASELINE,
  baselineRows,
  computeReport,
  fetchGithubReport,
  renderReport,
  type GithubReport,
} from "../src/throughput/report";

interface Args {
  db: string | null;
  from: number | null;
  to: number | null;
  origin: string | null;
  facts: "stored" | "compute";
  github: boolean;
  repos: string[] | null;
  format: "md" | "json";
  baseline: string | null;
  help: boolean;
}

function parseTime(v: string): number | null {
  if (/^[0-9]+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: null,
    from: null,
    to: null,
    origin: null,
    facts: "stored",
    github: false,
    repos: null,
    format: "md",
    baseline: null,
    help: false,
  };
  for (const a of argv) {
    const [key, ...rest] = a.split("=");
    const value = rest.join("=");
    switch (key) {
      case "--db":
        args.db = value.replace(/^~/, homedir());
        break;
      case "--from":
        args.from = parseTime(value);
        break;
      case "--to":
        args.to = parseTime(value);
        break;
      case "--origin":
        args.origin = value || null;
        break;
      case "--facts":
        if (value !== "stored" && value !== "compute")
          throw new Error("--facts must be stored or compute");
        args.facts = value;
        break;
      case "--github":
        args.github = true;
        break;
      case "--repos":
        args.repos = value
          .split(",")
          .map(r => r.trim())
          .filter(Boolean);
        break;
      case "--format":
        if (value !== "md" && value !== "json")
          throw new Error("--format must be md or json");
        args.format = value;
        break;
      case "--baseline":
        args.baseline = value || CENSUS_BASELINE.id;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
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

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (args.help) {
    console.log(
      "Usage: bun run server/scripts/throughput-report.ts --from=ISO --to=ISO [--db=PATH] [--origin=ID|local] [--facts=stored|compute] [--github] [--repos=a/b,c/d] [--format=md|json] [--baseline=census-2026-11-02]"
    );
    return 0;
  }
  if (args.from === null || args.to === null || args.from >= args.to) {
    console.error(
      "--from and --to are required (ISO or epoch ms), with --from before --to."
    );
    return 2;
  }
  if (args.baseline && args.baseline !== CENSUS_BASELINE.id) {
    console.error(
      `Unknown baseline: ${args.baseline} (known: ${CENSUS_BASELINE.id})`
    );
    return 2;
  }
  const dbPath = args.db ?? defaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    return 2;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const report = await computeReport({
      db,
      fromMs: args.from,
      toMs: args.to,
      origin: args.origin,
      facts: args.facts,
      literals: getKnownSecretLiterals({ ownToken: null }),
    });
    let gh: GithubReport | null = null;
    if (args.github) {
      const token = await resolveCollectorToken({});
      if (!token) {
        gh = {
          window: {},
          error: "GitHub: no credential (GH_TOKEN, GITHUB_TOKEN or gh auth).",
        };
      } else {
        const repos =
          args.repos ??
          (process.env.HAPI_THROUGHPUT_GITHUB_REPOS
            ? process.env.HAPI_THROUGHPUT_GITHUB_REPOS.split(",")
                .map(r => r.split(":")[0]!.trim())
                .filter(Boolean)
            : [...CENSUS_BASELINE.repos]);
        gh = await fetchGithubReport({
          client: new GithubClient({ token, maxCalls: 60 }),
          repos,
          fromMs: args.from,
          toMs: args.to,
          baseline: args.baseline !== null,
        });
      }
    }
    const baseline = args.baseline ? baselineRows(report, gh) : null;
    if (args.format === "json") {
      const exclusions = baseline ? BASELINE_EXCLUSIONS : null;
      console.log(
        JSON.stringify({ report, github: gh, baseline, exclusions }, null, 2)
      );
    } else {
      process.stdout.write(renderReport(report, gh, baseline));
    }
    return baseline?.some(b => b.verdict === "fail") ? 1 : 0;
  } finally {
    db.close();
  }
}

process.exit(await main());
