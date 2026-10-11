// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { Session } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Hook for fetching and maintaining session state.
 *
 * @param api - The API client instance
 * @param sessionId - The session ID to fetch
 * @param isActiveSession - When true, enables polling every 5 seconds as a fallback
 *                          to SSE events for keeping session.thinking state fresh.
 *                          This prevents the timer from stopping prematurely when
 *                          SSE events are delayed or missed.
 */
export function useSession(
  api: ApiClient | null,
  sessionId: string | null,
  isActiveSession: boolean = false
): {
  session: Session | null;
  messageCount: number;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const resolvedSessionId = sessionId ?? "unknown";
  const query = useQuery({
    queryKey: queryKeys.session(resolvedSessionId),
    queryFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      return await api.getSession(sessionId);
    },
    enabled: Boolean(api && sessionId),
    refetchInterval: isActiveSession ? 5_000 : false,
    // Reduce stale time for active sessions to ensure fresher data
    staleTime: isActiveSession ? 2_000 : undefined,
  });

  return {
    session: query.data?.session ?? null,
    messageCount: query.data?.messageCount ?? 0,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load session"
          : null,
    refetch: query.refetch,
  };
}
