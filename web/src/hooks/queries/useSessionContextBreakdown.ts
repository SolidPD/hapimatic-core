// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient, SessionContextBreakdownResult } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Claude Code's full context breakdown for a session (issue #6170), read through
 * the readonly `get-context-usage` capability with `{ detail: "full" }`.
 *
 * Fetches only while `enabled` (the modal is open) and on an explicit
 * `refetch()` — never on an interval and never on window focus, because each
 * read makes Claude Code count every category with its token-count API. No
 * retry: every designed failure arrives as `{ kind: "error", code }`, and the
 * modal offers its own Retry.
 */
export function useSessionContextBreakdown(
  api: ApiClient | null,
  sessionId: string,
  enabled: boolean
): {
  data: SessionContextBreakdownResult | undefined;
  error: unknown;
  isFetching: boolean;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.sessionContextBreakdown(sessionId),
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getSessionContextBreakdown(sessionId);
    },
    enabled: Boolean(api) && enabled,
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  return {
    data: query.data,
    error: query.error,
    isFetching: query.isFetching,
    dataUpdatedAt: query.dataUpdatedAt,
    refetch: query.refetch,
  };
}
