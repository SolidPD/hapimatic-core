// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Local machine's spawn capacity for the Create-page slot meter (issue #1805,
 * R2). Polls every 15s — the dedicated local refresh (R4); SSE-driven
 * federation invalidation is the backstop. `retry: false` plus the server's
 * `{ null, null }` fallback mean a down daemon renders "—" rather than crashing
 * or blocking the spawn button (R5).
 */
export function useDaemonCapacity(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.daemonCapacity,
    queryFn: async () => {
      if (!api)
        return {
          effectiveCount: null,
          maxConcurrent: null,
          recommendedConcurrent: null,
          capSource: null,
        };
      return await api.getDaemonCapacity();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    refetchInterval: 15_000,
    staleTime: 10_000,
    retry: false,
  });
}
