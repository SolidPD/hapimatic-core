// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { readThroughputState, writeThroughputState } from "./schema";

/**
 * GitHub-derived delivery facts for throughput telemetry (issue #6164, A1).
 *
 * Written only by the fleet-job GitHub collector (one node), read by the
 * summary and the per-issue / per-test routes. Rows hold COLLECTED facts —
 * label milestones, lane history, reopen times, follow-up references, PR line
 * counts, CI runs and failing units — and the readers derive lead time,
 * escapes, CI failures and trunk-red hours from them, so a change in the 14-day
 * escape rule or the lane points needs no re-collection.
 */

/**
 * An issue (never a PR) that cross-references this one. Only references that
 * can matter are kept: the escape pattern matched its title/body, or the sink
 * pattern matched its title.
 */
export interface FollowUpRef {
  repo: string;
  number: number;
  createdAtMs: number | null;
  /** Title/body matched `regress|introduced by|broke|caused by`. */
  regression: boolean;
  /** Title/body matched the escape pattern (regression words or `follow-?up`). */
  escape: boolean;
  /** Title matched `sink|review` (the backtest's `sinks` column). */
  sink: boolean;
}

export interface IssueFactsRecord {
  repo: string;
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  createdAtMs: number | null;
  closedAtMs: number | null;
  updatedAtMs: number | null;
  labels: string[];
  /** Checkpoint stage → first time its label was added (ms). */
  milestones: Record<string, number>;
  lane: string | null;
  laneFirst: string | null;
  /** `[atMs, lane | null]` each time the matched lane label changed. */
  laneHistory: Array<[number, string | null]>;
  complexity: string | null;
  reopens: number;
  reopenTimes: number[];
  /** Every close (ms), oldest first; `closedAtMs` is the last. */
  closeTimes: number[];
  followUps: FollowUpRef[];
  timelineEtag: string | null;
  events: number;
  fetchedAtMs: number;
}

export interface PrRecord {
  repo: string;
  number: number;
  title: string;
  headRef: string | null;
  mergedAtMs: number | null;
  issues: number[];
  codeLines: number | null;
  testLines: number | null;
  docLines: number | null;
  codeFiles: number | null;
  /** The code files' paths (null until the PR's files are fetched). */
  codePaths: string[] | null;
  filesFetched: boolean;
  fetchedAtMs: number;
}

export interface CiRunRecord {
  repo: string;
  runId: number;
  workflow: string | null;
  event: string | null;
  headBranch: string | null;
  headSha: string | null;
  status: string | null;
  conclusion: string | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  prNumbers: number[];
  logsParsed: boolean;
}

