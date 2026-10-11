// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * One per-(skill × harness × model) rollup row — mirrors the server's
 * `ScorecardRow` (server/src/store/scorecardStore.ts). `conformanceRate` /
 * `avgRating` are `null` when NOT measured (never 0), so the UI must render a
 * "not measured" state, not a misleading zero (OR4).
 */
export interface ScorecardRow {
  skill: string | null;
  harness: string;
  model: string | null;
  runs: number;
  gateViolations: number;
  conformancePass: number;
  conformanceTotal: number;
  conformanceRate: number | null;
  ratingCount: number;
  avgRating: number | null;
}

/**
 * The Harness Scorecard rollup — backs Settings → Harness Scorecard (issue
 * #3128). Reads `GET /api/scorecard` (JWT-authenticated) via the generic
 * `extensionRequest` passthrough. `retry: false` + a safe empty fallback mirror
 * `useExtensionRegistry`, so the page renders an empty table rather than crashing
 * on a transient fetch failure.
 */
export function useScorecard(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.harnessScorecard,
    queryFn: async (): Promise<ScorecardRow[]> => {
      if (!api) return [];
      const res = await api.extensionRequest<{ rows: ScorecardRow[] }>(
        "/api/scorecard"
      );
      // #3508 (Task 2, non-target): this empty-array fallback lives INSIDE the
      // queryFn, so it is a resolved-data value cached in query.data — not a render-time array
      // identity. No module-level constant needed.
      return res.rows ?? [];
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}
