// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * The operator-instance gate for the feedback inbox (issue #2910, epic #2909
 * Sub A). FAIL-CLOSED, modeled on `useVmPreflight`: on a non-operator instance
 * `GET /api/feedback/preflight` 404s, so the query errors and `data` stays
 * undefined. Callers gate on `data?.enabled === true`, which treats loading,
 * error, AND 404 as "gate closed".
 *
 * `retry: false` is load-bearing — a retry storm on the designed 404 would delay
 * the closed verdict. The flag is resolved once per server process, so the
 * answer is static: `staleTime` / `gcTime: Infinity` and `retryOnMount: false`
 * keep it to one request per page load. `api.getFeedbackPreflight` declares the
 * 404 expected, so a closed gate is never filed as a client error report.
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
      return await api.getFeedbackPreflight();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retryOnMount: false,
  });
}
