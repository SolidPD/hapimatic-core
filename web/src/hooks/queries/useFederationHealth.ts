// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import type {
  FederationHealthAggregate,
  FederationNodeHealthDetail,
  FederationNodeHealth,
  FederationAlert,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

// Poll cadence matches #1445's documented sampler interval.
const HEALTH_POLL_INTERVAL_MS = 30000;

// #3508: module-level stable empty fallbacks — keep the pending-query array
// identities constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_HEALTH_NODES: FederationNodeHealth[] = [];
const EMPTY_ALERTS: FederationAlert[] = [];

/**
 * Federation-wide aggregate health (worst-case severity). Issue #1445.
 *
 * Graceful by design: on standalone/spoke deployments the endpoint returns 503
 * (no HealthAggregator — steady state), so on any error this returns
 * `{ aggregate: null, isError: true }` rather than throwing. Consumers
 * (useSystemHealthDisplayTarget) treat a null aggregate as "fall back to local
 * health" per R15/D5.
 */
export function useFederationHealthAggregate(api: ApiClient | null): {
  aggregate: FederationHealthAggregate | null;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.federationHealthAggregate,
    queryFn: () => api!.getFederationHealthAggregate(),
    enabled: Boolean(api),
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    retry: 1,
  });

  return {
    aggregate: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Single-node health detail. Issue #1445. Enabled only when both `api` and a
 * non-null `nodeId` are present (the FED-mode caller passes a null nodeId so
 * this query stays idle). Errors surface as `{ node: null, isError: true }` —
 * never thrown.
 */
export function useFederationNodeHealth(
  api: ApiClient | null,
  nodeId: string | null
): {
  node: FederationNodeHealthDetail | null;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.federationNodeHealth(nodeId ?? ""),
    queryFn: () => api!.getFederationNodeHealth(nodeId!),
    enabled: Boolean(api) && Boolean(nodeId),
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    retry: 1,
  });

  return {
    node: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Batch per-node health for the Federation Health Dashboard's Tier-2 cards
 * (issue #1632; #1037 consumer). One request → one entry per node; offline
 * nodes are preserved (status "offline", NOT collapsed to critical — that is
 * aggregation-only semantics). Graceful: on 503 (standalone/spoke deployments
 * with no HealthAggregator) returns `{ nodes: [], isError: true }` rather than
 * throwing, so the dashboard falls back to identity-only cards.
 */
export function useFederationHealthNodes(api: ApiClient | null): {
  nodes: FederationNodeHealth[];
  lastSampleAt: number | null;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.federationHealthNodes,
    queryFn: () => api!.getFederationHealthNodes(),
    enabled: Boolean(api),
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    retry: 1,
  });

  return {
    nodes: query.data?.nodes ?? EMPTY_HEALTH_NODES,
    lastSampleAt: query.data?.lastSampleAt ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * Federation alerts feed (issue #1445; #1037's Tier-1 incidents feed).
 *
 * Uses `useInfiniteQuery` (precedent: `useMessages.ts`) so already-loaded pages
 * survive the 30s background refetch — a plain query + manual concat would
 * reset the "load more" pages on every poll. Newest-first; cursor pagination
 * via the server's `nextCursor`. Graceful: on 503 returns empty alerts +
 * `isError: true`, never throws.
 */
export function useFederationAlerts(
  api: ApiClient | null,
  opts?: { nodeId?: string; limit?: number }
): {
  alerts: FederationAlert[];
  loadMoreAlerts: () => void;
  hasMoreAlerts: boolean;
  isLoadingMore: boolean;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useInfiniteQuery({
    queryKey: queryKeys.federationAlerts(opts?.nodeId),
    queryFn: ({ pageParam }) =>
      api!.getFederationAlerts({
        cursor: pageParam ?? undefined,
        limit: opts?.limit,
        nodeId: opts?.nodeId,
      }),
    enabled: Boolean(api),
    initialPageParam: null as string | null,
    getNextPageParam: lastPage => lastPage.nextCursor,
    refetchInterval: HEALTH_POLL_INTERVAL_MS,
    retry: 1,
  });

  return {
    alerts: query.data?.pages.flatMap(page => page.alerts) ?? EMPTY_ALERTS,
    loadMoreAlerts: () => void query.fetchNextPage(),
    hasMoreAlerts: Boolean(query.hasNextPage),
    isLoadingMore: query.isFetchingNextPage,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
