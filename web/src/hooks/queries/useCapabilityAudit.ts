// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { CapabilityAuditResponse } from "@/types/capabilities";
import { queryKeys } from "@/lib/query-keys";

/**
 * Capability audit query hook (issue #3752, Sub-Issue L / R5 / Task 6).
 *
 * READ-ONLY: a single query against `GET /api/capabilities/audit?format=full`
 * (the drift ARRAYS live in the full shape, not `summary`). Feeds the panel's
 * coverage summary and drift lists. A 60s backstop keeps the report fresh.
 */
export function useCapabilityAudit(api: ApiClient | null): {
  audit: CapabilityAuditResponse | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.capabilityAudit,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getCapabilityAudit();
    },
    enabled: Boolean(api),
    refetchInterval: 60_000,
  });

  return {
    audit: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load the capability audit"
          : null,
    refetch: query.refetch,
  };
}
