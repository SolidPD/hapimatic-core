// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import {
  classifySessionLoadFailure,
  type SessionLoadFailure,
} from "@/lib/nodeAvailability";
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
  /**
   * Why the load failed (null when it has not). #5375: only `not_found` (a
   * definite 404) means the session is gone; `transient` is a restarting or
   * unreachable node or hub; `failed` is any other error. Kept across the
   * poll's refetches until data arrives, so a failure view does not flicker.
   */
  loadFailure: SessionLoadFailure | null;
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

  // #5375: while an errored query with no data refetches (the 5 s poll),
  // TanStack resets it to pending with `error: null` (measured on query-core
  // 5.104.4), so a 404 page would flash "Loading session…" every cycle.
  // Remember the last failure for this session until data arrives.
  const lastFailureRef = useRef<{
    id: string;
    failure: SessionLoadFailure;
  } | null>(null);
  const currentFailure = classifySessionLoadFailure(query.error);
  if (currentFailure) {
    lastFailureRef.current = { id: resolvedSessionId, failure: currentFailure };
  } else if (
    query.data !== undefined ||
    lastFailureRef.current?.id !== resolvedSessionId
  ) {
    lastFailureRef.current = null;
  }

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
    loadFailure: currentFailure ?? lastFailureRef.current?.failure ?? null,
    refetch: query.refetch,
  };
}
