// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * The full OpenRouter model catalog (hundreds of models), server-cached and
 * trimmed (issue #1975). Backs the Create-Session model combobox. Resilient:
 * `retry: false` + empty fallback so the form never crashes on a fetch failure
 * (the free-text input still lets the user enter any model id). Long
 * `staleTime` because the catalog barely changes within a session.
 */
export function useOpenRouterModels(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.openRouterModels,
    queryFn: async () => {
      if (!api) return [];
      return await api.listOpenRouterModels();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    staleTime: 60 * 60 * 1000,
    retry: false,
  });
}
