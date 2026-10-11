// SPDX-License-Identifier: AGPL-3.0-only
import type { GitHubFailureReason } from "@hapi/protocol/githubFailureReason";
import type { GitHubAccountResult, GitHubRepoResult } from "./githubCli";

/**
 * Token-backed GitHub REST transport (issue #2327).
 *
 * 🔴 WHY THIS EXISTS: the GitHub account/repo/issue surface was implemented as a
 * shell-out to the host `gh` CLI (see `githubCli.ts`). A provisioned cloud VM is
 * deliberately built WITHOUT `gh` — `scripts/lib/provision-helpers.sh:73` annotates
 * it "RP1-side only — never on a user VM", and the VM's only `apt-get install`
 * (`scripts/provision.sh:426`) omits it. Verified live on the `matt-b` VM:
 * `command -v gh` → absent. So every `Bun.spawn(["gh", …])` on a cloud instance
 * throws `Executable not found in $PATH`, the caller swallowed it into an empty
 * array, and the Create Session page rendered "No GitHub account connected" —
 * directly contradicting the user who had just connected GitHub in the wizard.
 *
 * This module is the transport that does NOT need a binary: it reads the
 * `GH_TOKEN` the gateway onboarding wizard already installs into the VM env
 * (`gateway/src/lib/wizardSteps.ts` → `GITHUB_ENV_KEY`) and calls api.github.com
 * directly. It is the FALLBACK, never the primary — `githubCli.ts` tries `gh`
 * first so RP1 and every federation peer keep their existing behavior byte for
 * byte (CLAUDE.md → "🔴 Fallback Preservation Rule").
 *
 * 🔴 SECURITY (R7): the token is never returned to a caller, never placed in a
 * thrown message, and never logged. `githubRequest` is the ONLY function that
 * sees it, and it returns a bare reason enum on failure — there is no code path
 * that can echo the credential outward.
 */

const GITHUB_API_BASE = "https://api.github.com";

/** Matches the `gh repo list --limit 200` ceiling the CLI path uses. */
const REST_REPO_LIMIT = 200;

/** Matches the `gh issue list --limit 200` ceiling the CLI path uses (#2391). */
const REST_ISSUE_LIMIT = 200;

/**
 * Request budget for {@link listOpenIssuesViaRest}.
 *
 * Two pages would cover {@link REST_ISSUE_LIMIT} if every row were an issue — but
 * this endpoint interleaves pull requests, which are filtered out AFTER the fetch,
 * so reaching 200 issues can take more than 200 raw rows. Five pages (500 raw rows)
 * gives real parity with `gh --limit 200` unless a repo's open items are >60% PRs,
 * while keeping the worst case bounded at five requests.
 */
const REST_ISSUE_MAX_PAGES = 5;

/** GitHub's max page size; two pages cover {@link REST_REPO_LIMIT}. */
const REST_PER_PAGE = 100;

/**
 * The reasons THIS transport can produce, as a subset of the shared enum.
 *
 * `satisfies readonly GitHubFailureReason[]` is load-bearing: it makes a typo or a
 * value the shared source does not define a compile error, so the REST layer and
 * the CLI layer can never disagree about the vocabulary (#2391). The three
 * `gh_*`/`no_token` reasons are deliberately absent — they describe the CLI
 * transport's failures, which this module cannot observe.
 */
export const REST_FAILURE_REASONS = [
  "token_rejected",
  "rate_limited",
  "forbidden",
  "network",
  "unknown",
] as const satisfies readonly GitHubFailureReason[];

/** Why a REST call failed. Deliberately coarse — never carries the token. */
export type GitHubRestFailureReason = (typeof REST_FAILURE_REASONS)[number];

export type GitHubRestResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: GitHubRestFailureReason };

/** Injectable `fetch` so tests can drive every branch without network access. */
export type FetchImpl = typeof fetch;

/**
 * Resolve the GitHub token from the process environment.
 *
 * `GH_TOKEN` is checked first because that is the exact key the gateway wizard
 * installs on a user VM; `GITHUB_TOKEN` is accepted as the widely-used alias so
 * a CI or self-hosted deployment works without extra configuration. An
 * all-whitespace value is treated as absent.
 */
