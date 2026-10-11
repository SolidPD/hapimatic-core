// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type {
  FederationTurnAggregate,
  SessionMetadataFilterOptions,
  SessionMetadataQuery,
  SessionMetadataTurn,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_TURNS: SessionMetadataTurn[] = [];

// Admin session-metadata query hooks (issue #1675, epic #1662 Sub M).
//
// Node-local scope → useSessionMetadataTurns (the `turns`/`turn_events` query
// serving all six filters). Cross-node scope → useFederationTurnAggregate (Sub
// L's session-totals aggregate). Filter-option dropdowns → node-local distinct
// values. All graceful on error (standalone nodes 503 the federation endpoint).

/**
 * Node-local per-turn query. `filters` participates in the query key so a filter
 * change refetches. Returns `[]` until loaded/on error.
 */
export function useSessionMetadataTurns(
  api: ApiClient | null,
  filters: SessionMetadataQuery
): { turns: SessionMetadataTurn[]; isLoading: boolean; isError: boolean } {
  const query = useQuery({
    queryKey: queryKeys.sessionMetadataTurns(
      filters as Record<string, unknown>
    ),
    queryFn: () => api!.getSessionMetadataTurns(filters),
    enabled: Boolean(api),
  });
  return {
    turns: query.data?.turns ?? EMPTY_TURNS,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Distinct filter-dropdown values (node-local). */
export function useSessionMetadataFilterOptions(api: ApiClient | null): {
  options: SessionMetadataFilterOptions | null;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.sessionMetadataFilterOptions,
    queryFn: () => api!.getSessionMetadataFilterOptions(),
    enabled: Boolean(api),
  });
  return {
    options: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Cross-node session-totals aggregate (Sub L). Graceful by design: standalone /
 * spoke deployments 503 the federation endpoint, so on any error this returns
 * `{ aggregate: null, isError: true }` rather than throwing (mirrors
 * useFederationHealthAggregate).
 */
export function useFederationTurnAggregate(
  api: ApiClient | null,
  opts?: { fromMs?: number; toMs?: number; limit?: number }
): {
  aggregate: FederationTurnAggregate | null;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.federationTurnAggregate(
      opts?.fromMs,
      opts?.toMs,
      opts?.limit
    ),
    queryFn: () => api!.getFederationTurnAggregate(opts),
    enabled: Boolean(api),
    retry: 1,
  });
  return {
    aggregate: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
