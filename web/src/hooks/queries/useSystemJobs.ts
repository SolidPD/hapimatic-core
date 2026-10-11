// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SystemJobsNode } from "@/types/systemJobs";
import { queryKeys } from "@/lib/query-keys";

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_NODES: SystemJobsNode[] = [];

/**
 * System Jobs query hook (epic #1534 Sub-Issue D, issue #1538).
 *
 * A SINGLE query against the #1537 cross-node aggregate `GET /api/system-jobs/all`.
 * The aggregate already carries `nodeId`/`nodeLabel`/`status` inline per node, so —
 * unlike the two-query `useFederatedSessions` pattern — one query maps straight to
 * the node groups the section renders (epic #1534 ruling D1). A 30s backstop poll
 * keeps live timer state (next/last run, journal tail) reasonably fresh.
 */
export function useSystemJobs(api: ApiClient | null): {
  nodes: SystemJobsNode[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.systemJobs,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getSystemJobsAll();
    },
    enabled: Boolean(api),
    refetchInterval: 30_000,
  });

  return {
    nodes: query.data?.nodes ?? EMPTY_NODES,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load system jobs"
          : null,
    refetch: query.refetch,
  };
}