export function resolveGitHubToken(
  env: Record<string, string | undefined> = process.env
): string | null {
  const raw = env.GH_TOKEN ?? env.GITHUB_TOKEN ?? null;
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Does this response carry GitHub's rate-limit signal?
 *
 * Per GitHub's own documentation, BOTH limit classes are signalled by headers
 * rather than by status alone:
 *   - primary limit → `x-ratelimit-remaining: 0` (+ `x-ratelimit-reset`)
 *   - secondary limit → `retry-after`, when present
 * See https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 *
 * 🔴 R7: reads exactly these two header NAMES and nothing else. The response's
 * body, its request, and the `Authorization` header stay unreachable from here.
 */
function isRateLimitSignalled(response: Response): boolean {
  if (response.headers.get("x-ratelimit-remaining") === "0") return true;
  return response.headers.get("retry-after") !== null;
}

/**
 * Classify a REST response into a failure reason, or `null` when it succeeded.
 *
 * 🔴 THE 403 IS OVERLOADED — THAT WAS THE BUG (#2384 defect 1). This function used
 * to be an inline `status === 401 || status === 403 → token_rejected`, which is
 * wrong three ways: GitHub returns 403 for a primary rate limit, for a secondary
 * rate limit, and for SAML-SSO-unauthorized orgs (403 + an `X-GitHub-SSO` header).
 * None of those is a bad token, yet the UI rendered "token rejected by GitHub", so
 * an operator would rotate a perfectly healthy token instead of waiting out a rate
 * limit. Only **401** means the credential itself was refused.
 *
 * Extracted as a named export so the transport-parity contract test can drive every
 * branch directly rather than inferring it from a fetch stub.
 */
export function classifyRestStatus(
  response: Response
): GitHubRestFailureReason | null {
  if (response.ok) return null;
  // 401 is the ONLY status that means "this credential was refused".
  if (response.status === 401) return "token_rejected";
  // 429 is unambiguous — Too Many Requests is always a rate limit.
  if (response.status === 429) return "rate_limited";
  // 403 is the ambiguous one: rate limit if the headers say so, else a genuine
  // permission/policy denial (SAML SSO, org policy, insufficient scope).
  if (response.status === 403) {
    return isRateLimitSignalled(response) ? "rate_limited" : "forbidden";
  }
  return "unknown";
}

/**
 * Issue ONE authenticated GitHub REST request.
 *
 * The token enters here and does not leave: a non-2xx yields a reason enum, and
 * a thrown fetch yields `network`. Nothing derived from the request headers is
 * ever returned or thrown (R7).
 */
async function githubRequest<T>(
  path: string,
  token: string,
  fetchImpl: FetchImpl
): Promise<GitHubRestResult<T>> {
  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hapimatic",
      },
    });
  } catch {
    // Deliberately swallow the thrown error: a fetch rejection can embed the
    // request (and therefore the Authorization header) in its message.
    return { ok: false, reason: "network" };
  }

  const failure = classifyRestStatus(response);
  if (failure) return { ok: false, reason: failure };

  try {
    return { ok: true, data: (await response.json()) as T };
  } catch {
    return { ok: false, reason: "unknown" };
  }
}

/** The `GET /user` payload fields this module consumes. */
interface RestUser {
  login?: string;
  name?: string | null;
}

/** The `GET /…/repos` payload fields this module consumes. */
interface RestRepo {
  full_name?: string;
  name?: string;
  description?: string | null;
  private?: boolean;
  pushed_at?: string | null;
  default_branch?: string | null;
}

/**
 * Resolve the authenticated identity behind `token` (`GET /user`).
 *
 * Returns the same shape the `gh api user` path produces, so a caller cannot
 * tell which transport served it.
 */
