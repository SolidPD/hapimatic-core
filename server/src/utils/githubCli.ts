// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorLogger } from "../logging/errorLogger";
import type { GitHubFailureReason } from "@hapi/protocol/githubFailureReason";
import type { GitHubConnectionStatus } from "@hapi/protocol/githubConnection";
import type { GitHubRepo } from "@hapi/protocol/githubRepo";
import {
  REST_PER_PAGE,
  REST_REPO_LIMIT,
  collectWritableRepos,
  fetchAccountViaRest,
  fetchReposViaRest,
  resolveGitHubToken,
  selfReposPath,
  type FetchImpl,
} from "./githubRest";
import {
  fetchAccountsViaBroker,
  fetchReposViaBroker,
  resolveGithubBrokerConfig,
} from "./githubBrokerClient";

/**
 * GitHub account/repo resolution for the GitHub-account → repo selector
 * (Issue #1953 A6; transport reworked by #2327).
 *
 * 🔴 There is NO GitHub OAuth on the VM. On a host with `gh` or a `GH_TOKEN` the
 * "account" is that host identity; on a cloud VM it is a GitHub account the user
 * linked on hapimatic.com, whose per-user GitHub App token lives on the GATEWAY
 * (#4793) and never reaches the VM. Either way the token is NEVER returned to the
 * web client or threaded into a spawned agent's environment (R11). Shared between
 * the local route (`extensions/github-issues/routes.ts`) and the federation
 * receiver (`web/routes/federation/infrastructure.ts`).
 *
 * ## Three transports, in a fixed order (#2327, #3013)
 *
 * 1. **`gh` CLI** — the original path, tried FIRST on RP1 and every federation
 *    peer. For the signed-in identity it lists repositories through `gh api
 *    /user/repos` (the endpoint the other two transports use), so organization and
 *    collaborator repositories appear; any other account keeps `gh repo list`
 *    (#6312). Every transport keeps only repositories the account may push to,
 *    up to the shared {@link REST_REPO_LIMIT}.
 * 2. **GitHub REST** (`githubRest.ts`) — used only when `gh` fails and a
 *    `GH_TOKEN` is set (CI, operator hosts).
 * 3. **The gateway read broker** (`githubBrokerClient.ts`) — used only when there
 *    is no token AND the host is provisioned for the broker (a cloud VM). It lists
 *    every account the VM's users linked (#4793), default first.
 *
 * The order is load-bearing (CLAUDE.md → "🔴 Fallback Preservation Rule"): each
 * later transport AUGMENTS the earlier ones, it does not replace them.
 *
 * ## Why the fallbacks exist
 *
 * A provisioned cloud VM has the `gh` binary (`scripts/provision.sh` installs it
 * from the `cli.github.com` apt source) but no GitHub credential, by design:
 * #2672 D999-10 keeps every GitHub token off the VM (`FORBIDDEN_VM_ENV_KEYS` in
 * `gateway/src/lib/vmEnvFile.ts`). So `gh api user` fails there, and before #2327
 * these helpers returned `[]` and the caller reported `success: true` — making a
 * hard dependency failure indistinguishable from "this account has no repos".
 *
 * ## Failure is now representable
 *
 * These functions return a discriminated {@link GitHubFetchResult} instead of a
 * bare array, so a caller can tell "resolution failed, here is why" from "there
 * genuinely are none". Distinct causes MUST stay distinct reasons — `no_token`
 * and `token_rejected` call for different operator actions (install a token vs.
 * replace a bad one), so they are never collapsed.
 */

/** A host GitHub identity surfaced to the GitHub-account selector. */
export interface GitHubAccountResult {
  login: string;
  name: string | null;
  /** #4793, broker only: the Hapimatic user (email) who linked this account on hapimatic.com. */
  email?: string;
  /** #4793, broker only: that user's default account (listed first). */
  isDefault?: boolean;
  /** #4793, broker only: the link's status (an install hint for `not_installed`, re-link for the rest). */
  status?: GitHubConnectionStatus;
  /**
   * #6085, broker only: GitHub did not confirm `status` in time, so it may be out of date.
   * Present only when true; an older gateway never sends it.
   */
  statusUnchecked?: boolean;
  /**
   * #5973, broker only: the account logins the Hapimatic GitHub App is installed on that this link
   * could see when hapimatic.com last read them (a snapshot, not live). Absent when never read or
   * from an older gateway; an empty array means installed nowhere.
   */
  installedOn?: string[];
}

