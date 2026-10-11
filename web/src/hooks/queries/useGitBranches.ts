// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { GitBranchListing } from "@hapi/protocol/gitBranches";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * hapimatic-private#4481: the Create-page Branch control's data source — the
 * selected directory's branches on the TARGET node (local in-process, or the
 * peer via `nodeId`).
 *
 * `listing` is `undefined` while loading and when the lookup is unavailable;
 * `unavailable` distinguishes "lookup failed" (transport error, `success:false`,
 * a stale peer without the endpoint) from "still loading" so the page can fall
 * back to today's Git Type + Branch Name controls instead of spinning forever.
 * Pattern: `useRepoIssues` (a thrown error maps to `unavailable`, not non-git).
 */
export function useGitBranches(
  api: ApiClient | null,
  directory: string,
  nodeId?: string | null,
  options?: { enabled?: boolean }
): {
  listing: GitBranchListing | undefined;
  isLoading: boolean;
  unavailable: boolean;
} {
  const trimmedDir = directory.trim();
  const query = useQuery({
    queryKey: queryKeys.gitBranches(trimmedDir, nodeId ?? undefined),
    queryFn: async (): Promise<{
      listing: GitBranchListing | undefined;
      unavailable: boolean;
    }> => {
      if (!api || !trimmedDir)
        return { listing: undefined, unavailable: false };
      try {
        const result = await api.listGitBranches(trimmedDir, nodeId);
        if (!result.success) return { listing: undefined, unavailable: true };
        return { listing: result.listing, unavailable: false };
      } catch {
        // Not rethrown: a throwing queryFn retries and never reports unavailable.
        return { listing: undefined, unavailable: true };
      }
    },
    enabled: (options?.enabled ?? true) && Boolean(api && trimmedDir),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  return {
    listing: query.data?.listing,
    isLoading: query.isLoading,
    unavailable: query.data?.unavailable ?? false,
  };
}
