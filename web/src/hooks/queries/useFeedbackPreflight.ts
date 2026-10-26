// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * The operator-instance gate for the feedback inbox (issue #2910, epic #2909
 * Sub A). FAIL-CLOSED: callers gate on `data?.enabled === true`, which treats
 * loading, a check failure, AND a closed instance as "gate closed".
 *
 * Issue #5571: the designed 404 of a non-operator instance is turned into DATA
 * (`{ enabled: false }`) inside the query function, so it is cached like the open
 * answer — the flag is resolved once per server process, so `staleTime` /
 * `gcTime: Infinity` keep the verdict to one request per page load. Any OTHER
 * failure (network, timeout, 5xx) stays an error: it is retried twice, and
 * `retryOnMount: true` re-runs it on the next mount instead of hiding the inbox
 * for the life of the SPA. `api.getFeedbackPreflight` declares the 404
 * expected, so a closed gate is never filed as a client error report.
 *
 * Contract consumed by #2912 / #2913 (the latter mounts it on every page) —
 * keep the name, signature, and `{ enabled: boolean }` data shape stable.
 */
export function useFeedbackPreflight(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.feedbackPreflight,
    queryFn: async (): Promise<{ enabled: boolean }> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.getFeedbackPreflight();
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return { enabled: false };
        }
        throw error;
      }
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: failureCount => failureCount < 2,
    staleTime: Infinity,
    gcTime: Infinity,
    retryOnMount: true,
  });
}