/**
 * A repository accessible to a host GitHub account. Defined once in `shared/` (#6326) so
 * the server, the federation proxy and the web cannot drift; re-exported under the name
 * the server modules already import.
 */
export type GitHubRepoResult = GitHubRepo;

/** Which transport produced a successful result. */
export type GitHubFetchSource = "gh" | "rest" | "broker";

/**
 * Why resolution failed. Each value maps to a distinct operator action, so they
 * are deliberately NOT collapsed into a single generic failure.
 *
 * 🔴 DEFINED IN `shared/`, NOT HERE (#2391). The enum used to be declared in this
 * file while its human-readable text lived in two OTHER files with asymmetric type
 * safety — the server's map was exhaustive, the web client's was
 * `Record<string, string>` and therefore silently driftable. Re-exported (rather
 * than redeclared) so every consumer resolves to one list; see
 * `shared/src/githubFailureReason.ts` for the full rationale.
 */
export type { GitHubFailureReason };

export type GitHubFetchResult<T> =
  | {
      ok: true;
      data: T[];
      source: GitHubFetchSource;
      /**
       * #6326, repo listings only: the listing stopped at {@link REST_REPO_LIMIT} with more
       * repositories available. Absent on account lists.
       */
      truncated?: boolean;
    }
  | { ok: false; reason: GitHubFailureReason };

/** One `gh` invocation's outcome. A missing binary THROWS rather than exiting. */
export interface GhInvocation {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injectable `gh` runner — the single seam where a subprocess is spawned. */
export type GhRunner = (argv: string[]) => Promise<GhInvocation>;

/** Dependencies a test can override; all default to the real implementations. */
export interface GitHubFetchDeps {
  runGh?: GhRunner;
  fetchImpl?: FetchImpl;
  env?: Record<string, string | undefined>;
}

/**
 * Default runner. Throws `Executable not found in $PATH` when `gh` is absent.
 *
 * Exported (#2391) so the issue-list path in
 * `extensions/github-issues/routes.ts` — which used to call `Bun.spawn` inline and
 * was therefore untestable — can share the SAME default while accepting an
 * injected runner. The transport-parity contract test needs both transports
 * drivable to assert they agree.
 */
export const runGhWithBunSpawn: GhRunner = async argv => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

interface CacheEntry<T> {
  data: T[];
  timestamp: number;
  source: GitHubFetchSource;
  /** #6326: kept with the listing so a cache hit still reports it. */
  truncated?: boolean;
}

const accountCache = new Map<string, CacheEntry<GitHubAccountResult>>();
const repoCache = new Map<string, CacheEntry<GitHubRepoResult>>();

// Accounts/repos change rarely within a session; a short TTL keeps the selector
// snappy without holding stale data for long.
const GH_CACHE_TTL_MS = 60 * 1000;
const GH_CACHE_MAX_SIZE = 100;
const ACCOUNT_CACHE_KEY = "__host__";

/**
 * #4793: on a broker-provisioned cloud VM `gh` is installed but never signed in, and the broker's
 * account list is not cached, so every account read would first spawn a failing `gh api user`
 * (~0.2 s and a journal line). There, and only there, that failure is remembered for one TTL: `gh`
 * is still retried once a minute, so a later `gh auth login` wins within a minute (Fallback
 * Preservation), while the broker read itself stays fresh.
 */
let brokerHostGhFailure: {
  reason: GitHubFailureReason;
  timestamp: number;
} | null = null;

/** Read a live cache entry, or null when absent/expired. */
function readCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string
): CacheEntry<T> | null {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.timestamp < GH_CACHE_TTL_MS) return hit;
  return null;
}

/**
 * Store a SUCCESS in the cache, evicting the oldest entry at capacity.
 *
 * Only successes are ever cached: caching a failure would pin the degraded state
 * for a full TTL, so a transient GitHub outage would keep reporting "unavailable"
 * for a minute after it recovered.
 */
function writeCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  data: T[],
  source: GitHubFetchSource,
  truncated = false
): void {
  if (cache.size >= GH_CACHE_MAX_SIZE && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now(), source, truncated });
}

/** Classify a THROWN `gh` invocation — a missing binary is the #2327 case. */
function classifyGhThrow(error: unknown): GitHubFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/executable not found|enoent|no such file/i.test(message)) {
    return "gh_missing";
  }
  return "unknown";
}

/**
 * Classify a NON-ZERO `gh` exit from its stderr.
 *
 * #6312: `gh api` reports GitHub's own HTTP failures ("Bad credentials (HTTP 401)",
 * "API rate limit exceeded … (HTTP 403)"), which the original auth-wording regex
 * did not recognise, so they read as `unknown` and then as `no_token`.
 */
function classifyGhExit(stderr: string): GitHubFailureReason {
  if (/auth login|not logged in|gh auth|authentication/i.test(stderr)) {
    return "gh_unauthenticated";
  }
  if (/HTTP 401|Bad credentials/i.test(stderr)) {
    return "gh_unauthenticated";
  }
  if (/rate limit/i.test(stderr)) {
    return "rate_limited";
  }
  return "unknown";
}

/**
 * Pick the reason to report when `gh` failed AND no token is configured.
 *
 * `gh_unauthenticated` is kept because it is strictly more actionable ("run
 * `gh auth login`") than the generic absence of a token, and `rate_limited`
 * because installing a token would not repair a throttled one (#6312). Every
 * other `gh` failure — notably the missing-binary cloud-VM case — reports
 * `no_token`, since installing a token is what actually repairs that host.
 */
function reasonWhenNoToken(ghReason: GitHubFailureReason): GitHubFailureReason {
  if (ghReason === "gh_unauthenticated" || ghReason === "rate_limited") {
    return ghReason;
  }
  return "no_token";
}

/**
 * Ask `gh` which identity it is signed in as (`gh api user`), caching a success
 * under {@link ACCOUNT_CACHE_KEY} with `source: "gh"`.
 *
 * The ONE writer of a `gh`-sourced identity (#6312): the account route
 * ({@link fetchGitHubAccounts}) and the repo route ({@link resolveGhLogin}) share
 * it, so a Create page that loads accounts first leaves the repo route a warm cache.
 */
async function runGhIdentity(
  runGh: GhRunner
): Promise<
  | { ok: true; account: GitHubAccountResult }
  | { ok: false; reason: GitHubFailureReason }
> {
  try {
    const { code, stdout, stderr } = await runGh([
      "gh",
      "api",
      "user",
      "--jq",
      "{login: .login, name: .name}",
    ]);
    if (code === 0) {
      const parsed = JSON.parse(stdout) as {
        login?: string;
        name?: string | null;
      };
      if (parsed?.login) {
        const account: GitHubAccountResult = {
          login: parsed.login,
          name: parsed.name ?? null,
        };
        writeCache(accountCache, ACCOUNT_CACHE_KEY, [account], "gh");
        return { ok: true, account };
      }
      return { ok: false, reason: "unknown" };
    }
    console.error(`[GitHub] gh api user failed: ${stderr}`);
    return { ok: false, reason: classifyGhExit(stderr) };
  } catch (error) {
    return { ok: false, reason: classifyGhThrow(error) };
  }
}

/** True while a broker-provisioned host's last `gh` identity failure is still remembered. */
function brokerHostGhFailureIsLive(
  env: Record<string, string | undefined>
): boolean {
  return (
    resolveGithubBrokerConfig(env) !== null &&
    brokerHostGhFailure !== null &&
    Date.now() - brokerHostGhFailure.timestamp < GH_CACHE_TTL_MS
  );
}

/**
 * The login `gh` is signed in as, or null when it cannot be resolved.
 *
 * Trusts the account cache ONLY when its entry came from `gh`: a `rest` entry is a
 * `GH_TOKEN` identity that may differ from the `gh` login, and a `broker` entry lists
 * linked accounts rather than the host identity (#6312).
 */
