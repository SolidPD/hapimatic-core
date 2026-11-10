// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export interface GitHubIssueDetails {
  labels: Array<{ name: string; color: string }>;
  body: string;
  /** #6453: a link opened from a bare reference knows only the repo and number. */
  title: string;
  state: "open" | "closed";
}

export function useGitHubIssue(
  api: ApiClient | null,
  owner: string,
  repo: string,
  number: number,
  options?: { enabled?: boolean }
): {
  details: GitHubIssueDetails | null;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.githubIssue(owner, repo, number),
    queryFn: async () => {
      const result = await api!.getGitHubIssue(owner, repo, number);
      if (!result.success || !result.issue) {
        throw new Error(result.error ?? "Failed to fetch issue details");
      }
      return {
        labels: result.issue.labels,
        body: result.issue.body,
        title: result.issue.title,
        state: result.issue.state,
      };
    },
    enabled:
      (options?.enabled ?? true) && Boolean(api && owner && repo && number > 0),
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  return {
    details: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
  };
}
