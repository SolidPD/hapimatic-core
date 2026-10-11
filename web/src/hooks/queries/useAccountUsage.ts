// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccountUsage, ProviderAccountUsage } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_USAGE: AccountUsage[] = [];
// Issue #3809: the SIBLING providerUsage[] stable empty fallback (same rationale).
const EMPTY_PROVIDER_USAGE: ProviderAccountUsage[] = [];

/**
 * Query the redacted per-account usage for this node (epic #1855, Sub D — #1859).
 *
 * Mirrors `useAccounts` — fetches `GET /api/federation/accounts/usage` only while
 * `enabled`. `staleTime: 0` + `refetchInterval: 60_000` (paused when the tab is
 * backgrounded) keeps the dashboard perpetually fresh (#1909): the query refetches
 * on every mount/enable AND every ~60s while focused. The server serves these reads
 * from its push-to-cache snapshot (#1909), so the poll never triggers an upstream
 * fetch. The manual refresh button uses `useRefreshAccountUsage` (`?force=1`).
 *
 * `dataUpdatedAt` is TanStack's epoch-ms timestamp of the last successful fetch,
 * surfaced for the "Updated Xs ago" label.
 */
export function useAccountUsage(
  api: ApiClient | null,
  enabled: boolean
): {
  usage: AccountUsage[];
  // Issue #3809: the sibling non-Anthropic provider usage rows (OpenAI + Google).
  providerUsage: ProviderAccountUsage[];
  isLoading: boolean;
  error: string | null;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.accountUsage,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getAccountUsage();
    },
    enabled: Boolean(api && enabled),
    // Always stale → refetch on every mount/enable. Perpetual freshness (#1909):
    // poll every 60s while focused; pause when the tab is backgrounded so an
    // unfocused PWA tab stops hitting the server. Reads come from the server's
    // cached snapshot, so the poll never triggers an upstream fetch.
    staleTime: 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  return {
    usage: query.data?.usage ?? EMPTY_USAGE,
    providerUsage: query.data?.providerUsage ?? EMPTY_PROVIDER_USAGE,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load account usage"
          : null,
    dataUpdatedAt: query.dataUpdatedAt,
    refetch: query.refetch,
  };
}

/**
 * Force a genuinely live refetch of the account-usage query — manual refresh
 * button + pull-to-refresh (epic #1855, Sub D — #1859; #1909 force path).
 *
 * Unlike the auto-poll (which reads the server's cached snapshot), this hits the
 * aggregator with `?force=1` so the server does a real upstream refresh, then
 * seeds the query cache with the fresh result. Decoupled from `useAccountUsage`
 * so a refresh trigger in a different component need not hold the query instance.
 * Falls back to a plain cache-invalidation when `api` is null.
 */
export function useRefreshAccountUsage(
  api: ApiClient | null
): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    if (!api) {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.accountUsage,
      });
      return;
    }
    const data = await api.getAccountUsage({ force: true });
    queryClient.setQueryData(queryKeys.accountUsage, data);
  }, [api, queryClient]);
}