async function resolveGhLogin(
  runGh: GhRunner,
  env: Record<string, string | undefined>
): Promise<string | null> {
  const cached = readCache(accountCache, ACCOUNT_CACHE_KEY);
  if (cached?.source === "gh" && cached.data[0]) return cached.data[0].login;
  if (brokerHostGhFailureIsLive(env)) return null;
  const identity = await runGhIdentity(runGh);
  if (identity.ok) return identity.account.login;
  if (resolveGithubBrokerConfig(env) !== null) {
    brokerHostGhFailure = { reason: identity.reason, timestamp: Date.now() };
  }
  return null;
}

/**
 * Resolve the authenticated login for the REST repo path, preferring a warm
 * cache entry so the common case costs no extra request.
 *
 * 🔴 A FAILURE HERE IS PROPAGATED — IT USED TO BE SWALLOWED (#2384 defect 2 /
 * #2391). The old code returned `{ ok: true, login: null }` for any failure that
 * was not `token_rejected`. That `null` made `isSelf` false in
 * {@link fetchReposViaRest}, which selects the PUBLIC `/users/{account}/repos`
 * endpoint — so a transient `GET /user` failure produced
 * `{ ok: true, data: [...] }` with **every private repo missing and no marker**.
 * GitHub hides unauthorized private resources by omission (it answers 200 with
 * them absent, or 404 — never 403), so nothing downstream could detect it. A
 * caller cannot distinguish "you have no private repos" from "we silently
 * downgraded you to the public view".
 *
 * 🔴 DO NOT "RESTORE" THE NULL FALLBACK. The legitimately-not-self case is still
 * fully supported and is a DIFFERENT condition: when `GET /user` SUCCEEDS and the
 * login simply differs from `account` (an org, another user), `isSelf` is false
 * and the public endpoint is the correct, intended choice. What is removed is only
 * "we could not determine the identity, so pretend it is someone else" — an
 * unknown identity is a failure, not a public account.
 */
async function resolveAuthenticatedLogin(
  token: string,
  fetchImpl: FetchImpl
): Promise<
  { ok: true; login: string } | { ok: false; reason: GitHubFailureReason }
> {
  const cached = readCache(accountCache, ACCOUNT_CACHE_KEY);
  if (cached && cached.data[0]) {
    return { ok: true, login: cached.data[0].login };
  }
  const result = await fetchAccountViaRest(token, fetchImpl);
  if (result.ok) return { ok: true, login: result.data.login };
  return { ok: false, reason: result.reason };
}

/**
 * List the host GitHub identity for the account selector.
 *
 * Tries `gh api user`, then the token-backed REST `GET /user`. NEVER returns a
 * token. A failure yields a reason rather than an empty list, so the caller can
 * distinguish "could not resolve" from "none".
 */
export async function fetchGitHubAccounts(
  errorLogger?: ErrorLogger | null,
  deps: GitHubFetchDeps = {}
): Promise<GitHubFetchResult<GitHubAccountResult>> {
  const runGh = deps.runGh ?? runGhWithBunSpawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;

  const cached = readCache(accountCache, ACCOUNT_CACHE_KEY);
  if (cached) return { ok: true, data: cached.data, source: cached.source };

  let ghReason: GitHubFailureReason;
  const brokerHost = resolveGithubBrokerConfig(env) !== null;
  const rememberedGhFailure =
    brokerHost && brokerHostGhFailureIsLive(env) ? brokerHostGhFailure : null;
  if (rememberedGhFailure) {
    ghReason = rememberedGhFailure.reason;
  } else {
    const identity = await runGhIdentity(runGh);
    if (identity.ok) {
      return { ok: true, data: [identity.account], source: "gh" };
    }
    ghReason = identity.reason;
    if (brokerHost) {
      brokerHostGhFailure = { reason: ghReason, timestamp: Date.now() };
    }
  }

  // `gh` did not produce an identity — fall through to the REST transport.
  const token = resolveGitHubToken(env);
  if (!token) {
    // #3013: no local token. If this host is provisioned for the gateway read broker (a
    // cloud VM post-#2672), fall through to the broker — a THIRD transport that needs no
    // VM-resident credential. A non-broker host (RP1 / CI / dev) has no broker config, so
    // it keeps the pre-#3013 no-token behavior byte-unchanged (Fallback Preservation Rule).
    if (resolveGithubBrokerConfig(env)) {
      // #4793: every account the VM's users linked, default first. An empty list is a success
      // (`source: "broker"` tells the Create page to offer "Connect GitHub"), never an outage.
      // NOT cached: the list changes on hapimatic.com (link, unlink, default, install), and a
      // user who just linked GitHub returns here expecting to see it, not a minute-old "none".
      // The read is one gateway round trip; the web query's own staleTime bounds the rate.
      const broker = await fetchAccountsViaBroker(env, fetchImpl);
      if (broker.ok) {
        return { ok: true, data: broker.data, source: "broker" };
      }
      errorLogger?.warn("[GitHub] Account resolution via broker failed", {
        category: "github-fetch-accounts",
        context: { ghReason, brokerReason: broker.reason },
      });
      return { ok: false, reason: broker.reason };
    }
    errorLogger?.warn("[GitHub] Account resolution unavailable", {
      category: "github-fetch-accounts",
      context: { ghReason, restAttempted: false },
    });
    return { ok: false, reason: reasonWhenNoToken(ghReason) };
  }

  const rest = await fetchAccountViaRest(token, fetchImpl);
  if (!rest.ok) {
    errorLogger?.warn("[GitHub] Failed to fetch accounts", {
      category: "github-fetch-accounts",
      context: { ghReason, restReason: rest.reason },
    });
    return { ok: false, reason: rest.reason };
  }

  const accounts = [rest.data];
  writeCache(accountCache, ACCOUNT_CACHE_KEY, accounts, "rest");
  return { ok: true, data: accounts, source: "rest" };
}

