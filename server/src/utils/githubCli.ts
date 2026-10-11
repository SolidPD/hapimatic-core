// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorLogger } from "../logging/errorLogger";
import type { GitHubFailureReason } from "@hapi/protocol/githubFailureReason";
import {
  fetchAccountViaRest,
  fetchReposViaRest,
  resolveGitHubToken,
  type FetchImpl,
} from "./githubRest";
import {
  fetchAccountViaBroker,
  fetchReposViaBroker,
  resolveGithubBrokerConfig,
} from "./githubBrokerClient";

/**
 * GitHub account/repo resolution for the GitHub-account → repo selector
 * (Issue #1953 A6; transport reworked by #2327).
 *
 * 🔴 There is NO GitHub OAuth in Hapimatic. The "account" is a host identity,
 * NOT an OAuth account, and the token is NEVER returned to the web client or
 * threaded into a spawned agent's environment (R11). Shared between the local
 * route (`extensions/github-issues/routes.ts`) and the federation receiver
 * (`web/routes/federation/infrastructure.ts`).
 *
 * ## Two transports, in a fixed order (#2327)
 *
 * 1. **`gh` CLI** — the original path. Tried FIRST so RP1 and every federation
 *    peer keep byte-identical behavior.
 * 2. **GitHub REST** (`githubRest.ts`) — the fallback, used only when `gh` fails.
 *    Authenticates with the `GH_TOKEN` the gateway wizard installs on a VM.
 *
 * The order is load-bearing (CLAUDE.md → "🔴 Fallback Preservation Rule"): the
 * new fast path AUGMENTS the existing one, it does not replace it.
 *
 * ## Why the fallback exists
 *
 * A provisioned cloud VM has no `gh` binary — by design invariant, not accident
 * (`scripts/lib/provision-helpers.sh:73`: "RP1-side only — never on a user VM";
 * the VM's only apt install at `scripts/provision.sh:426` omits it; verified
 * live on `matt-b`). Every `Bun.spawn(["gh", …])` there throws, so before #2327
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
}

/** A repository accessible to a host GitHub account. */
export interface GitHubRepoResult {
  nameWithOwner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  pushedAt: string | null;
  /** hapimatic-private#4481: the branch a clone lands on (optional — absent
   *  from transports that do not report it, e.g. an older broker). */
  defaultBranch?: string | null;
}

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
  | { ok: true; data: T[]; source: GitHubFetchSource }
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
}

const accountCache = new Map<string, CacheEntry<GitHubAccountResult>>();
const repoCache = new Map<string, CacheEntry<GitHubRepoResult>>();

// Accounts/repos change rarely within a session; a short TTL keeps the selector
// snappy without holding stale data for long.
const GH_CACHE_TTL_MS = 60 * 1000;
const GH_CACHE_MAX_SIZE = 100;
const ACCOUNT_CACHE_KEY = "__host__";

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
  source: GitHubFetchSource
): void {
  if (cache.size >= GH_CACHE_MAX_SIZE && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, { data, timestamp: Date.now(), source });
}

/** Classify a THROWN `gh` invocation — a missing binary is the #2327 case. */
function classifyGhThrow(error: unknown): GitHubFailureReason {
  const message = error instanceof Error ? error.message : String(error);
  if (/executable not found|enoent|no such file/i.test(message)) {
    return "gh_missing";
  }
  return "unknown";
}

/** Classify a NON-ZERO `gh` exit from its stderr. */
function classifyGhExit(stderr: string): GitHubFailureReason {
  if (/auth login|not logged in|gh auth|authentication/i.test(stderr)) {
    return "gh_unauthenticated";
  }
  return "unknown";
}

/**
 * Pick the reason to report when `gh` failed AND no token is configured.
 *
 * `gh_unauthenticated` is kept because it is strictly more actionable ("run
 * `gh auth login`") than the generic absence of a token. Every other `gh`
 * failure — notably the missing-binary cloud-VM case — reports `no_token`,
 * since installing a token is what actually repairs that host.
 */
function reasonWhenNoToken(ghReason: GitHubFailureReason): GitHubFailureReason {
  return ghReason === "gh_unauthenticated" ? "gh_unauthenticated" : "no_token";
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
        const accounts: GitHubAccountResult[] = [
          { login: parsed.login, name: parsed.name ?? null },
        ];
        writeCache(accountCache, ACCOUNT_CACHE_KEY, accounts, "gh");
        return { ok: true, data: accounts, source: "gh" };
      }
      ghReason = "unknown";
    } else {
      console.error(`[GitHub] gh api user failed: ${stderr}`);
      ghReason = classifyGhExit(stderr);
    }
  } catch (error) {
    ghReason = classifyGhThrow(error);
  }

  // `gh` did not produce an identity — fall through to the REST transport.
  const token = resolveGitHubToken(env);
  if (!token) {
    // #3013: no local token. If this host is provisioned for the gateway read broker (a
    // cloud VM post-#2672), fall through to the broker — a THIRD transport that needs no
    // VM-resident credential. A non-broker host (RP1 / CI / dev) has no broker config, so
    // it keeps the pre-#3013 no-token behavior byte-unchanged (Fallback Preservation Rule).
    if (resolveGithubBrokerConfig(env)) {
      const broker = await fetchAccountViaBroker(env, fetchImpl);
      if (broker.ok) {
        const accounts = [broker.data];
        writeCache(accountCache, ACCOUNT_CACHE_KEY, accounts, "broker");
        return { ok: true, data: accounts, source: "broker" };
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
 * List repositories accessible to a host GitHub account.
 *
 * Tries `gh repo list <account>`, then the token-backed REST repo endpoints.
 * `account` MUST be pre-validated against `^[A-Za-z0-9._-]+$` by the caller (the
 * routes do this) — it is interpolated into the gh argv. NEVER returns a token.
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
  if (cached) return { ok: true, data: cached.data, source: cached.source };

  let ghReason: GitHubFailureReason;
  try {
    const { code, stdout, stderr } = await runGh([
      "gh",
      "repo",
      "list",
      account,
      "--json",
      "nameWithOwner,name,description,isPrivate,pushedAt,defaultBranchRef",
      "--limit",
      "200",
    ]);
    if (code === 0) {
      const raw = JSON.parse(stdout) as Array<{
        nameWithOwner: string;
        name: string;
        description: string | null;
        isPrivate: boolean;
        pushedAt: string | null;
        defaultBranchRef?: { name?: string } | null;
      }>;
      const repos: GitHubRepoResult[] = raw.map(r => ({
        nameWithOwner: r.nameWithOwner,
        name: r.name,
        description: r.description ?? null,
        isPrivate: Boolean(r.isPrivate),
        pushedAt: r.pushedAt ?? null,
        defaultBranch: r.defaultBranchRef?.name || null,
      }));
      writeCache(repoCache, account, repos, "gh");
      return { ok: true, data: repos, source: "gh" };
    }
    console.error(`[GitHub] gh repo list failed: ${stderr}`);
    ghReason = classifyGhExit(stderr);
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
        writeCache(repoCache, account, broker.data, "broker");
        return { ok: true, data: broker.data, source: "broker" };
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

  writeCache(repoCache, account, rest.data, "rest");
  return { ok: true, data: rest.data, source: "rest" };
}

/** Clear both caches. Test-only seam; not used by production code paths. */
export function __clearGitHubCachesForTest(): void {
  accountCache.clear();
  repoCache.clear();
}
