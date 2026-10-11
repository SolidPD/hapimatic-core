// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import {
  HARNESS_UNAVAILABLE,
  type ChangelogSpan,
  type HarnessUnavailable,
} from "@/types/harnessUpdates";

/**
 * Harness changelog-span query (epic #1769 Sub-Issue D, issue #1773).
 *
 * Wraps `GET /api/harness/:harnessId/changelog` (#1771). No range param — the
 * server computes the installed→latest span from #1770's detection state. Enabled
 * only once a harness is selected. A degraded changelog (no source / not cached /
 * unparseable) is NOT an error here — the route 200s with `available:false` +
 * `reason`, which `ChangelogSpanView` renders as a graceful fallback (R8). The
 * `unavailable` sentinel covers only a boot-window 404/503 on the namespace.
 */
export function useHarnessChangelog(
  api: ApiClient | null,
  harnessId: string | null
): {
  changelog: ChangelogSpan | null;
  unavailable: boolean;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.harnessChangelog(harnessId ?? ""),
    queryFn: async (): Promise<ChangelogSpan | HarnessUnavailable> => {
      if (!api || !harnessId) throw new Error("API unavailable");
      try {
        return await api.getHarnessChangelog(harnessId);
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
    enabled: Boolean(api) && Boolean(harnessId),
  });

  const unavailable = query.data === HARNESS_UNAVAILABLE;
  return {
    changelog:
      query.data === undefined || query.data === HARNESS_UNAVAILABLE
        ? null
        : query.data,
    unavailable,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load changelog"
          : null,
  };
}