/**
 * The signed-in `gh` identity's full repository set (#6312): every repository it
 * owns, collaborates on, or reaches through organization membership, through the
 * same `/user/repos` endpoint and mapping the REST transport uses.
 *
 * Explicit `page=N` calls rather than `gh api --paginate`: `--paginate` has no
 * ceiling, and its output shape is not consistent across `gh` versions. A failed
 * or unparseable page fails the WHOLE listing — pages already read are never
 * returned as a success (#2391 completeness rule). A missing `gh` binary throws.
 */
async function fetchSelfReposViaGh(runGh: GhRunner): Promise<
  | {
      ok: true;
      data: GitHubRepoResult[];
      permissionsMissing: boolean;
      truncated: boolean;
    }
  | { ok: false; stderr: string }
> {
  const data: GitHubRepoResult[] = [];
  let permissionsMissing = false;
  let truncated = false;
  const maxPages = Math.ceil(REST_REPO_LIMIT / REST_PER_PAGE);
  for (let page = 1; page <= maxPages; page++) {
    const { code, stdout, stderr } = await runGh([
      "gh",
      "api",
      selfReposPath(page),
    ]);
    if (code !== 0) return { ok: false, stderr };
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { ok: false, stderr: "gh api returned unparseable output" };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, stderr: "gh api returned a non-array payload" };
    }
    const pageResult = collectWritableRepos(parsed);
    if (!pageResult.permissionsReported) permissionsMissing = true;
    data.push(...pageResult.repos);
    if (pageResult.rawCount < REST_PER_PAGE) break;
    // The last page we may read came back full: there may be more past the ceiling.
    if (page === maxPages) truncated = true;
  }
  if (data.length > REST_REPO_LIMIT) truncated = true;
  return {
    ok: true,
    data: data.slice(0, REST_REPO_LIMIT),
    permissionsMissing,
    truncated,
  };
}

/** `viewerPermission` values that cannot push; anything else, or no value, is kept (#6312). */
const GH_NO_PUSH_PERMISSIONS = new Set(["READ", "TRIAGE", "NONE"]);

/**
 * `gh repo list <account>`: the repositories OWNED by `account`. Correct for an
 * account other than the signed-in identity, and the owned-only fallback when the
 * full listing is unavailable. A missing `gh` binary throws.
 */
async function listOwnedReposViaGh(
  runGh: GhRunner,
  account: string
): Promise<
  | { ok: true; data: GitHubRepoResult[]; truncated: boolean }
  | { ok: false; stderr: string }
