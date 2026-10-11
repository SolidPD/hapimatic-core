// SPDX-License-Identifier: AGPL-3.0-only
import type { ApiClient } from "@/api/client";
import {
  useGitHubAccounts,
  useGitHubRepos,
  type GitHubAccount,
  type GitHubRepo,
} from "@/hooks/queries/useGitHubRepos";
import {
  useRepoIssues,
  type RepoIssueItem,
} from "@/hooks/queries/useRepoIssues";

/**
 * The Create Session page's GitHub data wiring, in one place (#2327).
 *
 * Extracted from `NewSession/index.tsx` because that container sits against the
 * Epic-0 (#2077) 1,500-line `max-lines` guardrail, and #2327 needed to add the
 * account-resolution failure signal (`unavailable` / `reason`) to it. The
 * guardrail's documented intent is to prevent god-file REGROWTH — its
 * `eslint-disable` escape hatch is reserved for files that were already over
 * threshold when it landed, so suppressing it here would be exactly the misuse
 * it exists to catch. Extracting the wiring is the intended response.
 *
 * Purely a composition seam: it adds no behavior over the two underlying query
 * hooks, so the account/repo semantics stay defined in
 * `@/hooks/queries/useGitHubRepos`.
 */
export function useGitHubSection(args: {
  api: ApiClient | null;
  nodeId: string | null;
  /** Standard mode only (R10) — the scheduled-event flow never clones. */
  enabled: boolean;
  /** Selected account login; repo listing stays idle until one is chosen. */
  account: string | null;
  /** Working directory, for the Link Issue field's repo-issue lookup. */
  directory: string;
}): {
  accounts: GitHubAccount[];
  accountsLoading: boolean;
  /** #2327: account resolution FAILED (vs. succeeded with zero accounts). */
  accountsUnavailable: boolean;
  /** #2327: machine-readable cause behind `accountsUnavailable`. */
  accountsReason: string | null;
  repos: GitHubRepo[];
  reposLoading: boolean;
  issues: RepoIssueItem[];
  /** Forge-origin repo resolved from the directory, or null. */
  detectedRepo: string | null;
  issuesLoading: boolean;
  /** #2327: issue resolution FAILED (vs. this repo having none). */
  issuesUnavailable: boolean;
  /**
   * #2270 (F25): TRUE git-ness (rev-parse), tri-state — `undefined` means
   * unknown, and the Git-Type control MUST NOT force a default on it. Distinct
   * from `detectedRepo != null`, which is forge-origin identity.
   */
  directoryIsGitRepo: boolean | undefined;
} {
  const accountsQuery = useGitHubAccounts(args.api, args.nodeId, {
    enabled: args.enabled,
  });
  const reposQuery = useGitHubRepos(args.api, args.account, args.nodeId, {
    enabled: args.enabled,
  });
  const issuesQuery = useRepoIssues(args.api, args.directory, args.nodeId);

  return {
    accounts: accountsQuery.accounts,
    accountsLoading: accountsQuery.isLoading,
    accountsUnavailable: accountsQuery.unavailable,
    accountsReason: accountsQuery.reason,
    repos: reposQuery.repos,
    reposLoading: reposQuery.isLoading,
    issues: issuesQuery.issues,
    detectedRepo: issuesQuery.repo,
    issuesLoading: issuesQuery.isLoading,
    issuesUnavailable: issuesQuery.unavailable,
    directoryIsGitRepo: issuesQuery.directoryIsGitRepo,
  };
}
