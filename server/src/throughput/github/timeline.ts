// SPDX-License-Identifier: AGPL-3.0-only
import { nextLink, type GithubClient } from "./client";

/**
 * Issue timelines, issue lists, merged PRs and PR files for the throughput
 * collector (issue #6164, A1 — R6, F10).
 *
 * Timelines are read COMPLETELY: every page of `per_page=100`, following
 * `Link: rel="next"`. An issue's label history routinely passes 100 events
 * (#4172 has 365 events, 121 of them label events), and both a REST first page
 * and GraphQL `timelineItems(first:100)` stop at 100. A partially read
 * timeline is never stored: a run that stops mid-issue retries it next run.
 *
 * `If-None-Match` is trusted only for a timeline that fit on one page: a later
 * page can change while page 1's ETag stays the same.
 *
 * This replaces nothing: `workflowReconcileService`'s private fetcher keeps
 * only label events, has no timeout and reads 30 per page.
 */

export interface TimelineSource {
  repo: string;
  number: number;
  title: string;
  createdAtMs: number | null;
  /** The first 2,000 characters of the referencing issue's body. */
  body: string;
  isPullRequest: boolean;
}

export interface TimelineEvent {
  event: string;
  createdAtMs: number | null;
  /** Label name, for `labeled` / `unlabeled`. */
  label?: string;
  /** The referencing issue, for `cross-referenced`. */
  source?: TimelineSource;
}

export type TimelineResult =
  | {
      kind: "ok";
      events: TimelineEvent[];
      etag: string | null;
      pages: number;
      /** Every event on the timeline, kept or not. */
      rawCount: number;
    }
  | { kind: "not_modified" }
  | { kind: "not_found" }
  | { kind: "incomplete" };

export interface IssueListItem {
  number: number;
  title: string;
  state: string;
  stateReason: string | null;
  createdAtMs: number | null;
  closedAtMs: number | null;
  updatedAtMs: number | null;
  labels: string[];
}

export interface PullListItem {
  number: number;
  title: string;
  body: string;
  headRef: string | null;
  mergedAtMs: number | null;
  updatedAtMs: number | null;
}

export interface PullFile {
  filename: string;
  changes: number;
}

const BODY_CAP = 2_000;

function ms(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `owner/repo` from an issue's `repository` object or `repository_url`. */
function repoOf(issue: Record<string, unknown>): string {
  const repository = issue.repository as { full_name?: unknown } | undefined;
  if (typeof repository?.full_name === "string") return repository.full_name;
  const url = str(issue.repository_url);
  const marker = "/repos/";
  const at = url.indexOf(marker);
  return at >= 0 ? url.slice(at + marker.length) : "";
}

export function parseTimelineEvent(raw: unknown): TimelineEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const event = str(e.event);
  if (!event) return null;
  const out: TimelineEvent = { event, createdAtMs: ms(e.created_at) };
  if (event === "labeled" || event === "unlabeled") {
    const label = (e.label as { name?: unknown } | undefined)?.name;
    if (typeof label !== "string") return null;
    out.label = label;
  } else if (event === "cross-referenced") {
    const source = e.source as { issue?: unknown } | undefined;
    const issue = source?.issue;
    if (!issue || typeof issue !== "object") return null;
    const i = issue as Record<string, unknown>;
    if (typeof i.number !== "number") return null;
    out.source = {
      repo: repoOf(i),
      number: i.number,
      title: str(i.title),
      createdAtMs: ms(i.created_at),
      body: str(i.body).slice(0, BODY_CAP),
      isPullRequest: i.pull_request !== undefined && i.pull_request !== null,
    };
  } else if (event !== "reopened" && event !== "closed") {
    return null; // other event types carry nothing A1 uses
  }
  return out;
}

/** Read one issue's whole timeline (conditionally, when `etag` is given). */
export async function fetchTimeline(
  client: GithubClient,
  repo: string,
  number: number,
  etag: string | null = null
): Promise<TimelineResult> {
  const first = await client.get(
    `/repos/${repo}/issues/${number}/timeline?per_page=100`,
    { etag }
  );
  if (first.kind === "not_modified") return { kind: "not_modified" };
  if (first.kind === "not_found") return { kind: "not_found" };
  if (first.kind !== "ok") return { kind: "incomplete" };
  const raw: unknown[] = Array.isArray(first.body) ? [...first.body] : [];
  let next = nextLink(first.link);
  let pages = 1;
  while (next) {
    const r = await client.get(next);
    if (r.kind !== "ok") return { kind: "incomplete" };
    pages += 1;
    if (Array.isArray(r.body)) raw.push(...r.body);
    next = nextLink(r.link);
  }
  const events = raw
    .map(parseTimelineEvent)
    .filter((e): e is TimelineEvent => e !== null);
  return { kind: "ok", events, etag: first.etag, pages, rawCount: raw.length };
}