> {
  const { code, stdout, stderr } = await runGh([
    "gh",
    "repo",
    "list",
    account,
    "--json",
    "nameWithOwner,name,description,isPrivate,pushedAt,createdAt,isArchived,isFork,defaultBranchRef,viewerPermission",
    "--limit",
    String(REST_REPO_LIMIT),
  ]);
  if (code !== 0) return { ok: false, stderr };
  const raw = JSON.parse(stdout) as Array<{
    nameWithOwner: string;
    name: string;
    description: string | null;
    isPrivate: boolean;
    pushedAt: string | null;
    createdAt?: string | null;
    isArchived?: boolean;
    isFork?: boolean;
    defaultBranchRef?: { name?: string } | null;
    viewerPermission?: string | null;
  }>;
  const repos: GitHubRepoResult[] = raw
    .filter(
      r =>
        !r.viewerPermission || !GH_NO_PUSH_PERMISSIONS.has(r.viewerPermission)
    )
    .map(r => {
      const repo: GitHubRepoResult = {
        nameWithOwner: r.nameWithOwner,
        name: r.name,
        description: r.description ?? null,
        isPrivate: Boolean(r.isPrivate),
        pushedAt: r.pushedAt ?? null,
        defaultBranch: r.defaultBranchRef?.name || null,
      };
      // #6326: same rule as the REST mapper — copy a field only when gh reported it.
      if (typeof r.createdAt === "string") repo.createdAt = r.createdAt;
      if (typeof r.isArchived === "boolean") repo.isArchived = r.isArchived;
      if (typeof r.isFork === "boolean") repo.isFork = r.isFork;
      return repo;
    });
  // `--limit` caps the RAW rows gh returns, so a full raw list may have stopped at the ceiling
  // even when the push filter left fewer (#6326).
  return { ok: true, data: repos, truncated: raw.length >= REST_REPO_LIMIT };
}

/**
 * Warn when a successful listing hit the shared ceiling. Driven by the transport's own
 * `truncated` flag (#6326): a row count cannot tell, because the push filter can leave a
 * truncated listing under the limit.
 */
function warnIfAtCeiling(
  errorLogger: ErrorLogger | null | undefined,
  account: string,
  source: GitHubFetchSource,
  count: number,
  truncated: boolean
): void {
  if (!truncated) return;
  errorLogger?.warn("[GitHub] Repo list hit the shared ceiling", {
    category: "github-list-repos",
    context: { account, source, count, limit: REST_REPO_LIMIT },
  });
}

/**
 * List repositories accessible to a host GitHub account, keeping only those it may
 * push to.
 *
 * The `gh` transport (#6312):
 * - **the signed-in identity** — `/user/repos` through `gh api`, so organization and
 *   collaborator repositories are included (`gh repo list <login>` lists only the
 *   repositories the login OWNS, which is why they used to be missing);
 * - **another account** — `gh repo list <account>`, as before;
 * - **degraded** — when the identity cannot be resolved or the full listing fails,
 *   `gh repo list <account>` again, with a `warn` and WITHOUT caching, so the next
 *   request retries. RP1 has no token or broker to fall back to, and failing there
 *   would empty the picker; the owned-only list is never worse than before.
 *
 * Then the token-backed REST endpoints, then the gateway broker. `account` MUST be
 * pre-validated against `^[A-Za-z0-9._-]+$` by the caller (the routes do this) — it
 * is interpolated into the gh argv. NEVER returns a token.
 */
