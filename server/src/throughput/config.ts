// SPDX-License-Identifier: AGPL-3.0-only
import { Cron } from "croner";
import {
  DEFAULT_LANE_POINTS,
  WORKTREE_PORT_MAX,
  WORKTREE_PORT_MIN,
} from "@hapi/protocol";
import type { Settings } from "../config/settings";
import type { GithubRepoConfig } from "./github/collector";
import {
  DEFAULT_CHECKPOINTS,
  DEFAULT_DANGER_PATHS,
  DEFAULT_LANE_PATTERN,
  compileLanePattern,
  type CheckpointStage,
} from "./github/issueFacts";
import { DEFAULT_DIGEST_CRON } from "./digest";
import { DEFAULT_PRICING_MODEL } from "./pricing";

/**
 * Throughput telemetry configuration (issue #6164, A1 — R13).
 *
 * Precedence: env > `settings.throughput` > default. An invalid value falls
 * through to the next layer (never a crash). These are also listed in
 * `rejected` (logged once at boot): the env flags, repo entries, the digest
 * cron and timezone, `labels.lanePattern` and `labels.points`. A non-boolean
 * `disabled` / `factsEnabled` / `fleetJobs`, an out-of-range
 * `github.backfillDays` / `github.intervalMinutes`, a malformed
 * `labels.checkpoints` and `github.dangerPaths` silently use the default
 * (#6355 item 5).
 *
 *   HAPI_THROUGHPUT_DISABLED=1         every loop registers as stopped
 *   HAPI_THROUGHPUT_FACTS_ENABLED=0|1  the facts loop (default ON, but OFF on
 *                                      worktree ports, like the transcript indexer)
 *   HAPI_THROUGHPUT_GITHUB_REPOS       `owner/repo[:ciWorkflow[:trunk]]`, comma-separated
 *   HAPI_THROUGHPUT_DIGEST_CRON        the digest schedule (default `0 6 * * 1`)
 *
 * The rollup loop runs on every node. The fleet jobs (GitHub, quota, digest)
 * run where `fleetJobs` is true: by default a federation hub, or a node with
 * no federation; `settings.throughput.fleetJobs` overrides. The GitHub job also
 * needs at least one configured repo (a repo with no `ciWorkflow` gets no CI
 * metrics, and the summary says so).
 */

export type ThroughputSettings = NonNullable<Settings["throughput"]>;

export interface ThroughputConfig {
  disabled: boolean;
  facts: {
    enabled: boolean;
    source: "env" | "settings" | "default" | "worktree-default";
  };
  rollup: { enabled: boolean };
  fleetJobs: boolean;
  github: {
    repos: GithubRepoConfig[];
    /** The idle cadence (the job runs every 15 min while it is behind). */
    intervalMs: number;
    backfillDays: number;
    dangerPaths: string[];
  };
  digest: { cron: string; timezone: string | undefined };
  pricing: { defaultModel: string };
  labels: {
    checkpoints: CheckpointStage[];
    lanePattern: string;
    points: Record<string, number>;
  };
  /** Ignored invalid values that are reported (the header lists which). */
  rejected: string[];
}

const OFF = new Set(["0", "false", "no", "off"]);
const ON = new Set(["1", "true", "yes", "on"]);
const REPO = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_BACKFILL_DAYS = 35;
const DEFAULT_GITHUB_INTERVAL_MIN = 60;

function flag(raw: string | undefined): boolean | null {
  const v = raw?.trim().toLowerCase() ?? "";
  if (ON.has(v)) return true;
  if (OFF.has(v)) return false;
  return null;
}

function validCron(expr: string, timezone: string | undefined): boolean {
  try {
    return new Cron(expr, { timezone }).nextRun() !== null;
  } catch {
    return false;
  }
}

/** One repo entry: `owner/repo[:ciWorkflow[:trunk]]` or an object. */
function parseRepo(entry: unknown): GithubRepoConfig | null {
  if (typeof entry === "string") {
    const [repo, ciWorkflow, trunkBranch] = entry.trim().split(":");
    if (!repo || !REPO.test(repo)) return null;
    return {
      repo,
      ciWorkflow: ciWorkflow || null,
      trunkBranch: trunkBranch || null,
    };
  }
  if (entry && typeof entry === "object") {
    const e = entry as Record<string, unknown>;
    if (typeof e.repo !== "string" || !REPO.test(e.repo)) return null;
    return {
      repo: e.repo,
      ciWorkflow: typeof e.ciWorkflow === "string" ? e.ciWorkflow : null,
      trunkBranch: typeof e.trunkBranch === "string" ? e.trunkBranch : null,
    };
  }
  return null;
}