/** One `/issues` list entry (an issue, never a PR), or null. */
export function parseIssueItem(raw: unknown): IssueListItem | null {
  if (!raw || typeof raw !== "object") return null;
  const i = raw as Record<string, unknown>;
  if (typeof i.number !== "number") return null;
  if (i.pull_request !== undefined && i.pull_request !== null) return null;
  const labels = Array.isArray(i.labels)
    ? i.labels
        .map(l => (typeof l === "string" ? l : (l as { name?: unknown })?.name))
        .filter((n): n is string => typeof n === "string")
    : [];
  return {
    number: i.number,
    title: str(i.title),
    state: str(i.state).toUpperCase(),
    stateReason:
      typeof i.state_reason === "string" ? i.state_reason.toUpperCase() : null,
    createdAtMs: ms(i.created_at),
    closedAtMs: ms(i.closed_at),
    updatedAtMs: ms(i.updated_at),
    labels,
  };
}

/** The `/issues` list of one repo updated at or after `sinceIso`, oldest update first. */
export function updatedIssuesUrl(repo: string, sinceIso: string): string {
  return `/repos/${repo}/issues?state=all&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(sinceIso)}`;
}

/** Issues (not PRs) updated at or after `sinceIso`, oldest update first. */
export async function fetchUpdatedIssues(
  client: GithubClient,
  repo: string,
  sinceIso: string,
  maxPages = 10
): Promise<{ issues: IssueListItem[]; complete: boolean }> {
  const r = await client.getAllPages(updatedIssuesUrl(repo, sinceIso), {
    maxPages,
  });
  return {
    issues: r.items
      .map(parseIssueItem)
      .filter((x): x is IssueListItem => x !== null),
    complete: r.complete,
  };
}

/** Closed PRs updated at or after `sinceMs`, newest first (the list stops there). */
export async function fetchRecentPulls(
  client: GithubClient,
  repo: string,
  sinceMs: number,
  maxPages = 10
): Promise<{ pulls: PullListItem[]; complete: boolean; notFound: boolean }> {
  const r = await client.getAllPages(
    `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
    {
      maxPages,
      until: page => {
        const last = page[page.length - 1] as
          | { updated_at?: unknown }
          | undefined;
        const t = ms(last?.updated_at);
        return page.length === 0 || (t !== null && t < sinceMs);
      },
    }
  );
  const pulls: PullListItem[] = [];
  for (const raw of r.items) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as Record<string, unknown>;
    if (typeof p.number !== "number") continue;
    const updated = ms(p.updated_at);
    if (updated !== null && updated < sinceMs) continue;
    pulls.push({
      number: p.number,
      title: str(p.title),
      body: str(p.body).slice(0, BODY_CAP),
      headRef: str((p.head as { ref?: unknown } | undefined)?.ref) || null,
      mergedAtMs: ms(p.merged_at),
      updatedAtMs: updated,
    });
  }
  return { pulls, complete: r.complete, notFound: r.notFound };
}

/**
 * A merged PR's files (additions + deletions per file), up to 3 pages (a PR
 * past 300 files keeps its first 300). Null when the client stopped mid-list.
 * "not_found": GitHub answered 404, for a deleted PR or for a repo the token
 * cannot read; the caller tells the two apart.
 */
export async function fetchPullFiles(
  client: GithubClient,
  repo: string,
  number: number
): Promise<PullFile[] | "not_found" | null> {
  const r = await client.getAllPages(
    `/repos/${repo}/pulls/${number}/files?per_page=100`,
    { maxPages: 3 }
  );
  if (r.notFound) return "not_found";
  if (!r.complete && client.stopKind !== null) return null;
  const files: PullFile[] = [];
  for (const raw of r.items) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.filename !== "string") continue;
    const add = typeof f.additions === "number" ? f.additions : 0;
    const del = typeof f.deletions === "number" ? f.deletions : 0;
    files.push({ filename: f.filename, changes: add + del });
  }
  return files;
}

/**
 * A repo's default branch (the trunk when none is configured), or null.
 * `notFound`: the repo answered 404 (missing, or not readable with this token).
 */
export async function fetchDefaultBranch(
  client: GithubClient,
  repo: string
): Promise<{ branch: string | null; notFound: boolean }> {
  const r = await client.get(`/repos/${repo}`);
  if (r.kind !== "ok") {
    return { branch: null, notFound: r.kind === "not_found" };
  }
  const branch = (r.body as { default_branch?: unknown } | null)
    ?.default_branch;
  return {
    branch: typeof branch === "string" && branch !== "" ? branch : null,
    notFound: false,
  };
}

/** Merged PRs of one repo in `[fromIso, toIso]` (the search API's count). */
export async function countMergedPulls(
  client: GithubClient,
  repo: string,
  fromIso: string,
  toIso: string
): Promise<number | null> {
  const q = `repo:${repo} is:pr is:merged merged:${fromIso}..${toIso}`;
  const r = await client.get(
    `/search/issues?per_page=1&q=${encodeURIComponent(q)}`
  );
  if (r.kind !== "ok") return null;
  const n = (r.body as { total_count?: unknown } | null)?.total_count;
  return typeof n === "number" ? n : null;
}