export async function fetchAccountViaRest(
  token: string,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubRestResult<GitHubAccountResult>> {
  const result = await githubRequest<RestUser>("/user", token, fetchImpl);
  if (!result.ok) return result;
  const login = result.data?.login;
  if (!login) return { ok: false, reason: "unknown" };
  return { ok: true, data: { login, name: result.data.name ?? null } };
}

/** Map one REST repository object onto the shared result shape. */
function mapRestRepo(raw: RestRepo): GitHubRepoResult | null {
  if (!raw?.full_name || !raw.name) return null;
  return {
    nameWithOwner: raw.full_name,
    name: raw.name,
    description: raw.description ?? null,
    isPrivate: Boolean(raw.private),
    pushedAt: raw.pushed_at ?? null,
    defaultBranch: raw.default_branch ?? null,
  };
}

/**
 * List the repositories accessible to `account` (`GET /user/repos` when it is
 * the authenticated identity — which is what includes private repos — otherwise
 * `GET /users/{account}/repos`).
 *
 * Pages until {@link REST_REPO_LIMIT} so the ceiling matches the `gh repo list
 * --limit 200` the CLI path uses; a short page ends pagination early.
 */
export async function fetchReposViaRest(
  token: string,
  account: string,
  authenticatedLogin: string | null,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubRestResult<GitHubRepoResult[]>> {
  const isSelf =
    authenticatedLogin !== null &&
    account.toLowerCase() === authenticatedLogin.toLowerCase();

  const repos: GitHubRepoResult[] = [];
  const maxPages = Math.ceil(REST_REPO_LIMIT / REST_PER_PAGE);

  for (let page = 1; page <= maxPages; page++) {
    const path = isSelf
      ? `/user/repos?per_page=${REST_PER_PAGE}&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`
      : `/users/${encodeURIComponent(account)}/repos?per_page=${REST_PER_PAGE}&page=${page}&sort=pushed`;

    const result = await githubRequest<RestRepo[]>(path, token, fetchImpl);
    if (!result.ok) return result;
    const pageItems = Array.isArray(result.data) ? result.data : [];
    for (const raw of pageItems) {
      const mapped = mapRestRepo(raw);
      if (mapped) repos.push(mapped);
    }
    // A short page means there is nothing left to fetch.
    if (pageItems.length < REST_PER_PAGE) break;
  }

  return { ok: true, data: repos.slice(0, REST_REPO_LIMIT) };
}

/** One issue, in the shape the issue routes already produce from `gh`. */
export interface RestIssueResult {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string; color: string }>;
  body: string;
}

/** The `GET /repos/…/issues` payload fields this module consumes. */
interface RestIssuePayload {
  number?: number;
  title?: string;
  state?: string;
  labels?: Array<{ name?: string; color?: string }>;
  body?: string | null;
  /**
   * Present ONLY on pull requests. GitHub's REST API models every PR as an
   * issue, so this key is how the two are told apart. See {@link
   * listOpenIssuesViaRest}.
   */
  pull_request?: unknown;
}

/** Map one REST issue payload onto the shared result shape. */
function mapRestIssue(raw: RestIssuePayload): RestIssueResult | null {
  if (typeof raw?.number !== "number" || typeof raw.title !== "string") {
    return null;
  }
  return {
    number: raw.number,
    title: raw.title,
    state: String(raw.state ?? "open"),
    labels: Array.isArray(raw.labels)
      ? raw.labels.map(l => ({ name: l.name ?? "", color: l.color ?? "" }))
      : [],
    body: raw.body ?? "",
  };
}

/** Fetch one issue by number (`GET /repos/{owner}/{repo}/issues/{number}`). */
export async function fetchIssueViaRest(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubRestResult<RestIssueResult>> {
  const result = await githubRequest<RestIssuePayload>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}`,
    token,
    fetchImpl
  );
  if (!result.ok) return result;
  const mapped = mapRestIssue(result.data);
  if (!mapped) return { ok: false, reason: "unknown" };
  return { ok: true, data: mapped };
}

/**
 * List a repository's OPEN issues (`GET /repos/{owner}/{repo}/issues`).
 *
 * 🔴 THE PULL-REQUEST FILTER IS LOAD-BEARING. GitHub's REST API treats **every
 * pull request as an issue**, so this endpoint returns PRs interleaved with
 * issues; `gh issue list` filters them out for you, this endpoint does not.
 * Dropping the `pull_request` guard below does not throw and does not log — it
 * silently fills the Link Issue picker with every open PR in the repo. That
 * quiet-wrong-data failure mode is exactly why it is pinned by a test with a
 * mixed fixture rather than left to code review.
 *
 * 🔴 PAGES TO {@link REST_ISSUE_LIMIT} (#2384 defect 3 / #2391). This used to be a
 * single `per_page=100` request with no loop, while the `gh` path uses
 * `--limit 200` and the sibling {@link fetchReposViaRest} already paged. On a
 * cloud VM (no `gh`), a repo with >100 open issues got a quietly half-populated
 * Link Issue picker reported as `ok: true` — a completeness failure that any
 * "did it return something" check passes.
 *
 * 🔴 AND THE LOOP BREAKS ON THE **RAW** PAGE LENGTH, NOT THE FILTERED COUNT. PRs
 * are removed AFTER the fetch, so a page of 60 issues + 40 PRs is a FULL page
 * (100 raw rows) that contributes only 60 items. Terminating on `issues.length`
 * would stop early and re-introduce the exact truncation being fixed, one layer
 * deeper and harder to see. {@link fetchReposViaRest} gets this right by testing
 * `pageItems.length`; this mirrors it.
 */
export async function listOpenIssuesViaRest(
  token: string,
  owner: string,
  repo: string,
  fetchImpl: FetchImpl = fetch
): Promise<GitHubRestResult<RestIssueResult[]>> {
  const issues: RestIssueResult[] = [];
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=${REST_PER_PAGE}`;

  for (let page = 1; page <= REST_ISSUE_MAX_PAGES; page++) {
    const result = await githubRequest<RestIssuePayload[]>(
      `${base}&page=${page}`,
      token,
      fetchImpl
    );
    if (!result.ok) return result;
    const rows = Array.isArray(result.data) ? result.data : [];
    for (const raw of rows) {
      // Skip pull requests — see the docblock above.
      if (raw?.pull_request !== undefined) continue;
      const mapped = mapRestIssue(raw);
      if (mapped) issues.push(mapped);
    }
    // A SHORT RAW page means the repo has nothing left — this is the only safe
    // termination signal. `rows.length`, never `issues.length` (see docblock).
    if (rows.length < REST_PER_PAGE) break;
    // Enough issues collected to match the `gh` ceiling; stop paging.
    if (issues.length >= REST_ISSUE_LIMIT) break;
  }

  return { ok: true, data: issues.slice(0, REST_ISSUE_LIMIT) };
}
