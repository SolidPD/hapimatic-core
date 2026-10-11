// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * The node's favorited OpenRouter model ids (issue #1975), pinned to the top of
 * the Create-Session model combobox. Server-backed (settings.json) so favorites
 * sync across every client hitting this node. Resilient empty fallback.
 */
export function useOpenRouterFavorites(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.openRouterFavorites,
    queryFn: async (): Promise<string[]> => {
      if (!api) return [];
      const res = await api.getOpenRouterFavorites();
      return res.models;
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}
