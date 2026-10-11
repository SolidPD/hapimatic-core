// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from "hono";
import { z } from "zod";
import { defineCapability } from "@hapi/protocol";
import type { WebAppEnv } from "../../web/middleware/auth";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";
import { cataloged } from "../../capabilities/cataloged";
import { resolveRepoIdentity, isGitRepo } from "../../utils/repoIdentity";
import { expandTilde, isTildePath } from "../../utils/expandTilde";
import { GITHUB_REASON_MESSAGE } from "@hapi/protocol/githubFailureReason";
import {
  fetchGitHubAccounts,
  fetchGitHubRepos,
  runGhWithBunSpawn,
  type GitHubFetchDeps,
} from "../../utils/githubCli";
import {
  fetchIssueViaRest,
  listOpenIssuesViaRest,
  resolveGitHubToken,
} from "../../utils/githubRest";
import {
  fetchIssueViaBroker,
  listOpenIssuesViaBroker,
  resolveGithubBrokerConfig,
} from "../../utils/githubBrokerClient";

/**
 * `GITHUB_REASON_MESSAGE` — short human text for each failure reason (#2327) —
 * now lives in `shared/src/githubFailureReason.ts` (#2391).
 *
 * It was defined here as a local literal while the web client kept its OWN copy
 * (`REASON_TEXT`) of the same enum→prose mapping. This map was exhaustively typed
 * and the client's was not, so adding a reason broke this build (correctly) while
 * silently degrading the client to generic copy. Both now key off one shared list.
 * The `reason` enum remains the machine-readable contract the client branches on;
 * this string is the prose for surfaces that only render `error`.
 */

const issueParamsSchema = z.object({
  owner: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/),
  repo: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/),
  number: z.coerce.number().int().min(1),
});

// Issue #1953 (A6): the GitHub-account selector validates the `account` query
// param the same way the issue routes validate owner/repo names.
const accountParamsSchema = z.object({
  account: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/),
});

/**
 * Fetch GitHub issue details using the gh CLI.
 * This runs server-side where the gh CLI is authenticated,
 * allowing access to private repos.
 */
interface GitHubIssueResult {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: Array<{ name: string; color: string }>;
  body: string;
}

const issueCache = new Map<
  string,
  { data: GitHubIssueResult; timestamp: number }
>();
const ISSUE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ISSUE_CACHE_MAX_SIZE = 500;

