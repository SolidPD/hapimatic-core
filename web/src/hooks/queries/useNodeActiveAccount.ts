// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { useQuery, useQueries } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { RedactedAccount } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Per-node active-account read hook (epic #1446, Sub-Issue G — issue #1453).
 *
 * Backs the "Active Account" row on each per-node card in the settings drawer
 * Federation page (the `FederationNodeCard` host is created by #1037, which is
 * not yet merged — this hook ships ahead of its consumer so the card change is
 * a thin additive diff once #1037 lands).
 *
 * Data source: `GET /api/nodes/:nodeId/active-account`, owned by Sub-Issue E
 * (#1451). Sub-Issue F (#1452) made the endpoint federation-aware, so REMOTE
 * nodes now return real proxied data — there is no longer a `501`
 * "federation pending" window to model (the research directive's R7, written
 * before F landed, is obsolete).
 *
 * Resilience traits mirror `useLauncherStatus` (30s poll, `retry: false`, safe
 * fallback) so the consuming card never crashes on a transient fetch failure.
 * The query key is parameterized (`queryKeys.nodeActiveAccount(nodeId)`) so a
 * future per-node Switch mutation (Sub-Issue H, #1454) can target the cache for
 * an optimistic update.
 */

export type NodeActiveAccountStatus =
  | "loading" // request in flight, or api/nodeId not yet available
  | "set" // account present and usable (not flagged unrefreshable)
  | "expired" // account present but flagged unrefreshable — re-login required (#1658)
  | "not-set" // endpoint returned null (no default account bound to the node)
  | "error"; // request failed — render "Unavailable", never crash the card

export function useNodeActiveAccount(
  api: ApiClient | null,
  nodeId: string,
  // #3808 Task 4b: an optional provider reads the PER-PROVIDER node default —
  // the AccountSelector's per-provider "(default)" suffix (Task 5) reads it.
  // Absent ⇒ the Anthropic default (byte-identical to before). `options` stays a
  // trailing arg so existing 2-arg callers are unaffected.
  options?: { enabled?: boolean; provider?: string }
): {
  account: RedactedAccount | null;
  status: NodeActiveAccountStatus;
  refetch: () => Promise<unknown>;
} {
  const provider = options?.provider;
  const query = useQuery({
    queryKey: queryKeys.nodeActiveAccount(nodeId, provider),
    queryFn: async () => {
      // Disabled when !api || !nodeId, so this fallback is only a type-guard
      // for the api-becomes-null edge case; it never crashes the caller.
      if (!api || !nodeId) {
        return { activeAccount: null };
      }
      return await api.getNodeActiveAccount(nodeId, provider);
    },
    enabled: (options?.enabled ?? true) && Boolean(api && nodeId),
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
  });

  const account = query.data?.activeAccount ?? null;

  let status: NodeActiveAccountStatus;
  if (query.isError) {
    status = "error";
  } else if (query.isPending) {
    // Covers both the first in-flight fetch and the disabled state (no api /
    // no nodeId / explicitly disabled) — a neutral "loading" is more honest
    // than a definitive "not-set" before any response has been observed.
    status = "loading";
  } else if (!account) {
    status = "not-set";
  } else if (account.unrefreshable === true) {
    // R5 (#1658): "expired" (re-login required) derives from the sticky
    // `unrefreshable` flag, not the store snapshot's `expiresAt` — the
    // snapshot is non-authoritative for non-host accounts (rots by design
    // post-#1635) and spawn-time recovery rescues clock-expired snapshots.
    // This retires the OR1 interim note: the flag now lands on
    // `RedactedAccount` via the server's redaction whitelist.
    status = "expired";
  } else {
    status = "set";
  }

  return { account, status, refetch: query.refetch };
}

/**
 * Batch per-node active-account resolver (#3810 Task 2). ONE `useQueries`
 * fan-out over the given node ids — a variable number of `useNodeActiveAccount`
 * calls per render would violate the rules of hooks (nodes join and leave the
 * federated list). Each query shares the EXACT cache key + options with
 * `useNodeActiveAccount` / `useSessionAccountEmail` (2-element Anthropic key, no
 * provider), so the per-row account lookups and the filter option list draw from
 * one cache and cannot disagree. Returns a nodeId → active-account-email map.
 *
 * Flicker guard (#3810 NEW-3810-11): reads each query's persisted `data` (not
 * `isPending`), so React Query's stale-while-revalidate keeps a node's resolved
 * email in the map across the 30 s background refetch — the option list does not
 * flap. Only the very first load (no data yet) leaves a node unresolved, which
 * classifies as "Unassigned" (the R2 fallback) until the first response lands.
 *
 * `enabled` lets the caller skip the fetch entirely (e.g. when no Claude row
 * lacks a recorded email), mirroring `useSessionAccountEmail`'s per-row gating.
 */
export function useNodeActiveAccounts(
  api: ApiClient | null,
  nodeIds: string[],
  options?: { enabled?: boolean }
): { resolved: ReadonlyMap<string, string | undefined>; isPending: boolean } {
  const enabled = (options?.enabled ?? true) && Boolean(api);
  const queries = useQueries({
    queries: nodeIds.map(nodeId => ({
      queryKey: queryKeys.nodeActiveAccount(nodeId),
      queryFn: async () => {
        if (!api || !nodeId) {
          return { activeAccount: null };
        }
        return await api.getNodeActiveAccount(nodeId);
      },
      enabled: enabled && Boolean(nodeId),
      refetchInterval: 30_000,
      staleTime: 25_000,
      retry: false,
    })),
  });

  // Stable signature so the returned Map keeps a stable identity while the
  // resolved emails are unchanged (the router memoizes the filter on it).
  const signature = nodeIds
    .map(
      (nodeId, i) =>
        `${nodeId}:${queries[i]?.data?.activeAccount?.emailAddress ?? ""}`
    )
    .join("|");
  const resolved = useMemo(() => {
    const map = new Map<string, string | undefined>();
    nodeIds.forEach((nodeId, i) => {
      map.set(
        nodeId,
        queries[i]?.data?.activeAccount?.emailAddress ?? undefined
      );
    });
    return map;
    // `signature` captures every (nodeId, email) pair; the queries array itself
    // changes identity every render, so it is deliberately not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const isPending = queries.some(q => q.isPending);
  return { resolved, isPending };
}