/** One failed job's parsed log. */
export interface CiJobRecord {
  repo: string;
  runId: number;
  jobId: number;
  /**
   * Failing unit ids (`shell:`, `test:`, `bun:`, `eslint:`, `lint:`, `tsc:`).
   */
  units: string[];
  /** The log passed the download cap; units come from its first part. */
  truncated: boolean;
  /** The log is gone (expired or deleted): parsed as having no units. */
  logMissing: boolean;
  /** The run's creation time (the catch's time). */
  createdAtMs: number | null;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** ` AND repo IN (?, …)` for a repo list (its values bind first), else "". */
function repoFilter(repos: readonly string[] | undefined): string {
  if (!repos) return "";
  return ` AND repo IN (${repos.map(() => "?").join(", ")})`;
}

function issueFromRow(r: Record<string, unknown>): IssueFactsRecord {
  return {
    repo: String(r.repo),
    number: Number(r.number),
    title: String(r.title ?? ""),
    state: String(r.state ?? ""),
    stateReason: (r.state_reason as string | null) ?? null,
    createdAtMs: (r.created_at_ms as number | null) ?? null,
    closedAtMs: (r.closed_at_ms as number | null) ?? null,
    updatedAtMs: (r.updated_at_ms as number | null) ?? null,
    labels: parseJson<string[]>(r.labels_json, []),
    milestones: parseJson<Record<string, number>>(r.milestones_json, {}),
    lane: (r.lane as string | null) ?? null,
    laneFirst: (r.lane_first as string | null) ?? null,
    laneHistory: parseJson<Array<[number, string | null]>>(
      r.lane_history_json,
      []
    ),
    complexity: (r.complexity as string | null) ?? null,
    reopens: Number(r.reopens ?? 0),
    reopenTimes: parseJson<number[]>(r.reopens_json, []),
    closeTimes: parseJson<number[]>(r.closes_json, []),
    followUps: parseJson<FollowUpRef[]>(r.follow_ups_json, []),
    timelineEtag: (r.timeline_etag as string | null) ?? null,
    events: Number(r.events ?? 0),
    fetchedAtMs: Number(r.fetched_at_ms ?? 0),
  };
}

function prFromRow(r: Record<string, unknown>, issues: number[]): PrRecord {
  const n = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    repo: String(r.repo),
    number: Number(r.number),
    title: String(r.title ?? ""),
    headRef: (r.head_ref as string | null) ?? null,
    mergedAtMs: n(r.merged_at_ms),
    issues,
    codeLines: n(r.code_lines),
    testLines: n(r.test_lines),
    docLines: n(r.doc_lines),
    codeFiles: n(r.code_files),
    codePaths:
      typeof r.code_paths_json === "string"
        ? parseJson<string[]>(r.code_paths_json, [])
        : null,
    filesFetched: r.files_fetched === 1,
    fetchedAtMs: Number(r.fetched_at_ms ?? 0),
  };
}

