// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import {
  HARNESS_UNAVAILABLE,
  type HarnessAnalysisResponse,
  type HarnessUnavailable,
} from "@/types/harnessUpdates";

/** How often to re-poll the analysis status while an analysis is in flight. */
const ANALYZING_POLL_INTERVAL_MS = 5_000;

/**
 * Harness impact-analysis query (epic #1769 Sub-Issue D, issue #1773).
 *
 * Wraps `GET /api/harness/:harnessId/analysis?range=<from>..<to>` (#1772). Enabled
 * once a harness + range is selected. The response is a discriminated `status`
 * envelope; while `status === "analyzing"` this hook polls every 5s and stops on
 * any terminal status (`ready` / `failed` / `at_capacity` / `none`) — the
 * production QueryClient sets `refetchOnWindowFocus:false`, so without this the
 * "Analyzing…" state would never leave. A boot-window 404/503 resolves to the
 * `unavailable` sentinel (R8).
 */
export function useHarnessAnalysis(
  api: ApiClient | null,
  harnessId: string | null,
  range: string | null
): {
  analysis: HarnessAnalysisResponse | null;
  unavailable: boolean;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.harnessAnalysis(harnessId ?? "", range ?? ""),
    queryFn: async (): Promise<
      HarnessAnalysisResponse | HarnessUnavailable
    > => {
      if (!api || !harnessId || !range) throw new Error("API unavailable");
      try {
        return await api.getHarnessAnalysis(harnessId, range);
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
    enabled: Boolean(api) && Boolean(harnessId) && Boolean(range),
    refetchInterval: query => {
      const d = query.state.data;
      if (d && d !== HARNESS_UNAVAILABLE && d.status === "analyzing") {
        return ANALYZING_POLL_INTERVAL_MS;
      }
      return false;
    },
  });

  const unavailable = query.data === HARNESS_UNAVAILABLE;
  return {
    analysis:
      query.data === undefined || query.data === HARNESS_UNAVAILABLE
        ? null
        : query.data,
    unavailable,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load impact analysis"
          : null,
  };
}
