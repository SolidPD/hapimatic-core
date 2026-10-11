// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import { LOCAL_NODE_ID } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import type { SessionLoopSummary } from "@/types/systemJobs";
import { queryKeys } from "@/lib/query-keys";

/**
 * Session→loop summary query hook (issue #2453, Task 12 / R8).
 *
 * ONE query against the node-scoped batch endpoint for THIS node
 * (`GET /api/nodes/<LOCAL_NODE_ID>/system-jobs/session-loop-summary`), polled
 * every 30s (mirrors `useSystemJobs`). The header badge reads its per-session
 * slice from this SINGLE query — never N per-session requests (R8). The summary
 * is own-instance-only by definition, so the server has already filtered to
 * loops bound to this instance's port (D5).
 *
 * Returns a `bySession` map for O(1) per-badge lookup.
 */
export function useSessionLoopSummaries(api: ApiClient | null): {
  bySession: Map<string, SessionLoopSummary>;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.sessionLoopSummaries,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getSessionLoopSummaries(LOCAL_NODE_ID);
    },
    enabled: Boolean(api),
    refetchInterval: 30_000,
  });

  // #3508 (Task 2, non-target): this empty-array fallback is only a loop
  // ITERABLE, not a returned array identity. The `bySession` Map above is built OUTSIDE any
  // memo, so the returned identity is per-render BY CONSTRUCTION — stabilizing
  // the fallback would not stabilize the hook (out of scope for #3508).
  const bySession = new Map<string, SessionLoopSummary>();
  for (const summary of query.data?.summaries ?? []) {
    bySession.set(summary.sessionId, summary);
  }

  return {
    bySession,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load session loop summaries"
          : null,
  };
}