function runFromRow(r: Record<string, unknown>): CiRunRecord {
  return {
    repo: String(r.repo),
    runId: Number(r.run_id),
    workflow: (r.workflow as string | null) ?? null,
    event: (r.event as string | null) ?? null,
    headBranch: (r.head_branch as string | null) ?? null,
    headSha: (r.head_sha as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    conclusion: (r.conclusion as string | null) ?? null,
    createdAtMs: (r.created_at_ms as number | null) ?? null,
    updatedAtMs: (r.updated_at_ms as number | null) ?? null,
    prNumbers: parseJson<number[]>(r.pr_numbers_json, []),
    logsParsed: r.logs_parsed === 1,
  };
}

export class ThroughputGithubStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now
  ) {}

  // ─────────────────────────── issues ───────────────────────────

  upsertIssue(rec: IssueFactsRecord): void {
    this.db
      .prepare(
        `INSERT INTO throughput_issue_facts (
           repo, number, title, state, state_reason, created_at_ms, closed_at_ms,
           updated_at_ms, labels_json, milestones_json, lane, lane_first,
           lane_history_json, complexity, reopens, reopens_json, closes_json,
           follow_ups_json, timeline_etag, events, fetched_at_ms
         ) VALUES (
           @repo, @number, @title, @state, @reason, @created, @closed,
           @updated, @labels, @milestones, @lane, @laneFirst,
           @laneHistory, @complexity, @reopens, @reopenTimes, @closeTimes,
           @followUps, @etag, @events, @fetched
         )
         ON CONFLICT (repo, number) DO UPDATE SET
           title = excluded.title, state = excluded.state,
           state_reason = excluded.state_reason,
           created_at_ms = excluded.created_at_ms,
           closed_at_ms = excluded.closed_at_ms,
           updated_at_ms = excluded.updated_at_ms,
           labels_json = excluded.labels_json,
           milestones_json = excluded.milestones_json,
           lane = excluded.lane, lane_first = excluded.lane_first,
           lane_history_json = excluded.lane_history_json,
           complexity = excluded.complexity, reopens = excluded.reopens,
           reopens_json = excluded.reopens_json,
           closes_json = excluded.closes_json,
           follow_ups_json = excluded.follow_ups_json,
           timeline_etag = excluded.timeline_etag, events = excluded.events,
           fetched_at_ms = excluded.fetched_at_ms`
      )
      .run({
        repo: rec.repo,
        number: rec.number,
        title: rec.title,
        state: rec.state,
        reason: rec.stateReason,
        created: rec.createdAtMs,
        closed: rec.closedAtMs,
        updated: rec.updatedAtMs,
        labels: JSON.stringify(rec.labels),
        milestones: JSON.stringify(rec.milestones),
        lane: rec.lane,
        laneFirst: rec.laneFirst,
        laneHistory: JSON.stringify(rec.laneHistory),
        complexity: rec.complexity,
        reopens: rec.reopens,
        reopenTimes: JSON.stringify(rec.reopenTimes),
        closeTimes: JSON.stringify(rec.closeTimes),
        followUps: JSON.stringify(rec.followUps),
        etag: rec.timelineEtag,
        events: rec.events,
        fetched: rec.fetchedAtMs,
      });
  }

  getIssue(repo: string, number: number): IssueFactsRecord | null {
    const row = this.db
      .prepare(
        "SELECT * FROM throughput_issue_facts WHERE repo = ? AND number = ?"
      )
      .get(repo, number) as Record<string, unknown> | undefined;
    return row ? issueFromRow(row) : null;
  }

  /** Issues closed in `[fromMs, toMs)`, newest close first, paged. */
  listClosedIssues(
    fromMs: number,
    toMs: number,
    offset = 0,
    limit = 10_000
  ): { rows: IssueFactsRecord[]; total: number } {
    const params = { from: fromMs, to: toMs };
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS c FROM throughput_issue_facts
            WHERE closed_at_ms >= $from AND closed_at_ms < $to`
        )
        .get(params) as { c: number }
    ).c;
    const rows = this.db
      .prepare(
        `SELECT * FROM throughput_issue_facts
          WHERE closed_at_ms >= $from AND closed_at_ms < $to
          ORDER BY closed_at_ms DESC, repo ASC, number ASC
          LIMIT $limit OFFSET $offset`
      )
      .all({ ...params, limit, offset }) as Array<Record<string, unknown>>;
    return { total, rows: rows.map(issueFromRow) };
  }

  /**
   * Issues closed at or after `sinceMs` (an epoch-ms cutoff, not a window
   * length), newest close first. The daily re-check uses `listClosedAfter`.
   */
  listRecentlyClosed(sinceMs: number, limit: number): IssueFactsRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM throughput_issue_facts
            WHERE closed_at_ms >= ? ORDER BY closed_at_ms DESC LIMIT ?`
        )
        .all(sinceMs, limit) as Array<Record<string, unknown>>
    ).map(issueFromRow);
  }

  /**
   * One repo's issues closed at or after `sinceMs`, after the resume point
   * `(closedAtMs, number)`, oldest close first (the re-check cursor).
   */
  listClosedAfter(
    repo: string,
    sinceMs: number,
    after: { closedAtMs: number; number: number } | null,
    limit: number
  ): IssueFactsRecord[] {
    const a = after ?? { closedAtMs: sinceMs, number: -1 };
    return (
      this.db
        .prepare(
          `SELECT * FROM throughput_issue_facts
            WHERE repo = $repo AND closed_at_ms >= $since
              AND (closed_at_ms > $at OR (closed_at_ms = $at AND number > $n))
            ORDER BY closed_at_ms ASC, number ASC LIMIT $limit`
        )
        .all({
          repo,
          since: sinceMs,
          at: Math.max(a.closedAtMs, sinceMs),
          n: a.closedAtMs < sinceMs ? -1 : a.number,
          limit,
        }) as Array<Record<string, unknown>>
    ).map(issueFromRow);
  }

  // ─────────────────────────── pull requests ───────────────────────────

  upsertPr(rec: PrRecord): void {
    const ins = this.db.prepare(
      `INSERT INTO throughput_prs (
         repo, number, title, head_ref, merged_at_ms, code_lines, test_lines,
         doc_lines, code_files, code_paths_json, files_fetched, fetched_at_ms
       ) VALUES (
         @repo, @number, @title, @head, @merged, @code, @test,
         @doc, @files, @paths, @fetchedFiles, @fetched
       )
       ON CONFLICT (repo, number) DO UPDATE SET
         title = excluded.title, head_ref = excluded.head_ref,
         merged_at_ms = excluded.merged_at_ms,
         code_lines = COALESCE(excluded.code_lines, throughput_prs.code_lines),
         test_lines = COALESCE(excluded.test_lines, throughput_prs.test_lines),
         doc_lines = COALESCE(excluded.doc_lines, throughput_prs.doc_lines),
         code_files = COALESCE(excluded.code_files, throughput_prs.code_files),
         code_paths_json = COALESCE(excluded.code_paths_json, throughput_prs.code_paths_json),
         files_fetched = MAX(excluded.files_fetched, throughput_prs.files_fetched),
         fetched_at_ms = excluded.fetched_at_ms`
    );
    const delLinks = this.db.prepare(
      "DELETE FROM throughput_pr_issues WHERE repo = ? AND pr = ?"
    );
    const insLink = this.db.prepare(
      `INSERT INTO throughput_pr_issues (repo, pr, issue) VALUES (?, ?, ?)
       ON CONFLICT DO NOTHING`
    );
    const apply = this.db.transaction(() => {
      ins.run({
        repo: rec.repo,
        number: rec.number,
        title: rec.title,
        head: rec.headRef,
        merged: rec.mergedAtMs,
        code: rec.codeLines,
        test: rec.testLines,
        doc: rec.docLines,
        files: rec.codeFiles,
        paths: rec.codePaths === null ? null : JSON.stringify(rec.codePaths),
        fetchedFiles: rec.filesFetched ? 1 : 0,
        fetched: rec.fetchedAtMs,
      });
      delLinks.run(rec.repo, rec.number);
      for (const issue of rec.issues) insLink.run(rec.repo, rec.number, issue);
    });
    apply.immediate();
  }

  getPr(repo: string, number: number): PrRecord | null {
    const row = this.db
      .prepare("SELECT * FROM throughput_prs WHERE repo = ? AND number = ?")
      .get(repo, number) as Record<string, unknown> | undefined;
    if (!row) return null;
    return prFromRow(row, this.issuesOfPr(repo, number));
  }

  /**
   * Merged PRs still missing their file stats (oldest merge first), of
   * `repos` when given. The repo filter sits inside the query so a repo whose
   * PRs wait cannot fill the limit (#6164 round 2).
   */
  listPrsNeedingFiles(limit: number, repos?: readonly string[]): PrRecord[] {
    if (repos?.length === 0) return [];
    const rows = this.db
      .prepare(
        `SELECT * FROM throughput_prs
          WHERE files_fetched = 0 AND merged_at_ms IS NOT NULL${repoFilter(repos)}
          ORDER BY merged_at_ms ASC LIMIT ?`
      )
      .all(...(repos ?? []), limit) as Array<Record<string, unknown>>;
    return rows.map(r =>
      prFromRow(r, this.issuesOfPr(String(r.repo), Number(r.number)))
    );
  }

  /** Merged PRs (with their issues) of one issue. */
  prsOfIssue(repo: string, issue: number): PrRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM throughput_pr_issues l
           JOIN throughput_prs p ON p.repo = l.repo AND p.number = l.pr
          WHERE l.repo = ? AND l.issue = ?
          ORDER BY p.number ASC`
      )
      .all(repo, issue) as Array<Record<string, unknown>>;
    return rows.map(r =>
      prFromRow(r, this.issuesOfPr(String(r.repo), Number(r.number)))
    );
  }

  /** Merged PRs per repo in `[fromMs, toMs)`. */
  countMergedPrs(fromMs: number, toMs: number): Map<string, number> {
    const out = new Map<string, number>();
    const rows = this.db
      .prepare(
        `SELECT repo, COUNT(*) AS c FROM throughput_prs
          WHERE merged_at_ms >= ? AND merged_at_ms < ?
          GROUP BY repo`
      )
      .all(fromMs, toMs) as Array<{ repo: string; c: number }>;
    for (const r of rows) out.set(r.repo, r.c);
    return out;
  }

  private issuesOfPr(repo: string, pr: number): number[] {
    return (
      this.db
        .prepare(
          "SELECT issue FROM throughput_pr_issues WHERE repo = ? AND pr = ? ORDER BY issue"
        )
        .all(repo, pr) as Array<{ issue: number }>
    ).map(r => r.issue);
  }

  // ─────────────────────────── CI ───────────────────────────

  upsertCiRun(run: CiRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO throughput_ci_runs (
           repo, run_id, workflow, event, head_branch, head_sha, status,
           conclusion, created_at_ms, updated_at_ms, pr_numbers_json, logs_parsed
         ) VALUES (
           @repo, @run, @workflow, @event, @branch, @sha, @status,
           @conclusion, @created, @updated, @prs, @parsed
         )
         ON CONFLICT (repo, run_id) DO UPDATE SET
           workflow = excluded.workflow, event = excluded.event,
           head_branch = excluded.head_branch, head_sha = excluded.head_sha,
           status = excluded.status, conclusion = excluded.conclusion,
           created_at_ms = excluded.created_at_ms,
           updated_at_ms = excluded.updated_at_ms,
           pr_numbers_json = excluded.pr_numbers_json,
           logs_parsed = MAX(excluded.logs_parsed, throughput_ci_runs.logs_parsed)`
      )
      .run({
        repo: run.repo,
        run: run.runId,
        workflow: run.workflow,
        event: run.event,
        branch: run.headBranch,
        sha: run.headSha,
        status: run.status,
        conclusion: run.conclusion,
        created: run.createdAtMs,
        updated: run.updatedAtMs,
        prs: JSON.stringify(run.prNumbers),
        parsed: run.logsParsed ? 1 : 0,
      });
  }

  /**
   * Completed failed runs whose job logs have not been parsed yet, of `repos`
   * when given (filtered inside the query, like `listPrsNeedingFiles`).
   */
  listRunsNeedingLogs(limit: number, repos?: readonly string[]): CiRunRecord[] {
    if (repos?.length === 0) return [];
    return (
      this.db
        .prepare(
          `SELECT * FROM throughput_ci_runs
            WHERE conclusion = 'failure' AND logs_parsed = 0${repoFilter(repos)}
            ORDER BY created_at_ms DESC LIMIT ?`
        )
        .all(...(repos ?? []), limit) as Array<Record<string, unknown>>
    ).map(runFromRow);
  }

  /** The failed jobs of one run whose logs were already parsed. */
  parsedJobIds(repo: string, runId: number): Set<number> {
    return new Set(
      (
        this.db
          .prepare(
            "SELECT job_id FROM throughput_ci_jobs WHERE repo = ? AND run_id = ?"
          )
          .all(repo, runId) as Array<{ job_id: number }>
      ).map(r => r.job_id)
    );
  }

  /** Record one parsed job and its failing units (one transaction, idempotent). */
  recordJob(job: CiJobRecord): void {
    const insJob = this.db.prepare(
      `INSERT INTO throughput_ci_jobs (
         repo, job_id, run_id, units, truncated, log_missing, created_at_ms,
         parsed_at_ms
       ) VALUES (@repo, @job, @run, @units, @truncated, @missing, @created, @now)
       ON CONFLICT (repo, job_id) DO NOTHING`
    );
    const insCatch = this.db.prepare(
      `INSERT INTO throughput_ci_catches (repo, run_id, job_id, unit, created_at_ms)
       VALUES (@repo, @run, @job, @unit, @created)
       ON CONFLICT DO NOTHING`
    );
    const apply = this.db.transaction(() => {
      insJob.run({
        repo: job.repo,
        job: job.jobId,
        run: job.runId,
        units: job.units.length,
        truncated: job.truncated ? 1 : 0,
        missing: job.logMissing ? 1 : 0,
        created: job.createdAtMs,
        now: this.now(),
      });
      for (const unit of job.units) {
        insCatch.run({
          repo: job.repo,
          run: job.runId,
          job: job.jobId,
          unit,
          created: job.createdAtMs,
        });
      }
    });
    apply.immediate();
  }

  /** Mark a run's failed-job logs as all parsed. */
  markRunParsed(repo: string, runId: number): void {
    this.db
      .prepare(
        "UPDATE throughput_ci_runs SET logs_parsed = 1 WHERE repo = ? AND run_id = ?"
      )
      .run(repo, runId);
  }

  /** Runs of one repo created in `[fromMs, toMs)`, oldest first. */
  listRuns(repo: string, fromMs: number, toMs: number): CiRunRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM throughput_ci_runs
            WHERE repo = ? AND created_at_ms >= ? AND created_at_ms < ?
            ORDER BY created_at_ms ASC`
        )
        .all(repo, fromMs, toMs) as Array<Record<string, unknown>>
    ).map(runFromRow);
  }

  /** The last run of one repo created before `beforeMs` on `branch` (trunk state at window start). */
  lastRunBefore(
    repo: string,
    branch: string,
    beforeMs: number
  ): CiRunRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM throughput_ci_runs
          WHERE repo = ? AND head_branch = ? AND event = 'push'
            AND created_at_ms < ? AND conclusion IS NOT NULL
          ORDER BY created_at_ms DESC LIMIT 1`
      )
      .get(repo, branch, beforeMs) as Record<string, unknown> | undefined;
    return row ? runFromRow(row) : null;
  }

  /** CI failing units in `[fromMs, toMs)`: catches, first and last seen. */
  ciCatches(
    fromMs: number,
    toMs: number
  ): Array<{
    unit: string;
    catches: number;
    firstMs: number | null;
    lastMs: number | null;
  }> {
    return (
      this.db
        .prepare(
          `SELECT unit, COUNT(*) AS c, MIN(created_at_ms) AS first_ms,
                  MAX(created_at_ms) AS last_ms
             FROM throughput_ci_catches
            WHERE created_at_ms >= ? AND created_at_ms < ?
            GROUP BY unit`
        )
        .all(fromMs, toMs) as Array<Record<string, unknown>>
    ).map(r => ({
      unit: String(r.unit),
      catches: Number(r.c ?? 0),
      firstMs: (r.first_ms as number | null) ?? null,
      lastMs: (r.last_ms as number | null) ?? null,
    }));
  }

  /** Drop CI rows older than `beforeMs` (runs keep their catches' lifetime). */
  pruneCiBefore(beforeMs: number): number {
    let removed = 0;
    const apply = this.db.transaction(() => {
      removed += this.db
        .prepare("DELETE FROM throughput_ci_catches WHERE created_at_ms < ?")
        .run(beforeMs).changes;
      removed += this.db
        .prepare("DELETE FROM throughput_ci_runs WHERE created_at_ms < ?")
        .run(beforeMs).changes;
      this.db
        .prepare("DELETE FROM throughput_ci_jobs WHERE created_at_ms < ?")
        .run(beforeMs);
    });
    apply.immediate();
    return removed;
  }

  getState(key: string): string | null {
    return readThroughputState(this.db, key);
  }

  setState(key: string, value: string): void {
    writeThroughputState(this.db, key, value, this.now());
  }
}
