// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { NodeAccountHealth } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

// Module-level stable empty fallback — keeps the pending-query array identity
// constant across renders (mirrors useProviderAuthState EMPTY_NODES).
const EMPTY_NODES: NodeAccountHealth[] = [];

/**
 * Query per-node account health across the federation (issue #4461, epic #4460
 * A): `GET /api/federation/account-health`, one row per known node (the serving
 * node first), each listing every account record THAT node holds. `needsRelogin`
 * and `since` arrive derived — consumers (#4464's "+ Add" modal, #4466's red-ring
 * chip) never recompute them.
 *
 * Freshness matches the account-usage dashboard: `staleTime: 0` plus a 60 s poll
 * that pauses while the tab is backgrounded. A slow peer cannot stall the read —
 * the server bounds each peer and reports it `unreachable`.
 */
export function useAccountHealth(
  api: ApiClient | null,
  enabled: boolean
): {
  nodes: NodeAccountHealth[];
  localNodeId: string | null;
  isLoading: boolean;
  error: string | null;
  /**
   * #4462: true once a read has succeeded. Unlike `isLoading` it is also false in
   * the render between enabling the query and its fetch starting, so a consumer
   * that waits on it never mistakes "not read yet" for "node missing".
   */
  hasData: boolean;
  /** #4462: re-read after a failure (the re-login deep link's retry). */
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: queryKeys.accountHealth,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getAccountHealth();
    },
    enabled: Boolean(api && enabled),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  return {
    nodes: query.data?.nodes ?? EMPTY_NODES,
    localNodeId: query.data?.localNodeId ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load account health"
          : null,
    hasData: query.data !== undefined,
    refetch: () => void query.refetch(),
  };
}
