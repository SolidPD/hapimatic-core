// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import {
  classifySessionLoadFailure,
  RECONNECT_ESCALATE_AFTER_FAILURES,
  RECONNECT_ESCALATE_AFTER_MS,
  type SessionLoadFailure,
} from "@/lib/nodeAvailability";
import type { Session } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

function errorText(err: unknown): string | null {
  if (err instanceof Error) return err.message;
  return err ? "Failed to load session" : null;
}

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
  /**
   * #5409: the last failure's message, kept across refetches like
   * `loadFailure` (`error` is null while a refetch is in flight).
   */
  errorMessage: string | null;
  /**
   * #5409: a `transient` failure streak (no data since its first settled
   * error) has lasted RECONNECT_ESCALATE_AFTER_MS, or reached
   * RECONNECT_ESCALATE_AFTER_FAILURES settled errors.
   * The view then shows the error and a Retry instead of "Reconnecting…".
   * Polling keeps running, so data still clears it.
   */
  reconnectEscalated: boolean;
  refetch: () => Promise<unknown>;
  /**
   * #5409: the Retry action. Unlike `refetch`, it never joins a retry chain
   * already in flight, so a click always sends a request now.
   */
  retry: () => Promise<unknown>;
} {
  const resolvedSessionId = sessionId ?? "unknown";
  const queryClient = useQueryClient();
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
  // #5409: also remember its message and when the transient streak began.
  // Every field is derived from query state (never Date.now() here), so a
  // StrictMode double render writes the same record twice.
  const lastFailureRef = useRef<{
    id: string;
    failure: SessionLoadFailure;
    message: string | null;
    /** errorUpdatedAt / errorUpdateCount of the streak's first error. */
    streakStartedAt: number | null;
    streakStartCount: number;
  } | null>(null);
  const currentFailure = classifySessionLoadFailure(query.error);
  if (currentFailure) {
    const prev = lastFailureRef.current;
    // The streak continues while the same session keeps failing transiently
    // with no data since it began; anything else starts (or ends) it.
    const carried =
      currentFailure === "transient" &&
      prev?.id === resolvedSessionId &&
      prev.failure === "transient" &&
      prev.streakStartedAt !== null &&
      query.dataUpdatedAt <= prev.streakStartedAt
        ? prev
        : null;
    lastFailureRef.current = {
      id: resolvedSessionId,
      failure: currentFailure,
      message: errorText(query.error),
      streakStartedAt: carried
        ? carried.streakStartedAt
        : currentFailure === "transient"
          ? query.errorUpdatedAt
          : null,
      streakStartCount: carried
        ? carried.streakStartCount
        : query.errorUpdateCount,
    };
  } else if (
    query.data !== undefined ||
    lastFailureRef.current?.id !== resolvedSessionId
  ) {
    lastFailureRef.current = null;
  }

  const remembered = lastFailureRef.current;
  const loadFailure = currentFailure ?? remembered?.failure ?? null;
  const streakStartedAt =
    loadFailure === "transient" ? (remembered?.streakStartedAt ?? null) : null;
  const failuresInStreak =
    streakStartedAt === null
      ? 0
      : query.errorUpdateCount - (remembered?.streakStartCount ?? 0) + 1;

  // #5409: the time bound fires from a timer, because a node_offline load
  // settles one error per ≈105 s retry chain — a re-render may never come.
  const [escalatedFor, setEscalatedFor] = useState<{
    id: string;
    streakStartedAt: number;
  } | null>(null);
  useEffect(() => {
    if (streakStartedAt === null) return;
    const id = resolvedSessionId;
    const timer = setTimeout(
      () => setEscalatedFor({ id, streakStartedAt }),
      Math.max(0, streakStartedAt + RECONNECT_ESCALATE_AFTER_MS - Date.now())
    );
    return () => clearTimeout(timer);
  }, [resolvedSessionId, streakStartedAt]);

  const reconnectEscalated =
    streakStartedAt !== null &&
    (failuresInStreak >= RECONNECT_ESCALATE_AFTER_FAILURES ||
      (escalatedFor?.id === resolvedSessionId &&
        escalatedFor.streakStartedAt === streakStartedAt));

  // #5409: with no data, TanStack's refetch() joins the running retry chain
  // and waits out its backoff (query-core query.js `continueRetry`), so a
  // node_offline Retry could do nothing for seconds. Cancel the chain first
  // (it reverts to the state before that fetch began), then fetch at once.
  const { refetch } = query;
  const retry = useCallback(async () => {
    await queryClient.cancelQueries({
      queryKey: queryKeys.session(resolvedSessionId),
      exact: true,
    });
    return await refetch();
  }, [queryClient, refetch, resolvedSessionId]);

  return {
    session: query.data?.session ?? null,
    messageCount: query.data?.messageCount ?? 0,
    isLoading: query.isLoading,
    error: errorText(query.error),
    loadFailure,
    errorMessage: loadFailure
      ? (errorText(query.error) ?? remembered?.message ?? null)
      : null,
    reconnectEscalated,
    refetch: query.refetch,
    retry,
  };
}