export function loadThroughputConfig(input: {
  settings: Settings | null;
  env?: Record<string, string | undefined>;
  listenPort?: number;
  /** null: no federation (standalone). */
  federationRole: "hub" | "node" | "peer" | null;
}): ThroughputConfig {
  const env = input.env ?? process.env;
  const s: ThroughputSettings = input.settings?.throughput ?? {};
  const rejected: string[] = [];

  const envDisabled = flag(env.HAPI_THROUGHPUT_DISABLED);
  if (env.HAPI_THROUGHPUT_DISABLED && envDisabled === null) {
    rejected.push(`HAPI_THROUGHPUT_DISABLED=${env.HAPI_THROUGHPUT_DISABLED}`);
  }
  const disabled = envDisabled ?? s.disabled === true;

  let facts: ThroughputConfig["facts"];
  const envFacts = flag(env.HAPI_THROUGHPUT_FACTS_ENABLED);
  if (env.HAPI_THROUGHPUT_FACTS_ENABLED && envFacts === null) {
    rejected.push(
      `HAPI_THROUGHPUT_FACTS_ENABLED=${env.HAPI_THROUGHPUT_FACTS_ENABLED}`
    );
  }
  if (envFacts !== null) {
    facts = { enabled: envFacts, source: "env" };
  } else if (typeof s.factsEnabled === "boolean") {
    facts = { enabled: s.factsEnabled, source: "settings" };
  } else {
    const port = input.listenPort;
    const worktree =
      port !== undefined &&
      port >= WORKTREE_PORT_MIN &&
      port <= WORKTREE_PORT_MAX;
    facts = worktree
      ? { enabled: false, source: "worktree-default" }
      : { enabled: true, source: "default" };
  }

  const fleetJobs =
    typeof s.fleetJobs === "boolean"
      ? s.fleetJobs
      : input.federationRole === null || input.federationRole === "hub";

  const repoEntries: unknown[] = env.HAPI_THROUGHPUT_GITHUB_REPOS
    ? env.HAPI_THROUGHPUT_GITHUB_REPOS.split(",").filter(x => x.trim() !== "")
    : (s.github?.repos ?? []);
  const repos: GithubRepoConfig[] = [];
  for (const entry of repoEntries) {
    const parsed = parseRepo(entry);
    if (parsed) repos.push(parsed);
    else rejected.push(`github repo ${JSON.stringify(entry)}`);
  }
  const backfillDays =
    typeof s.github?.backfillDays === "number" &&
    s.github.backfillDays >= 1 &&
    s.github.backfillDays <= 92
      ? Math.floor(s.github.backfillDays)
      : DEFAULT_BACKFILL_DAYS;

  const intervalMinutes =
    typeof s.github?.intervalMinutes === "number" &&
    s.github.intervalMinutes >= 15 &&
    s.github.intervalMinutes <= 1440
      ? s.github.intervalMinutes
      : DEFAULT_GITHUB_INTERVAL_MIN;

  // Check the zone on its own (#6164 round 1, IR5): croner cannot compute a
  // fire time in an unknown zone, so with no cron set the digest never ran
  // and nothing said why, and with a cron set the cron took the blame.
  let timezone = s.digest?.timezone || undefined;
  if (timezone !== undefined && !validCron(DEFAULT_DIGEST_CRON, timezone)) {
    rejected.push(`settings.throughput.digest.timezone=${timezone}`);
    timezone = undefined; // the server's own zone
  }
  let cron = DEFAULT_DIGEST_CRON;
  for (const [label, candidate] of [
    ["HAPI_THROUGHPUT_DIGEST_CRON", env.HAPI_THROUGHPUT_DIGEST_CRON],
    ["settings.throughput.digest.cron", s.digest?.cron],
  ] as const) {
    if (!candidate) continue;
    if (validCron(candidate, timezone)) {
      cron = candidate;
      break;
    }
    rejected.push(`${label}=${candidate}`);
  }

  let lanePattern = DEFAULT_LANE_PATTERN;
  if (s.labels?.lanePattern) {
    if (compileLanePattern(s.labels.lanePattern))
      lanePattern = s.labels.lanePattern;
    else rejected.push(`labels.lanePattern=${s.labels.lanePattern}`);
  }
  const checkpoints =
    Array.isArray(s.labels?.checkpoints) &&
    s.labels.checkpoints.every(
      c => typeof c?.stage === "string" && typeof c?.suffix === "string"
    ) &&
    s.labels.checkpoints.length > 0
      ? s.labels.checkpoints
      : [...DEFAULT_CHECKPOINTS];
  const points: Record<string, number> = { ...DEFAULT_LANE_POINTS };
  if (s.labels?.points) {
    for (const [lane, p] of Object.entries(s.labels.points)) {
      if (typeof p === "number" && Number.isFinite(p) && p >= 0) {
        points[lane.toLowerCase()] = p;
      } else {
        rejected.push(`labels.points.${lane}`);
      }
    }
  }

  return {
    disabled,
    facts,
    rollup: { enabled: true },
    fleetJobs,
    github: {
      repos,
      intervalMs: intervalMinutes * 60_000,
      backfillDays,
      dangerPaths: Array.isArray(s.github?.dangerPaths)
        ? s.github.dangerPaths.filter(p => typeof p === "string" && p !== "")
        : [...DEFAULT_DANGER_PATHS],
    },
    digest: { cron, timezone },
    pricing: {
      defaultModel: s.pricing?.defaultModel || DEFAULT_PRICING_MODEL,
    },
    labels: { checkpoints, lanePattern, points },
    rejected,
  };
}
