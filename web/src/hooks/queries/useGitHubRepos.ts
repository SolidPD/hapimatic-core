// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Issue #1953 (A6): query hooks for the GitHub-account → repo selector.
 *
 * The "account" is the host GitHub identity (NOT an OAuth account — Hapimatic
 * has no GitHub OAuth).
 *
 * #2327: these hooks used to map a `success: false` response onto an empty
 * array, which erased the only signal that resolution had FAILED. Combined with
 * the server hardcoding `success: true`, the UI could not tell "we could not
 * reach GitHub" from "this account has no repos" — and rendered the latter. They
 * now surface `unavailable` + `reason` alongside the list, so a caller can
 * render a distinct unavailable state. The `accounts`/`repos` fields keep their
 * previous shape, so existing consumers are unaffected.
 */

export interface GitHubAccount {
  login: string;
  name: string | null;
}

export interface GitHubRepo {
  nameWithOwner: string;
  name: string;
  description: string | null;
  isPrivate: boolean;
  pushedAt: string | null;
  /** hapimatic-private#4481: the branch a clone lands on, when known. */
  defaultBranch?: string | null;
}

// #3508: module-level stable empty fallbacks — keep the pending-query array
// identities constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_ACCOUNTS: GitHubAccount[] = [];
const EMPTY_REPOS: GitHubRepo[] = [];

/**
 * List the host GitHub identity(ies) for the account selector. Federation-aware
 * via optional nodeId (resolves on the spawn-target node for a remote target).
 */
export function useGitHubAccounts(
  api: ApiClient | null,
  nodeId?: string | null,
  options?: { enabled?: boolean }
): {
  accounts: GitHubAccount[];
  isLoading: boolean;
  error: string | null;
  /** True when resolution FAILED — distinct from "resolved, but empty". */
  unavailable: boolean;
  /** Machine-readable cause when `unavailable`, else null. */
  reason: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.githubAccounts(nodeId),
    queryFn: async () => {
      if (!api) {
        return {
          accounts: [] as GitHubAccount[],
          unavailable: false,
          reason: null as string | null,
        };
      }
      const result = await api.getGitHubAccounts(nodeId);
      if (!result.success) {
        return {
          accounts: [] as GitHubAccount[],
          unavailable: true,
          reason: result.reason ?? "unknown",
        };
      }
      return {
        accounts: result.accounts,
        unavailable: false,
        reason: null as string | null,
      };
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    accounts: query.data?.accounts ?? EMPTY_ACCOUNTS,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    unavailable: query.data?.unavailable ?? false,
    reason: query.data?.reason ?? null,
  };
}

/**
 * List repositories accessible to a host GitHub account. The query is gated on
 * `account != null` so it does not fire until an account is selected.
 */
export function useGitHubRepos(
  api: ApiClient | null,
  account: string | null,
  nodeId?: string | null,
  options?: { enabled?: boolean }
): {
  repos: GitHubRepo[];
  isLoading: boolean;
  error: string | null;
  /** True when resolution FAILED — distinct from "resolved, but empty". */
  unavailable: boolean;
  /** Machine-readable cause when `unavailable`, else null. */
  reason: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.githubRepos(account, nodeId),
    queryFn: async () => {
      if (!api || !account) {
        return {
          repos: [] as GitHubRepo[],
          unavailable: false,
          reason: null as string | null,
        };
      }
      const result = await api.getGitHubRepos(account, nodeId);
      if (!result.success) {
        return {
          repos: [] as GitHubRepo[],
          unavailable: true,
          reason: result.reason ?? "unknown",
        };
      }
      return {
        repos: result.repos,
        unavailable: false,
        reason: null as string | null,
      };
    },
    enabled: (options?.enabled ?? true) && Boolean(api && account),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    repos: query.data?.repos ?? EMPTY_REPOS,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    unavailable: query.data?.unavailable ?? false,
    reason: query.data?.reason ?? null,
  };
}
