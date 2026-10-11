// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { PorterStatusResponse } from "@hapi/protocol/porter";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Configuration Porter exposure probe (issue #4533, epic #4290).
 *
 * FAIL-CLOSED, the `useVmPreflight` contract: a withheld instance (the default)
 * answers `GET /api/porter/status` with 404 `porter_withheld`, so the query
 * errors and `data` stays undefined. Callers gate on {@link isPorterExposed},
 * which treats loading, error AND 404 alike as withheld — the Settings row stays
 * hidden and the Configuration page shows its not-available notice until the
 * server says otherwise. `retry: false` is load-bearing: a retry storm on the
 * designed 404 would only delay that verdict. The client method declares 404 an
 * expected status, so a withheld tenant's Settings visit reports nothing.
 */
export function usePorterStatus(api: ApiClient | null) {
  return useQuery({
    queryKey: queryKeys.porterStatus,
    queryFn: async (): Promise<PorterStatusResponse> => {
      if (!api) throw new Error("API unavailable");
      return await api.getPorterStatus();
    },
    enabled: Boolean(api),
    retry: false,
    staleTime: 60_000,
  });
}

/** True only for a 200 `{ exposed: true }` — loading/error/404 mean withheld. */
export function isPorterExposed(
  data: PorterStatusResponse | undefined
): boolean {
  return data?.exposed === true;
}
