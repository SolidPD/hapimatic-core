// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import {
  HARNESS_UNAVAILABLE,
  type HarnessStatusResponse,
  type HarnessUnavailable,
} from "@/types/harnessUpdates";

/**
 * Harness self-update status query (epic #1769 Sub-Issue D, issue #1773).
 *
 * Wraps `GET /api/harness/status` (#1770), polling every 30s like `useSystemJobs`
 * so a fresh version-poll surfaces on the panel without a manual refresh. A
 * boot-window 404/503 (the `/api/harness` namespace not yet mounted / the poll
 * service still constructing) resolves to the `unavailable` sentinel rather than
 * throwing — `ApiClient.request` reports every non-OK to the Error Log and the
 * QueryClient retries once, so a thrown 404 from the 30s poll would spam the very
 * log the app surfaces. Real errors keep throwing (R8).
 */
export function useHarnessUpdates(api: ApiClient | null): {
  status: HarnessStatusResponse | null;
  unavailable: boolean;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.harnessUpdates,
    queryFn: async (): Promise<HarnessStatusResponse | HarnessUnavailable> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.getHarnessStatus();
      } catch (err) {
        if (
          err instanceof ApiError &&
          (err.status === 404 || err.status === 503)
        ) {
          return HARNESS_UNAVAILABLE;
        }
        throw err;
      }
    },
    enabled: Boolean(api),
    refetchInterval: 30_000,
  });

  const unavailable = query.data === HARNESS_UNAVAILABLE;
  return {
    status:
      query.data === undefined || query.data === HARNESS_UNAVAILABLE
        ? null
        : query.data,
    unavailable,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load harness updates"
          : null,
    refetch: query.refetch,
  };
}
