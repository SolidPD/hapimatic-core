// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { AccountUsageHistory } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Query a single account's usage history (epic #1855, Sub-Issue I / #1864).
 *
 * Fetches `GET /api/accounts/usage/history?uuid=...` (Sub I) only while
 * `enabled` (the consuming card passes its expanded/visible state so it does
 * not poll when hidden). Degrades to `null` on error rather than throwing —
 * the sparkline is supplementary and must never crash the card (mirrors
 * `useNodeActiveAccount`'s resilient fallback).
 */
export function useAccountUsageHistory(
  api: ApiClient | null,
  accountUuid: string | null,
  enabled: boolean
): {
  history: AccountUsageHistory | null;
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.usageHistory(accountUuid ?? "none"),
    queryFn: async () => {
      if (!api || !accountUuid) {
        // Disabled when !api || !accountUuid, so this is only a type-guard for
        // the api-becomes-null edge case; it never crashes the caller.
        return null;
      }
      const res = await api.getAccountUsageHistory(accountUuid);
      return res.history;
    },
    enabled: Boolean(api && accountUuid && enabled),
    retry: false,
  });

  return {
    history: query.data ?? null,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load usage history"
          : null,
  };
}
