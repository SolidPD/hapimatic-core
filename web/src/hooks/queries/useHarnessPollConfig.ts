// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { HarnessPollConfig } from "@/types/harnessUpdates";
import { queryKeys } from "@/lib/query-keys";

/**
 * Read the harness poll cadence (#1775, R5). Mirrors `useSystemJobs`: takes
 * `api: ApiClient | null`, is disabled when the client is null, and surfaces
 * `error` via the instanceof-Error ternary. The settings control (Task 9,
 * deferred to the UI phase until #1773's panel lands) renders
 * `config.pollIntervalMs`.
 */
export function useHarnessPollConfig(api: ApiClient | null): {
  config: HarnessPollConfig | undefined;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.harnessPollConfig,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      const res = await api.getHarnessPollConfig();
      return res.config;
    },
    enabled: Boolean(api),
  });

  return {
    config: query.data,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load harness poll config"
          : null,
  };
}
