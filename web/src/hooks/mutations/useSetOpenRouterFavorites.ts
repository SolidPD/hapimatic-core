// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Persist the favorited OpenRouter model ids (issue #1975). The caller passes
 * the FULL next list (computed from the current favorites + the toggled id), so
 * the mutation is a single idempotent PUT. Optimistic: the cache updates
 * immediately (the star feels instant) and rolls back on error.
 */
export function useSetOpenRouterFavorites(api: ApiClient | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (models: string[]): Promise<string[]> => {
      if (!api) throw new Error("API unavailable");
      const res = await api.setOpenRouterFavorites({ models });
      return res.models;
    },
    onMutate: async (models: string[]) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.openRouterFavorites,
      });
      const prev = queryClient.getQueryData<string[]>(
        queryKeys.openRouterFavorites
      );
      queryClient.setQueryData(queryKeys.openRouterFavorites, models);
      return { prev };
    },
    onError: (_err, _models, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData(queryKeys.openRouterFavorites, ctx.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.openRouterFavorites,
      });
    },
  });
}