async function fetchIssueWithGhCli(
  owner: string,
  repo: string,
  number: number,
  errorLogger?: ErrorLogger | null
): Promise<GitHubIssueResult | null> {
  const cacheKey = `${owner}/${repo}#${number}`;
  const cached = issueCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ISSUE_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const proc = Bun.spawn(
      [
        "gh",
        "issue",
        "view",
        String(number),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "number,title,state,labels,body",
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    const [exitCode, stdoutText, stderrText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    // #2327: a non-zero exit must NOT short-circuit — it falls through to the
    // REST fallback below, exactly like a thrown (missing-binary) invocation.
    if (exitCode === 0) {
      const data = JSON.parse(stdoutText);
      // gh CLI returns uppercase state ("OPEN"/"CLOSED") — normalize to lowercase
      const rawState = String(data.state).toLowerCase();
      // gh CLI returns labels as [{ name, color, ... }] — color is 6-char hex without #
      const labels = Array.isArray(data.labels)
        ? data.labels.map((l: { name: string; color: string }) => ({
            name: l.name,
            color: l.color,
          }))
        : [];
      const result: GitHubIssueResult = {
        number: data.number,
        title: data.title,
        state: rawState === "closed" ? "closed" : "open",
        labels,
        body: data.body ?? "",
      };
      // Evict oldest entry if cache is at capacity
      if (issueCache.size >= ISSUE_CACHE_MAX_SIZE) {
        const oldestKey = issueCache.keys().next().value;
        if (oldestKey) issueCache.delete(oldestKey);
      }
      issueCache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    }
    console.error(`[GitHub] gh issue view failed: ${stderrText}`);
  } catch (error) {
    if (errorLogger) {
      errorLogger.warn("[GitHub] Failed to fetch issue", {
        category: "github-fetch-issue",
        stack: error instanceof Error ? error.stack : null,
        context: { owner, repo, number },
      });
    } else {
      console.error("[GitHub] Failed to fetch issue:", error);
    }
  }

  // #2327: `gh` did not produce the issue (on a cloud VM it is not installed at
  // all). Fall back to the token-backed REST transport. Same contract as the gh
  // path — `null` on failure — so the route's existing `success: false` /404
  // envelope is unchanged; this commit adds a transport, not a contract.
  const token = resolveGitHubToken();
  if (!token) {
    // #3013: no local token — broker fallback for a provisioned VM. Non-broker hosts keep
    // the pre-#3013 behavior (null → the route's existing 404). This helper is not
    // dependency-injected (it spawns `gh` inline), so the broker call uses the process env
    // + global fetch, exactly like the REST branch below.
    if (!resolveGithubBrokerConfig()) return null;
    const broker = await fetchIssueViaBroker(owner, repo, number);
    if (!broker.ok) {
      errorLogger?.warn("[GitHub] Failed to fetch issue via broker", {
        category: "github-fetch-issue",
        context: { owner, repo, number, brokerReason: broker.reason },
      });
      return null;
    }
    const brokerState = broker.data.state.toLowerCase();
    const brokerResult: GitHubIssueResult = {
      number: broker.data.number,
      title: broker.data.title,
      state: brokerState === "closed" ? "closed" : "open",
      labels: broker.data.labels,
      body: broker.data.body,
    };
    if (issueCache.size >= ISSUE_CACHE_MAX_SIZE) {
      const oldestKey = issueCache.keys().next().value;
      if (oldestKey) issueCache.delete(oldestKey);
    }
    issueCache.set(cacheKey, { data: brokerResult, timestamp: Date.now() });
    return brokerResult;
  }
  const rest = await fetchIssueViaRest(token, owner, repo, number);
  if (!rest.ok) {
    errorLogger?.warn("[GitHub] Failed to fetch issue via REST", {
      category: "github-fetch-issue",
      context: { owner, repo, number, restReason: rest.reason },
    });
    return null;
  }
  const restState = rest.data.state.toLowerCase();
  const restResult: GitHubIssueResult = {
    number: rest.data.number,
    title: rest.data.title,
    state: restState === "closed" ? "closed" : "open",
    labels: rest.data.labels,
    body: rest.data.body,
  };
  if (issueCache.size >= ISSUE_CACHE_MAX_SIZE) {
    const oldestKey = issueCache.keys().next().value;
    if (oldestKey) issueCache.delete(oldestKey);
  }
  issueCache.set(cacheKey, { data: restResult, timestamp: Date.now() });
  return restResult;
}

/** One row of the repo-issue list the Link Issue field consumes. */
interface RepoIssueListItem {
  number: number;
  title: string;
  labels: string[];
  state: "open" | "closed";
}

/**
 * List a repo's open issues, trying `gh` first and the token-backed REST
 * transport second (#2327).
 *
 * Returns `null` on total failure, which the route maps onto its EXISTING
 * `success: false` response — this function adds a transport, it does not
 * change the route's contract. `repoName` is pre-validated `owner/repo`.
 */
export async function listOpenIssues(
  repoName: string,
  errorLogger?: ErrorLogger | null,
  deps: GitHubFetchDeps = {}
): Promise<RepoIssueListItem[] | null> {
  // #2391: injectable seams, matching `fetchGitHubAccounts` / `fetchGitHubRepos`.
  // Both transports here were previously unreachable from a test — `Bun.spawn` was
  // called inline and the REST call used the global `fetch` — so the transport
  // agreement AC-4 demands could not be asserted at all. Defaults are the real
  // implementations, so the single production call site is unchanged.
  const runGh = deps.runGh ?? runGhWithBunSpawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;

  const normalize = (
    number: number,
    title: string,
    labels: string[],
    state: string
  ): RepoIssueListItem => ({
    number,
    title,
    labels,
    state: state.toLowerCase() === "closed" ? "closed" : "open",
  });

  try {
    const {
      code: exitCode,
      stdout: stdoutText,
      stderr: stderrText,
    } = await runGh([
      "gh",
      "issue",
      "list",
      "--repo",
      repoName,
      "--json",
      "number,title,labels,state",
      "--state",
      "open",
      "--limit",
      "200",
    ]);
    if (exitCode === 0) {
      const raw = JSON.parse(stdoutText) as Array<{
        number: number;
        title: string;
        labels: Array<{ name: string }>;
        state: string;
      }>;
      return raw.map(i =>
        normalize(
          i.number,
          i.title,
          i.labels.map(l => l.name),
          String(i.state)
        )
      );
    }
    // Fall through to REST rather than returning — #2327.
    console.error(`[GitHub] gh issue list failed: ${stderrText}`);
  } catch (error) {
    if (errorLogger) {
      errorLogger.warn("[GitHub] Failed to list issues", {
        category: "github-list-issues",
        stack: error instanceof Error ? error.stack : null,
        context: { repo: repoName },
      });
    } else {
      console.error("[GitHub] Failed to list issues:", error);
    }
  }

  const token = resolveGitHubToken(env);
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) return null;
  if (!token) {
    // #3013: no local token — broker fallback for a provisioned VM (injected env/fetch).
    // Non-broker hosts keep the pre-#3013 behavior (null → the route's `success: false`).
    if (!resolveGithubBrokerConfig(env)) return null;
    const broker = await listOpenIssuesViaBroker(owner, repo, env, fetchImpl);
    if (!broker.ok) {
      errorLogger?.warn("[GitHub] Failed to list issues via broker", {
        category: "github-list-issues",
        context: { repo: repoName, brokerReason: broker.reason },
      });
      return null;
    }
    return broker.data.map(i =>
      normalize(
        i.number,
        i.title,
        i.labels.map(l => l.name),
        i.state
      )
    );
  }
  const rest = await listOpenIssuesViaRest(token, owner, repo, fetchImpl);
  if (!rest.ok) {
    errorLogger?.warn("[GitHub] Failed to list issues via REST", {
      category: "github-list-issues",
      context: { repo: repoName, restReason: rest.reason },
    });
    return null;
  }
  return rest.data.map(i =>
    normalize(
      i.number,
      i.title,
      i.labels.map(l => l.name),
      i.state
    )
  );
}

/**
 * #3558: the hub's view of a federation peer directory's git-ness. A current
 * peer reports its rev-parse result, so hub→node and node-local agree. A STALE
 * peer omits the field → fall back to "a forge identity implies git, else
 * unknown". A missing field is never coerced to `false`: unknown must not
 * force simple (F25).
 */
export function remoteDirectoryIsGitRepo(
  reported: boolean | undefined,
  hasForgeIdentity: boolean
): boolean | undefined {
  if (typeof reported === "boolean") return reported;
  return hasForgeIdentity ? true : undefined;
}

export function createGitHubRoutes(options?: {
  getNodeRegistry?: () => NodeRegistry | null;
  errorLogger?: ErrorLogger | null;
}): Hono<WebAppEnv> {
  const errorLogger = options?.errorLogger ?? null;
  const app = new Hono<WebAppEnv>();

  /**
   * GET /github/issues/:owner/:repo/:number
   * Fetches issue details from GitHub using authenticated gh CLI
   */
  app.get(
    "/github/issues/:owner/:repo/:number",
    cataloged(
      defineCapability({
        id: "harness-admin.github-get-issue",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Fetch one GitHub issue by owner/repo/number for the extension.",
        whenToUse: "When the user opens a specific GitHub issue.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/github/issues/:owner/:repo/:number",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const params = {
        owner: c.req.param("owner"),
        repo: c.req.param("repo"),
        number: c.req.param("number"),
      };

      const parsed = issueParamsSchema.safeParse(params);
      if (!parsed.success) {
        return c.json({ success: false, error: "Invalid parameters" }, 400);
      }

      const { owner, repo, number } = parsed.data;
      const issue = await fetchIssueWithGhCli(owner, repo, number, errorLogger);

      if (!issue) {
        return c.json(
          { success: false, error: `Issue #${number} not found` },
          404
        );
      }

      return c.json({
        success: true,
        issue,
      });
    }
  );

  /**
   * GET /github/repo-issues?dir=/path/to/project
   * GET /github/repo-issues?repo=owner/repo
   * Lists open GitHub issues for a repo. Accepts either a directory path
   * (resolves repo from git remote) or a direct owner/repo name.
   */
  app.get(
    "/github/repo-issues",
    cataloged(
      defineCapability({
        id: "harness-admin.github-repo-issues",
        domain: "harness-admin",
        surface: "rest",
        description: "List a repo's GitHub issues for the extension.",
        whenToUse: "When the user browses a repo's issues.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/github/repo-issues",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const dir = c.req.query("dir");
      const repoParam = c.req.query("repo");

      if (!dir && !repoParam) {
        return c.json(
          {
            success: false,
            error: "Missing 'dir' or 'repo' query parameter",
            repo: null,
            issues: [],
          },
          400
        );
      }

      let repoName: string;
      // Issue #2270 (F25): true git-ness of the selected directory, threaded into
      // every response shape below so the web Git-Type control can tri-state.
      // `undefined` = unknown (repo-by-name, or a remote dir with no forge origin
      // we can't rev-parse) ⇒ the client does NOT force a default.
      let directoryIsGitRepo: boolean | undefined;

      if (repoParam) {
        if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoParam)) {
          return c.json(
            {
              success: false,
              error: "Invalid repo format, expected owner/repo",
              repo: null,
              issues: [],
            },
            400
          );
        }
        repoName = repoParam;
      } else {
        // #3558: a tilde path (`~` / `~/…`, the form a clone-on-spawn recent
        // is stored in) is accepted alongside an absolute one and expanded to
        // the TARGET node's home below. `~user` and relative paths keep the 400.
        if (!dir!.startsWith("/") && !isTildePath(dir!)) {
          return c.json(
            {
              success: false,
              error: "Invalid directory path",
              repo: null,
              issues: [],
            },
            400
          );
        }

        // Federation: if nodeId is provided, detect git repo on remote node
        const nodeId = c.req.query("nodeId");
        let identity: ReturnType<typeof resolveRepoIdentity>;

        if (nodeId) {
          const registry = options?.getNodeRegistry?.();
          if (!registry) {
            return c.json({
              success: false,
              error: "Federation not available",
              repo: null,
              issues: [],
            });
          }
          // #3558 (D3(a)): pre-expand a tilde with the node's advertised home
          // when the hub knows it; otherwise forward it raw — a current peer
          // expands it with its own home (the authority).
          const nodeHome = isTildePath(dir!)
            ? registry.getNodeSummaries().find(n => n.nodeId === nodeId)
                ?.homeDir
            : undefined;
          const remoteDir = nodeHome ? expandTilde(dir!, nodeHome) : dir!;
          const result = await registry.resolveRepoIdentityOnNode(
            nodeId,
            remoteDir
          );
          if (result.type === "error") {
            return c.json({
              success: false,
              error: result.message,
              repo: null,
              issues: [],
            });
          }
          identity = result.repo
            ? { name: result.repo.name, url: result.repo.url }
            : undefined;
          directoryIsGitRepo = remoteDirectoryIsGitRepo(
            result.directoryIsGitRepo,
            identity != null
          );
        } else {
          const localDir = expandTilde(dir!);
          identity = resolveRepoIdentity(localDir);
          // Definitive local probe (rev-parse) — resolves the no-origin / git-init
          // case that `resolveRepoIdentity` (forge-origin only) cannot.
          directoryIsGitRepo = isGitRepo(localDir);
        }

        if (!identity) {
          return c.json({
            success: true,
            repo: null,
            issues: [],
            directoryIsGitRepo,
          });
        }
        repoName = identity.name;
      }

      // #2327: `gh` first, token-backed REST second. The response envelope below
      // is UNCHANGED — this route already reported failure honestly.
      const issues = await listOpenIssues(repoName, errorLogger);
      if (!issues) {
        return c.json({
          success: false,
          error: "Failed to fetch issues",
          repo: repoName,
          issues: [],
          directoryIsGitRepo,
        });
      }

      return c.json({
        success: true,
        repo: repoName,
        issues,
        directoryIsGitRepo,
      });
    }
  );

  /**
   * GET /github/accounts?nodeId=<optional>
   * Lists the host GitHub identity(ies) for the GitHub-account selector
   * (Issue #1953, A6). Federation-aware: for a remote spawn target, the account
   * is resolved on that node. NEVER returns the token (R11).
   *
   * #2327: a resolution failure now returns `{ success: false, reason, accounts: [] }`.
   * It previously returned a HARDCODED `success: true`, which made a hard
   * dependency failure (no `gh` binary on a cloud VM) structurally
   * indistinguishable from "this host has no accounts" — the client then
   * rendered the empty list as the assertion "No GitHub account connected".
   * The empty array is still present in the failure body so no existing client
   * can crash on a missing field. HTTP stays 200: this is a degraded-capability
   * signal, not a malformed request, and a non-2xx would trip the client's
   * `retry: 1` into pointless retries against a host that cannot succeed.
   */
  app.get(
    "/github/accounts",
    cataloged(
      defineCapability({
        id: "harness-admin.github-accounts",
        domain: "harness-admin",
        surface: "rest",
        description: "List the GitHub accounts available to the extension.",
        whenToUse: "When the user picks a GitHub account.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/github/accounts",
        },
        auth: "jwt",
        // #3837 R12 (never-readonly class): enumerates the configured GitHub
        // account identities — an identity/config read that must not be
        // generically auto-invocable (KD-1). [ER 2026-09-19: D17]
        riskTier: "mutating",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const nodeId = c.req.query("nodeId");
      if (nodeId) {
        const registry = options?.getNodeRegistry?.();
        if (!registry) {
          return c.json({
            success: false,
            error: "Federation not available",
            accounts: [],
          });
        }
        const result = await registry.listGitHubAccountsOnNode(nodeId);
        if (result.type === "error") {
          // The peer sends its reason enum as `message` (#2327).
          return c.json({
            success: false,
            error: result.message,
            reason: result.message,
            accounts: [],
          });
        }
        return c.json({ success: true, accounts: result.accounts });
      }

      const result = await fetchGitHubAccounts(errorLogger);
      if (!result.ok) {
        return c.json({
          success: false,
          error: GITHUB_REASON_MESSAGE[result.reason],
          reason: result.reason,
          accounts: [],
        });
      }
      return c.json({
        success: true,
        accounts: result.data,
        source: result.source,
      });
    }
  );

  /**
   * GET /github/repos?account=<login>&nodeId=<optional>
   * Lists repositories accessible to a host GitHub account (Issue #1953, A6).
   * Federation-aware (resolved on the spawn-target node for remote targets).
   * NEVER returns the token (R11).
   *
   * #2327: mirrors the accounts route — a resolution failure returns
   * `{ success: false, reason, repos: [] }` instead of a hardcoded
   * `success: true`, so "could not resolve" is distinguishable from "none".
   */
  app.get(
    "/github/repos",
    cataloged(
      defineCapability({
        id: "harness-admin.github-repos",
        domain: "harness-admin",
        surface: "rest",
        description: "List the GitHub repos available to the extension.",
        whenToUse: "When the user picks a repo.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/github/repos",
        },
        auth: "jwt",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    async c => {
      const parsed = accountParamsSchema.safeParse({
        account: c.req.query("account"),
      });
      if (!parsed.success) {
        return c.json(
          {
            success: false,
            error: "Invalid or missing 'account' parameter",
            account: null,
            repos: [],
          },
          400
        );
      }
      const { account } = parsed.data;
      const nodeId = c.req.query("nodeId");

      if (nodeId) {
        const registry = options?.getNodeRegistry?.();
        if (!registry) {
          return c.json({
            success: false,
            error: "Federation not available",
            account,
            repos: [],
          });
        }
        const result = await registry.listGitHubReposOnNode(nodeId, account);
        if (result.type === "error") {
          // The peer sends its reason enum as `message` (#2327).
          return c.json({
            success: false,
            error: result.message,
            reason: result.message,
            account,
            repos: [],
          });
        }
        return c.json({ success: true, account, repos: result.repos });
      }

      const result = await fetchGitHubRepos(account, errorLogger);
      if (!result.ok) {
        return c.json({
          success: false,
          error: GITHUB_REASON_MESSAGE[result.reason],
          reason: result.reason,
          account,
          repos: [],
        });
      }
      return c.json({
        success: true,
        account,
        repos: result.data,
        source: result.source,
      });
    }
  );

  return app;
}
