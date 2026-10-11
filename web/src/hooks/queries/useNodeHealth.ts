// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { FederationNodeHealthDetail } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

// Poll cadence aligned with #1445's backend sampler (HAPI_FED_HEALTH_POLL_MS
// default) — the UI updates ~one backend poll behind.
const HEALTH_POLL_INTERVAL_MS = 30_000;

/**
 * `ApiClient.request` throws `Error("HTTP <status> <statusText>: <body>")` on a
 * non-2xx response (`web/src/api/client.ts:212`) — there is NO `.status` field
 * on the thrown error, so the taxonomy keys off the message prefix.
 */
function isHttpStatus(error: unknown, status: number): boolean {
  return (
    error instanceof Error &&
    new RegExp(`^HTTP ${status}\\b`).test(error.message)
  );
}

/**
 * The detail page stops polling once the health endpoint reports
 * health-disabled (503): a standalone/spoke deployment never enables
 * federation health mid-session, so re-polling would be pure waste. Any other
 * state (success, 404 unknown-node, generic error) keeps the 30s cadence.
 *
 * Exported as a pure function so the poll-stop is unit-testable without fake
 * timers (issue #1444 V2).
 */
export function nodeHealthRefetchInterval(error: unknown): number | false {
  return isHttpStatus(error, 503) ? false : HEALTH_POLL_INTERVAL_MS;
}

export type UseNodeHealthResult = {
  node: FederationNodeHealthDetail | null;
  isLoading: boolean;
  /** 404 — the nodeId is not in the registry (drives the R2 empty state). */
  isNotFound: boolean;
  /** 503 — federation health is not enabled (standalone/spoke steady state). */
  isDisabled: boolean;
  /** Any other (non-404, non-503) error. */
  isError: boolean;
};

/**
 * Per-node health detail with the 404/503 error taxonomy the per-node detail
 * page needs (issue #1444). Reuses #1037's `api.getFederationNodeHealth`, but —
 * unlike #1037's `useFederationNodeHealth`, which collapses every failure to a
 * single `isError` — it distinguishes:
 *   - 404 → `isNotFound` (unknown node → R2 "Node not found" empty state)
 *   - 503 → `isDisabled` (health monitoring disabled → placeholder) AND stops
 *     polling (see `nodeHealthRefetchInterval`)
 *   - anything else → `isError`
 * Idle (returns `node: null`, no flags) when `api` is null or `nodeId` is empty.
 */
export function useNodeHealth(
  api: ApiClient | null,
  nodeId: string
): UseNodeHealthResult {
  const query = useQuery({
    queryKey: queryKeys.nodeHealth(nodeId),
    queryFn: () => api!.getFederationNodeHealth(nodeId),
    enabled: Boolean(api) && Boolean(nodeId),
    staleTime: 25_000,
    retry: false,
    refetchInterval: q => nodeHealthRefetchInterval(q.state.error),
  });

  const isNotFound = isHttpStatus(query.error, 404);
  const isDisabled = isHttpStatus(query.error, 503);

  return {
    node: query.data ?? null,
    isLoading: query.isLoading,
    isNotFound,
    isDisabled,
    isError: query.isError && !isNotFound && !isDisabled,
  };
}
