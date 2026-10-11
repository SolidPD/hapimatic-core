// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { CapabilityCatalogResponse } from "@/types/capabilities";
import { queryKeys } from "@/lib/query-keys";

/**
 * Capability catalog query hook (issue #3752, Sub-Issue L / R5 / Task 6).
 *
 * READ-ONLY: a single query against `GET /api/capabilities/catalog`. No mutation
 * hooks live here — the panel never invokes a capability. The server hard-filters
 * by scope UNCONDITIONALLY (#3749), so this Settings-page read (no session) receives
 * only `user`-scope entries. A 60s backstop keeps availability reasonably fresh.
 */
export function useCapabilityCatalog(api: ApiClient | null): {
  catalog: CapabilityCatalogResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.capabilityCatalog,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getCapabilityCatalog();
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    catalog: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load the capability catalog"
          : null,
    refetch: query.refetch,
  };
}
