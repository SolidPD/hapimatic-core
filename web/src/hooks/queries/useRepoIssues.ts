// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export type RepoIssueItem = {
  number: number;
  title: string;
  labels: string[];
  state: "open" | "closed";
};

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES. (The `issues: [] as RepoIssueItem[]` literals in
// the queryFn are resolved-data branches, cached in query.data — not per-render.)
const EMPTY_ISSUES: RepoIssueItem[] = [];

export function useRepoIssues(
  api: ApiClient | null,
  directory: string,
  nodeId?: string | null,
  options?: { enabled?: boolean }
): {
  issues: RepoIssueItem[];
  repo: string | null;
  isLoading: boolean;
  /**
   * Issue #2270 (F25): TRUE git-ness of the directory (`git rev-parse`),
   * distinct from forge identity. TRI-STATE: `undefined` while loading OR when
   * the server can't determine it (repo-by-name / remote no-origin dir) — the
   * Git-Type control MUST NOT force a default in that case; only a definitive
   * `false` defaults to simple. A no-origin/`git init` repo reads `true` here
   * while `hasForgeRepo` is `false`.
   */
  directoryIsGitRepo: boolean | undefined;
  /**
   * Issue #2270 (F25): forge-origin identity present (`repo != null`). Renamed
   * from the misleadingly-named `isGitRepo` — it is NOT git-ness (a git repo
   * with no forge origin has `hasForgeRepo: false` but `directoryIsGitRepo: true`).
   */
  hasForgeRepo: boolean;
  /**
   * #2327: issue resolution FAILED — distinct from "this repo has no open
   * issues". Without it the Link Issue field presents an empty picker for both,
   * which on a cloud VM (no `gh` binary) means the field silently reads as
   * "no issues" forever. #3558: also true when the lookup itself THREW (HTTP
   * 4xx/5xx or a network fault) — then `repo` is null and the field shows a
   * lookup-failure message instead of "Select a git directory first".
   */
  unavailable: boolean;
} {
  const trimmedDir = directory.trim();

  const query = useQuery({
    queryKey: queryKeys.repoIssues(trimmedDir, nodeId ?? undefined),
    queryFn: async () => {
      if (!api || !trimmedDir) {
        return {
          repo: null,
          issues: [] as RepoIssueItem[],
          directoryIsGitRepo: undefined as boolean | undefined,
          unavailable: false,
        };
      }

      let result: Awaited<ReturnType<ApiClient["listRepoIssues"]>>;
      try {
        result = await api.listRepoIssues(trimmedDir, nodeId);
      } catch {
        // #3558: a THROWN transport failure (4xx/5xx ApiError, network fault)
        // is a lookup failure, not "not a git directory". Map it onto the same
        // `unavailable` signal as an explicit `success:false`, and keep
        // git-ness unknown so the F25 seam never forces a default from it.
        // Not rethrown: a throwing queryFn retries and never sets `unavailable`.
        return {
          repo: null,
          issues: [] as RepoIssueItem[],
          directoryIsGitRepo: undefined as boolean | undefined,
          unavailable: true,
        };
      }
      // Preserve directoryIsGitRepo on EVERY branch — including the no-forge-origin
      // case (`!result.repo` but `directoryIsGitRepo: true`), the key F25 signal
      // that keeps Worktree available for a git-init/no-origin repo.
      if (!result.success || !result.repo) {
        return {
          repo: result.repo,
          issues: [] as RepoIssueItem[],
          directoryIsGitRepo: result.directoryIsGitRepo,
          // A repo with no forge origin is NOT a failure — only an explicit
          // `success: false` is.
          unavailable: !result.success,
        };
      }

      return {
        repo: result.repo,
        issues: result.issues,
        directoryIsGitRepo: result.directoryIsGitRepo,
        unavailable: false,
      };
    },
    enabled: (options?.enabled ?? true) && Boolean(api && trimmedDir),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  return {
    issues: query.data?.issues ?? EMPTY_ISSUES,
    repo: query.data?.repo ?? null,
    isLoading: query.isLoading,
    // Undefined while loading (query.data undefined) OR when the server reports
    // unknown ⇒ tri-state "unknown" ⇒ no forcing at the derivation seam.
    directoryIsGitRepo: query.data?.directoryIsGitRepo,
    hasForgeRepo: query.data?.repo != null,
    unavailable: query.data?.unavailable ?? false,
  };
}
