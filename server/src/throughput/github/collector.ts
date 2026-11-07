// SPDX-License-Identifier: AGPL-3.0-only
import {
  ESCAPE_WINDOW_MS,
  SupervisedLoop,
  utcDayOf,
  type JobFailureEvent,
  type JobRegistry,
} from "@hapi/protocol";
import type {
  IssueFactsRecord,
  ThroughputGithubStore,
} from "../../store/throughput/githubStore";
import type { FetchImpl } from "../../utils/githubRest";
import {
  familyGates,
  fetchFailedJobs,
  fetchJobUnits,
  fetchRuns,
  gateUnits,
} from "./ciLogs";
import { GithubClient, nextBackoffMs, nextLink } from "./client";
import {
  buildIssueRecord,
  issuesOfPull,
  summarizePullFiles,
  type IssueVocabulary,
} from "./issueFacts";
import {
  fetchDefaultBranch,
  fetchPullFiles,
  fetchRecentPulls,
  fetchTimeline,
  parseIssueItem,
  updatedIssuesUrl,
  type IssueListItem,
} from "./timeline";

/**
 * The `throughput-github` fleet job (issue #6164, A1 — R6, R14).
 *
 * Runs on ONE node (`fleetJobs`), hourly, and only with configured repos and
 * a GitHub credential. Each run is one budget of at most 150 sequential calls
 * (see `client.ts`), spent in this order so the cheap, high-value steps never
 * starve behind a backfill:
 *   1. `GET /rate_limit` (stop below 1,500 remaining);
 *   2. the trunk branch (configured, else the default branch, daily);
 *   3. merged PRs (closed PRs updated since the watermark − 10 min);
 *   4. merged PRs' file stats;
 *   5. CI runs of the configured workflow, one created-day at a time
 *      (resumable; the last two days are re-listed for runs still going);
 *   6. failed jobs' logs, each parsed once;
 *   7. the daily re-check of issues closed in the last 14 days (conditional
 *      requests for one-page timelines), which finds late follow-ups;
 *   8. issues updated since the watermark − 10 min, with their COMPLETE
 *      timelines (the backfill, which takes what is left).
 * Every step is resumable from its watermark. While any step is behind, the
 * next run comes in 15 minutes (≤ 600 calls an hour), else in an hour; a
 * rate-limited run waits for GitHub's retry time.
 *
 * Fail-open: a throw never escapes the loop, a failed step leaves its
 * watermark where it was, and nothing here touches the session ledger.
 */

export interface GithubRepoConfig {
  /** `owner/name`. */
  repo: string;
  /** The trunk branch; default: the repo's default branch. */
  trunkBranch?: string | null;
  /** The CI workflow file (e.g. `test.yml`); none = no CI metrics. */
  ciWorkflow?: string | null;
}

export const GITHUB_LOOP_NAME = "throughput-github";
export const GITHUB_UNAVAILABLE = "GitHub: not available on this node";
const IDLE_INTERVAL_MS = 60 * 60_000;
const BEHIND_INTERVAL_MS = 15 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;
const OVERLAP_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_BACKFILL_DAYS = 35;
const CI_RELIST_DAYS = 2;
const CI_RETENTION_DAYS = 400;
const TRUNK_REFRESH_MS = DAY_MS;

/** Soft per-step call caps (the issue backfill takes what is left). */
const CAPS = {
  pulls: 20,
  prFiles: 30,
  ciRuns: 20,
  ciLogs: 25,
  recheck: 25,
} as const;
const LOG_DOWNLOADS_PER_RUN = 10;

export interface GithubRunReport {
  atMs: number;
  available: boolean;
  reason: string | null;
  calls: number;
  rateRemaining: number | null;
  stopped: string | null;
  behind: boolean;
  issues: number;
  timelines: number;
  notModified: number;
  prs: number;
  prFiles: number;
  ciRuns: number;
  jobsParsed: number;
  logBytes: number;
  /** Repos without a CI workflow (CI metrics skipped). */
  noCi: string[];
  /**
   * Configuration errors a retry will not fix: a repo or a CI workflow that
   * GitHub answers 404 for (missing, mistyped, or not readable with this
   * token). Shown in the summary's coverage (#6164 round 1, IR2).
   */
  problems: string[];
  durationMs: number;
  maxSyncMs: number;
}

