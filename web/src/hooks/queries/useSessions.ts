// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type { ApiClient } from "@/api/client";
import type { SessionSummary } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import { withoutDeletePending } from "@/lib/session-action-pending";

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_SESSIONS: SessionSummary[] = [];

/**
 * Adaptive backoff thresholds (#1032).
 *
 * If two consecutive /api/sessions responses exceed SLOW_MS, the hook caps
 * refetch frequency at `effectiveIntervalMs`, doubling on each additional
 * slow response up to BACKOFF_CEILING_MS. When a response comes back fast,
 * the cap is halved back toward the base.
 */
const SLOW_MS = 1000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CEILING_MS = 5 * 60_000;

export function useSessions(api: ApiClient | null): {
  sessions: SessionSummary[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
  lastFetchMs: number | null;
  effectiveIntervalMs: number | null;
} {
  // Rolling record of the last two response times. `performance.now()` is
  // monotonic so we don't have to worry about wall-clock jitter.
  const recentLatenciesRef = useRef<number[]>([]);
  const lastFetchMsRef = useRef<number | null>(null);
  const effectiveIntervalRef = useRef<number | null>(null);

  const query = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      const started = performance.now();
      const result = await api.getSessions();
      const elapsedMs = performance.now() - started;
      lastFetchMsRef.current = elapsedMs;

      // Keep a rolling window of the last two samples. Two is enough to
      // detect sustained slowness without overreacting to a single hiccup.
      const recent = recentLatenciesRef.current;
      recent.push(elapsedMs);
      if (recent.length > 2) recent.shift();

      const sustainedSlow =
        recent.length === 2 && recent.every(ms => ms > SLOW_MS);
      const current = effectiveIntervalRef.current;

      if (sustainedSlow) {
        // Double on each slow response, clamped to the ceiling.
        const next = current
          ? Math.min(current * 2, BACKOFF_CEILING_MS)
          : BACKOFF_BASE_MS;
        effectiveIntervalRef.current = next;
      } else if (elapsedMs <= SLOW_MS && current !== null) {
        // Recovering — halve the cap until we get back to event-driven mode.
        const next = current / 2;
        effectiveIntervalRef.current = next < BACKOFF_BASE_MS ? null : next;
      }

      // #3516 follow-up: a refetch during an in-flight delete must not resurrect
      // the optimistically-removed row (see withoutDeletePending).
      const sessions = withoutDeletePending(result.sessions);
      return sessions === result.sessions ? result : { ...result, sessions };
    },
    enabled: Boolean(api),
    placeholderData: keepPreviousData,
    // #1032: the backoff cap doubles as both a polling interval (so a stuck
    // query is eventually retried) and a floor on how often SSE-driven
    // invalidations can refetch (via staleTime).
    refetchInterval: () => effectiveIntervalRef.current ?? false,
    staleTime: () => effectiveIntervalRef.current ?? 0,
  });

  return {
    sessions: query.data?.sessions ?? EMPTY_SESSIONS,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load sessions"
          : null,
    refetch: query.refetch,
    lastFetchMs: lastFetchMsRef.current,
    effectiveIntervalMs: effectiveIntervalRef.current,
  };
}
