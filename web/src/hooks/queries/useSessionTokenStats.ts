// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SessionTokenStatsResponse } from "@hapi/protocol";
import { queryKeys } from "@/lib/query-keys";

/**
 * Server-authoritative session token stats (issue #1671, epic #1662 Sub I).
 *
 * Reads `GET /api/sessions/:id/token-stats` — the `v_session_totals` aggregate
 * plus the per-turn breakdown. This is the AUTHORITATIVE source for session
 * token totals (the client-side `reducer.ts` aggregate undercounts: 50-msg
 * pages + browser memory only, D10). The status line + TokenUsageSection prefer
 * this; when it is unavailable (`isError`/no data), callers fall back to the
 * client aggregate with an explicit "estimate" marker (R7, Fallback Preservation
 * Rule).
 *
 * A cheap SELECT over a view — `refetchInterval` keeps the footer/status fresh
 * after a turn finalizes without ever touching the prompt/reply path.
 */
export function useSessionTokenStats(
  api: ApiClient | null,
  sessionId: string | null
): {
  data: SessionTokenStatsResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: sessionId
      ? queryKeys.sessionTokenStats(sessionId)
      : (["session-token-stats", "none"] as const),
    queryFn: async () => {
      if (!api || !sessionId) throw new Error("API/session unavailable");
      return await api.getSessionTokenStats(sessionId);
    },
    enabled: Boolean(api && sessionId),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