export interface GithubCollectorOptions {
  store: ThroughputGithubStore;
  repos: readonly GithubRepoConfig[];
  vocab: IssueVocabulary;
  /** Resolves the credential once per run (null = not available here). */
  resolveToken: () => Promise<string | null>;
  fetchImpl?: FetchImpl;
  now?: () => number;
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
  backfillDays?: number;
  /** The cadence when not behind (default an hour). */
  idleIntervalMs?: number;
  /** Test override for the per-call spacing. */
  minGapMs?: number;
  maxCalls?: number;
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString();
}

function nextDay(day: string): string {
  return utcDayOf(Date.parse(`${day}T00:00:00Z`) + DAY_MS);
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A stored record as an `/issues` list entry (for a timeline-only refresh). */
function listItemOf(rec: IssueFactsRecord): IssueListItem {
  return {
    number: rec.number,
    title: rec.title,
    state: rec.state,
    stateReason: rec.stateReason,
    createdAtMs: rec.createdAtMs,
    closedAtMs: rec.closedAtMs,
    updatedAtMs: rec.updatedAtMs,
    labels: rec.labels,
  };
}

interface RecheckState {
  day: string;
  after: { closedAtMs: number; number: number } | null;
  done: boolean;
}

export class ThroughputGithubCollector {
  private readonly store: ThroughputGithubStore;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly backfillMs: number;
  private behind = false;
  private hasRun = false;
  private retryAtMs: number | null = null;
  private backoffMs: number | null = null;
  private runs = 0;
  private lastReport: GithubRunReport | null = null;
  /** Repos found missing (404) in the current run; later steps skip them. */
  private missingRepos = new Set<string>();
  /** Repos that answered in the current run (see `repoReadable`). */
  private readableRepos = new Set<string>();

  constructor(private readonly opts: GithubCollectorOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.monotonic = opts.monotonic ?? (() => performance.now());
    this.backfillMs = (opts.backfillDays ?? DEFAULT_BACKFILL_DAYS) * DAY_MS;
  }

  get isBehind(): boolean {
    return this.behind;
  }

  get report(): GithubRunReport | null {
    return this.lastReport;
  }

  /** The delay before the next run (first run soon after boot). */
  nextDelayMs(): number {
    if (!this.hasRun) return FIRST_RUN_DELAY_MS;
    let delay = this.behind
      ? BEHIND_INTERVAL_MS
      : (this.opts.idleIntervalMs ?? IDLE_INTERVAL_MS);
    if (this.backoffMs !== null) delay = Math.max(delay, this.backoffMs);
    if (this.retryAtMs !== null) {
      delay = Math.max(delay, this.retryAtMs - this.now());
    }
    return delay;
  }

  /** One budgeted run over every configured repo. */
  async run(): Promise<GithubRunReport> {
    const t0 = this.monotonic();
    this.hasRun = true;
    this.missingRepos = new Set();
    this.readableRepos = new Set();
    const r: GithubRunReport = {
      atMs: this.now(),
      available: false,
      reason: null,
      calls: 0,
      rateRemaining: null,
      stopped: null,
      behind: false,
      issues: 0,
      timelines: 0,
      notModified: 0,
      prs: 0,
      prFiles: 0,
      ciRuns: 0,
      jobsParsed: 0,
      logBytes: 0,
      noCi: [],
      problems: [],
      durationMs: 0,
      maxSyncMs: 0,
    };
    const finish = (): GithubRunReport => {
      r.durationMs = Math.round(this.monotonic() - t0);
      this.lastReport = r;
      this.behind = r.behind;
      this.store.setState(
        "github.last_run",
        JSON.stringify({
          atMs: r.atMs,
          available: r.available,
          reason: r.reason,
          calls: r.calls,
          stopped: r.stopped,
          behind: r.behind,
          noCi: r.noCi,
          problems: r.problems,
          repos: this.opts.repos.map(c => c.repo),
        })
      );
      return r;
    };

    if (this.opts.repos.length === 0) {
      r.reason = "GitHub: no repositories configured";
      return finish();
    }
    const token = await this.opts.resolveToken();
    if (!token) {
      r.reason = GITHUB_UNAVAILABLE;
      return finish();
    }
    r.available = true;
    const client = new GithubClient({
      token,
      fetchImpl: this.opts.fetchImpl,
      now: this.now,
      sleep: this.opts.sleep,
      minGapMs: this.opts.minGapMs,
      maxCalls: this.opts.maxCalls,
    });
    const timed = <T>(fn: () => T): T => {
      const s = this.monotonic();
      try {
        return fn();
      } finally {
        r.maxSyncMs = Math.max(r.maxSyncMs, this.monotonic() - s);
      }
    };

    // Rotate the starting repo so no repo is always last in line.
    const start = this.runs % this.opts.repos.length;
    this.runs += 1;
    const repos = [
      ...this.opts.repos.slice(start),
      ...this.opts.repos.slice(0, start),
    ];

    if (!(await client.checkRateLimit())) {
      if (client.stopKind === "error") {
        r.available = false;
        r.reason = `GitHub: ${client.stopReason ?? "unavailable"}`;
      }
    } else {
      await this.trunks(client, repos, r);
      await this.pulls(client, repos, r, timed);
      await this.prFiles(client, r, timed);
      await this.ciRuns(client, repos, r, timed);
      await this.ciLogs(client, r, timed);
      await this.recheck(client, repos, r, timed);
      await this.issues(client, repos, r, timed);
      this.pruneDaily();
    }

    r.calls = client.callsMade;
    r.rateRemaining = client.rateRemaining;
    r.stopped = client.stopReason;
    if (client.stopKind === "budget") r.behind = true;
    if (client.stopKind === "rate_limited") {
      this.backoffMs = nextBackoffMs(this.backoffMs);
      this.retryAtMs = client.retryAtMs;
      r.behind = true;
    } else {
      this.backoffMs = null;
      this.retryAtMs = null;
    }
    return finish();
  }

  /** Record a configuration error once per run (#6164 round 1, IR2). */
  private problem(r: GithubRunReport, text: string): void {
    if (!r.problems.includes(text)) r.problems.push(text);
  }

  /**
   * A repo answered 404: record it and skip it for the rest of the run, so it
   * neither stalls a step nor starves the repos after it.
   */
  private repoMissing(r: GithubRunReport, repo: string): void {
    this.missingRepos.add(repo);
    this.problem(r, `${repo}: repository not found or not readable (HTTP 404)`);
  }

  /**
   * Whether `repo` answers this token, asked at most once per run (#6164
   * round 2). A 404 for a run, PR or workflow of a readable repo means that
   * item is gone; of an unreadable repo it means the token lost access, so
   * the item stays pending until access returns. Null: unknown (the client
   * stopped), so the caller retries on a later run.
   */
  private async repoReadable(
    client: GithubClient,
    r: GithubRunReport,
    repo: string
  ): Promise<boolean | null> {
    if (this.missingRepos.has(repo)) return false;
    if (this.readableRepos.has(repo)) return true;
    const { notFound } = await fetchDefaultBranch(client, repo);
    if (notFound) {
      this.repoMissing(r, repo);
      return false;
    }
    if (client.stopKind) return null;
    this.readableRepos.add(repo);
    return true;
  }

  /** Configured repos not found missing in this run. */
  private reposToRead(withCiOnly: boolean): string[] {
    return this.opts.repos
      .filter(c => !withCiOnly || c.ciWorkflow)
      .map(c => c.repo)
      .filter(repo => !this.missingRepos.has(repo));
  }

  // ─────────────────────────── steps ───────────────────────────

  /** The trunk branch per repo (configured, else the default branch, daily). */
  private async trunks(
    client: GithubClient,
    repos: readonly GithubRepoConfig[],
    r: GithubRunReport
  ): Promise<void> {
    for (const cfg of repos) {
      const key = `github.${cfg.repo}.trunk`;
      if (cfg.trunkBranch) {
        this.store.setState(
          key,
          JSON.stringify({ branch: cfg.trunkBranch, checkedMs: this.now() })
        );
        continue;
      }
      const stored = parseJson<{ branch: string; checkedMs: number }>(
        this.store.getState(key)
      );
      if (stored && this.now() - stored.checkedMs < TRUNK_REFRESH_MS) continue;
      const { branch, notFound } = await fetchDefaultBranch(client, cfg.repo);
      if (notFound) {
        this.repoMissing(r, cfg.repo);
        continue;
      }
      if (branch) {
        this.readableRepos.add(cfg.repo);
        this.store.setState(
          key,
          JSON.stringify({ branch, checkedMs: this.now() })
        );
      }
    }
  }

  /** Merged PRs since the watermark (newest first; the list stops there). */
  private async pulls(
    client: GithubClient,
    repos: readonly GithubRepoConfig[],
    r: GithubRunReport,
    timed: <T>(fn: () => T) => T
  ): Promise<void> {
    const startCalls = client.callsMade;
    for (const cfg of repos) {
      if (this.missingRepos.has(cfg.repo)) continue;
      const key = `github.${cfg.repo}.pulls_since`;
      const sinceMs =
        Number(this.store.getState(key)) || this.now() - this.backfillMs;
      const left = CAPS.pulls - (client.callsMade - startCalls);
      if (left <= 0) {
        r.behind = true;
        return;
      }
      const listedAt = this.now();
      const list = await fetchRecentPulls(
        client,
        cfg.repo,
        sinceMs - OVERLAP_MS,
        left
      );
      if (list.notFound) {
        this.repoMissing(r, cfg.repo);
        continue;
      }
      if (list.complete || list.pulls.length > 0) {
        this.readableRepos.add(cfg.repo);
      }
      timed(() => {
        for (const p of list.pulls) {
          if (p.mergedAtMs === null) continue;
          this.store.upsertPr({
            repo: cfg.repo,
            number: p.number,
            title: p.title,
            headRef: p.headRef,
            mergedAtMs: p.mergedAtMs,
            issues: issuesOfPull(p),
            codeLines: null,
            testLines: null,
            docLines: null,
            codeFiles: null,
            codePaths: null,
            filesFetched: false,
            fetchedAtMs: this.now(),
          });
          r.prs += 1;
        }
      });
      if (list.complete) this.store.setState(key, String(listedAt));
      else r.behind = true;
      if (client.stopKind) return;
    }
  }

  /** File stats of merged PRs that lack them (oldest merge first). */
  private async prFiles(
    client: GithubClient,
    r: GithubRunReport,
    timed: <T>(fn: () => T) => T
  ): Promise<void> {
    const startCalls = client.callsMade;
    const pending = this.store.listPrsNeedingFiles(
      CAPS.prFiles,
      this.reposToRead(false)
    );
    for (const pr of pending) {
      if (client.callsMade - startCalls >= CAPS.prFiles || client.stopKind) {
        r.behind = true;
        return;
      }
      if (this.missingRepos.has(pr.repo)) continue;
      const files = await fetchPullFiles(client, pr.repo, pr.number);
      if (files === null) {
        r.behind = true;
        return;
      }
      if (files === "not_found") {
        const readable = await this.repoReadable(client, r, pr.repo);
        if (readable === null) {
          r.behind = true;
          return;
        }
        // The repo lost access: the PR keeps waiting for its files.
        if (!readable) continue;
      }
      timed(() => {
        // A deleted PR of a readable repo has no files left to read.
        const s = summarizePullFiles(files === "not_found" ? [] : files);
        this.store.upsertPr({
          ...pr,
          codeLines: s.codeLines,
          testLines: s.testLines,
          docLines: s.docLines,
          codeFiles: s.codeFiles,
          codePaths: s.codePaths,
          filesFetched: true,
          fetchedAtMs: this.now(),
        });
      });
      r.prFiles += 1;
    }
    if (pending.length >= CAPS.prFiles) r.behind = true;
  }

  /** CI runs, one created-day at a time from the watermark day to today. */
  private async ciRuns(
    client: GithubClient,
    repos: readonly GithubRepoConfig[],
    r: GithubRunReport,
    timed: <T>(fn: () => T) => T
  ): Promise<void> {
    const startCalls = client.callsMade;
    const today = utcDayOf(this.now());
    const relistFrom = utcDayOf(this.now() - (CI_RELIST_DAYS - 1) * DAY_MS);
    for (const cfg of repos) {
      if (!cfg.ciWorkflow) {
        r.noCi.push(cfg.repo);
        continue;
      }
      if (this.missingRepos.has(cfg.repo)) continue;
      const key = `github.${cfg.repo}.ci_day`;
      let day =
        this.store.getState(key) ?? utcDayOf(this.now() - this.backfillMs);
      while (day <= today) {
        const left = CAPS.ciRuns - (client.callsMade - startCalls);
        if (left <= 0 || client.stopKind) {
          r.behind = true;
          return;
        }
        const list = await fetchRuns(
          client,
          cfg.repo,
          cfg.ciWorkflow,
          day,
          left,
          {
            exactDay: true,
          }
        );
        if (list.notFound) {
          // A readable repo is missing the workflow; an unreadable one is
          // recorded as missing. A retry cannot fix either: record it and
          // move on to the next repo.
          const readable = await this.repoReadable(client, r, cfg.repo);
          if (readable === null) {
            r.behind = true;
            return;
          }
          if (readable) {
            this.problem(
              r,
              `${cfg.repo}: CI workflow ${cfg.ciWorkflow} not found (HTTP 404)`
            );
          }
          break;
        }
        timed(() => {
          for (const run of list.runs) {
            this.store.upsertCiRun({
              ...run,
              repo: cfg.repo,
              logsParsed: false,
            });
            r.ciRuns += 1;
          }
        });
        if (!list.complete) {
          r.behind = true;
          return;
        }
        // Keep re-listing the last days: their runs may still be going.
        const next = nextDay(day);
        this.store.setState(key, next < relistFrom ? next : relistFrom);
        day = next;
      }
    }
  }

  /** Failed jobs' logs: each job parsed once; a run is done when all are. */
  private async ciLogs(
    client: GithubClient,
    r: GithubRunReport,
    timed: <T>(fn: () => T) => T
  ): Promise<void> {
    const startCalls = client.callsMade;
    let downloads = 0;
    const pending = this.store.listRunsNeedingLogs(
      CAPS.ciLogs,
      this.reposToRead(true)
    );
    for (const run of pending) {
      if (client.callsMade - startCalls >= CAPS.ciLogs || client.stopKind) {
        r.behind = true;
        return;
      }
      if (this.missingRepos.has(run.repo)) continue;
      const jobs = await fetchFailedJobs(client, run.repo, run.runId);
      if (jobs === null) {
        r.behind = true;
        return;
      }
      if (jobs === "not_found") {
        // A deleted run of a readable repo has no jobs left to read; the run
        // of a repo that lost access keeps waiting.
        const readable = await this.repoReadable(client, r, run.repo);
        if (readable === null) {
          r.behind = true;
          return;
        }
        if (readable) this.store.markRunParsed(run.repo, run.runId);
        continue;
      }
      const parsed = this.store.parsedJobIds(run.repo, run.runId);
      let allDone = true;
      for (const { id: jobId, failedSteps } of jobs) {
        if (parsed.has(jobId)) continue;
        if (
          downloads >= LOG_DOWNLOADS_PER_RUN ||
          client.callsMade - startCalls >= CAPS.ciLogs ||
          client.stopKind
        ) {
          allDone = false;
          r.behind = true;
          break;
        }
        downloads += 1;
        const { result, units: all } = await fetchJobUnits(
          client,
          run.repo,
          jobId
        );
        // A family counts only when a step of its kind failed (ci-catch-v3).
        const units = gateUnits(all, familyGates(failedSteps));
        if (result.kind === "ok" || result.kind === "gone") {
          timed(() =>
            this.store.recordJob({
              repo: run.repo,
              runId: run.runId,
              jobId,
              units,
              truncated: result.kind === "ok" && result.truncated,
              logMissing: result.kind === "gone",
              createdAtMs: run.createdAtMs,
            })
          );
          if (result.kind === "ok") r.logBytes += result.bytes;
          r.jobsParsed += 1;
        } else {
          allDone = false; // retry on a later run
          if (result.kind === "stopped") break;
        }
      }
      if (allDone) this.store.markRunParsed(run.repo, run.runId);
      if (client.stopKind) return;
    }
  }

  /**
   * Once a day: re-read the timelines of issues closed in the last 14 days
   * (a follow-up's cross-reference does not bump the issue's `updated_at`).
   */
  private async recheck(
    client: GithubClient,
    repos: readonly GithubRepoConfig[],
    r: GithubRunReport,
    timed: <T>(fn: () => T) => T
  ): Promise<void> {
    const startCalls = client.callsMade;
    const today = utcDayOf(this.now());
    const sinceMs = this.now() - ESCAPE_WINDOW_MS;
    for (const cfg of repos) {
      if (this.missingRepos.has(cfg.repo)) continue;
      const key = `github.${cfg.repo}.recheck`;
      let state = parseJson<RecheckState>(this.store.getState(key));
      if (!state || state.day !== today) {
        state = { day: today, after: null, done: false };
      }
      if (state.done) continue;
      for (;;) {
        const left = CAPS.recheck - (client.callsMade - startCalls);
        if (left <= 0 || client.stopKind) {
          this.store.setState(key, JSON.stringify(state));
          r.behind = true;
          return;
        }
        const batch = this.store.listClosedAfter(
          cfg.repo,
          sinceMs,
          state.after,
          Math.min(left, 25)
        );
        if (batch.length === 0) {
          state.done = true;
          break;
        }
        for (const rec of batch) {
          if (CAPS.recheck - (client.callsMade - startCalls) <= 0) break;
          const outcome = await this.refreshTimeline(
            client,
            cfg.repo,
            listItemOf(rec),
            rec,
            r,
            timed
          );
          if (outcome === "stop") break;
          state.after = { closedAtMs: rec.closedAtMs ?? 0, number: rec.number };
        }
        this.store.setState(key, JSON.stringify(state));
      }
      this.store.setState(key, JSON.stringify(state));
    }
  }

  /** Issues updated since the watermark, with their complete timelines. */
  private async issues(
    client: GithubClient,
    repos: readonly GithubRepoConfig[],
    r: GithubRunReport,
    timed: <T>(fn: () => T) => T
  ): Promise<void> {
    for (const cfg of repos) {
      if (this.missingRepos.has(cfg.repo)) continue;
      const key = `github.${cfg.repo}.issues_since`;
      const storedSince = Date.parse(this.store.getState(key) ?? "");
      let watermark = Number.isNaN(storedSince)
        ? this.now() - this.backfillMs
        : storedSince;
      let url: string | null = updatedIssuesUrl(
        cfg.repo,
        isoOf(watermark - OVERLAP_MS)
      );
      while (url) {
        if (client.stopKind) {
          r.behind = true;
          return;
        }
        const page = await client.get(url);
        if (page.kind === "not_found") {
          // Record it and go on to the next repo; the watermark stays put.
          this.repoMissing(r, cfg.repo);
          break;
        }
        if (page.kind !== "ok") {
          r.behind = true;
          return;
        }
        const raw: unknown[] = Array.isArray(page.body) ? page.body : [];
        for (const entry of raw) {
          const updated = Date.parse(
            String((entry as { updated_at?: unknown } | null)?.updated_at)
          );
          const item = parseIssueItem(entry);
          if (item) {
            const stored = this.store.getIssue(cfg.repo, item.number);
            // Closed issues (and stored issues that were reopened) need the
            // timeline; an open issue is read when it closes.
            const wanted = item.state === "CLOSED" || stored !== null;
            const fresh =
              stored !== null &&
              stored.updatedAtMs !== null &&
              item.updatedAtMs !== null &&
              stored.updatedAtMs >= item.updatedAtMs;
            if (wanted && !fresh) {
              const outcome = await this.refreshTimeline(
                client,
                cfg.repo,
                item,
                stored,
                r,
                timed
              );
              if (outcome === "stop") {
                this.store.setState(key, isoOf(watermark));
                r.behind = true;
                return;
              }
              r.issues += 1;
            }
          }
          if (!Number.isNaN(updated) && updated > watermark) {
            watermark = updated;
          }
        }
        this.store.setState(key, isoOf(watermark));
        url = nextLink(page.link);
      }
    }
  }

  /**
   * Read one issue's timeline and store the record. `stop` = the client
   * stopped (retry from here next run); `skip` = this issue could not be read
   * completely for another reason (it is re-read when it next changes).
   */
  private async refreshTimeline(
    client: GithubClient,
    repo: string,
    item: IssueListItem,
    stored: IssueFactsRecord | null,
    r: GithubRunReport,
    timed: <T>(fn: () => T) => T
  ): Promise<"ok" | "skip" | "stop"> {
    const tl = await fetchTimeline(
      client,
      repo,
      item.number,
      stored?.timelineEtag ?? null
    );
    if (tl.kind === "not_found") return "skip"; // deleted or transferred
    if (tl.kind === "incomplete") return client.stopKind ? "stop" : "skip";
    if (tl.kind === "not_modified") {
      r.notModified += 1;
      if (stored) {
        timed(() =>
          this.store.upsertIssue({
            ...stored,
            title: item.title,
            state: item.state,
            stateReason: item.stateReason,
            closedAtMs: item.closedAtMs,
            updatedAtMs: item.updatedAtMs,
            labels: item.labels,
            fetchedAtMs: this.now(),
          })
        );
      }
      return "ok";
    }
    r.timelines += 1;
    timed(() =>
      this.store.upsertIssue(
        buildIssueRecord({
          repo,
          item,
          events: tl.events,
          etag: tl.pages === 1 ? tl.etag : null,
          vocab: this.opts.vocab,
          nowMs: this.now(),
        })
      )
    );
    return "ok";
  }

  /** Daily: drop CI rows older than 400 days. */
  private pruneDaily(): void {
    const today = utcDayOf(this.now());
    if (this.store.getState("github.pruned_day") === today) return;
    this.store.pruneCiBefore(this.now() - CI_RETENTION_DAYS * DAY_MS);
    this.store.setState("github.pruned_day", today);
  }
}

/** Registry metrics for the GitHub loop (4.6 observability). */
export interface GithubLoopMetrics {
  tickMs: number;
  mbRead: number;
  rowsWritten: number;
  longestSyncMs: number;
  calls: number;
  available: boolean;
  reason: string | null;
  behind: boolean;
  stopped: string | null;
}

/**
 * Build the `throughput-github` SupervisedLoop. Disabled (registered as
 * stopped) unless repos are configured and this node runs the fleet jobs.
 */
export function createGithubLoop(opts: {
  collector: ThroughputGithubCollector;
  node: string;
  enabled: boolean;
  registry?: JobRegistry;
  onEvent?: (event: JobFailureEvent) => void;
}): SupervisedLoop {
  const { collector, registry } = opts;
  return new SupervisedLoop({
    name: GITHUB_LOOP_NAME,
    node: opts.node,
    intervalMs: IDLE_INTERVAL_MS,
    getIntervalMs: () => collector.nextDelayMs(),
    enabled: opts.enabled,
    immediate: false,
    registry,
    onEvent: opts.onEvent,
    tick: async () => {
      const r = await collector.run();
      const metrics: GithubLoopMetrics = {
        tickMs: r.durationMs,
        mbRead: Math.round((r.logBytes / (1024 * 1024)) * 100) / 100,
        rowsWritten: r.issues + r.prs + r.prFiles + r.ciRuns + r.jobsParsed,
        longestSyncMs: Math.round(r.maxSyncMs),
        calls: r.calls,
        available: r.available,
        reason: r.reason,
        behind: r.behind,
        stopped: r.stopped,
      };
      registry?.update(GITHUB_LOOP_NAME, { throughput: metrics });
    },
  });
}
