// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { Machine } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_MACHINES: Machine[] = [];

export function useMachines(
  api: ApiClient | null,
  enabled: boolean
): {
  machines: Machine[];
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: queryKeys.machines,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getMachines();
    },
    enabled: Boolean(api && enabled),
  });

  return {
    machines: query.data?.machines ?? EMPTY_MACHINES,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load machines"
          : null,
    refetch: query.refetch,
  };
}