export async function fetchGitHubRepos(
  account: string,
  errorLogger?: ErrorLogger | null,
  deps: GitHubFetchDeps = {}
): Promise<GitHubFetchResult<GitHubRepoResult>> {
  const runGh = deps.runGh ?? runGhWithBunSpawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;

  const cached = readCache(repoCache, account);
  if (cached) {
    return {
      ok: true,
      data: cached.data,
      source: cached.source,
      truncated: cached.truncated === true,
    };
  }

  let ghReason: GitHubFailureReason;
  try {
    const ghLogin = await resolveGhLogin(runGh, env);
    const isSelf =
      ghLogin !== null && ghLogin.toLowerCase() === account.toLowerCase();
    let degradedReason: string | null =
      ghLogin === null ? "identity_unresolved" : null;

    if (isSelf) {
      const self = await fetchSelfReposViaGh(runGh);
      if (self.ok) {
        if (self.permissionsMissing) {
          errorLogger?.warn(
            "[GitHub] Repo listing carried no permissions; nothing was filtered",
            { category: "github-list-repos", context: { account } }
          );
        }
        warnIfAtCeiling(
          errorLogger,
          account,
          "gh",
          self.data.length,
          self.truncated
        );
        writeCache(repoCache, account, self.data, "gh", self.truncated);
        return {
          ok: true,
          data: self.data,
          source: "gh",
          truncated: self.truncated,
        };
      }
      console.error(`[GitHub] gh api /user/repos failed: ${self.stderr}`);
      degradedReason = `full_listing_failed:${classifyGhExit(self.stderr)}`;
    }

    const owned = await listOwnedReposViaGh(runGh, account);
    if (owned.ok) {
      if (degradedReason !== null) {
        // Owned repos only — organization and collaborator repos are missing. Not cached.
        errorLogger?.warn(
          "[GitHub] Full repo listing unavailable; returning owned repos only",
          {
            category: "github-list-repos",
            context: { account, reason: degradedReason },
          }
        );
        return {
          ok: true,
          data: owned.data,
          source: "gh",
          truncated: owned.truncated,
        };
      }
      warnIfAtCeiling(
        errorLogger,
        account,
        "gh",
        owned.data.length,
        owned.truncated
      );
      writeCache(repoCache, account, owned.data, "gh", owned.truncated);
      return {
        ok: true,
        data: owned.data,
        source: "gh",
        truncated: owned.truncated,
      };
    }
    console.error(`[GitHub] gh repo list failed: ${owned.stderr}`);
    ghReason = classifyGhExit(owned.stderr);
  } catch (error) {
    ghReason = classifyGhThrow(error);
  }

  const token = resolveGitHubToken(env);
  if (!token) {
    // #3013: no local token — broker fallback for a provisioned VM (see fetchGitHubAccounts).
    // The broker resolves the gateway credential's identity itself, so the VM does not need
    // the isSelf identity step below.
    if (resolveGithubBrokerConfig(env)) {
      const broker = await fetchReposViaBroker(account, env, fetchImpl);
      if (broker.ok) {
        const { repos, truncated } = broker.data;
        warnIfAtCeiling(
          errorLogger,
          account,
          "broker",
          repos.length,
          truncated
        );
        writeCache(repoCache, account, repos, "broker", truncated);
        return { ok: true, data: repos, source: "broker", truncated };
      }
      errorLogger?.warn("[GitHub] Repo resolution via broker failed", {
        category: "github-list-repos",
        context: { account, ghReason, brokerReason: broker.reason },
      });
      return { ok: false, reason: broker.reason };
    }
    errorLogger?.warn("[GitHub] Repo resolution unavailable", {
      category: "github-list-repos",
      context: { account, ghReason, restAttempted: false },
    });
    return { ok: false, reason: reasonWhenNoToken(ghReason) };
  }

  const login = await resolveAuthenticatedLogin(token, fetchImpl);
  if (!login.ok) {
    // #2384 defect 4: this was the ONLY failure arm in the file with no logger
    // call, so a rejected or rate-limited GH_TOKEN on the identity step produced
    // ZERO `error_logs` entries — the failure was invisible to the very
    // diagnostics an operator would reach for. Matches the shape of its siblings.
    errorLogger?.warn("[GitHub] Failed to resolve identity for repo listing", {
      category: "github-list-repos",
      context: { account, ghReason, restReason: login.reason },
    });
    return { ok: false, reason: login.reason };
  }

  const rest = await fetchReposViaRest(token, account, login.login, fetchImpl);
  if (!rest.ok) {
    errorLogger?.warn("[GitHub] Failed to list repos", {
      category: "github-list-repos",
      context: { account, ghReason, restReason: rest.reason },
    });
    return { ok: false, reason: rest.reason };
  }

  const { repos, truncated } = rest.data;
  warnIfAtCeiling(errorLogger, account, "rest", repos.length, truncated);
  writeCache(repoCache, account, repos, "rest", truncated);
  return { ok: true, data: repos, source: "rest", truncated };
}

/** Clear both caches. Test-only seam; not used by production code paths. */
export function __clearGitHubCachesForTest(): void {
  accountCache.clear();
  repoCache.clear();
  brokerHostGhFailure = null;
}
