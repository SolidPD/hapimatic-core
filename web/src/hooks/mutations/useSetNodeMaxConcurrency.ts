// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Set a node's spawn cap (issue #1805, R7/R11). On success, invalidate the
 * local capacity meter, the node's cap query, and the federation summary (which
 * carries remote nodes' `maxConcurrent`) so the meter + Preferences reflect the
 * change promptly. The remote-node set additionally triggers a `pollNodeById`
 * on the hub (server-side, R11) so the federation cache is refreshed too.
 */
export function useSetNodeMaxConcurrency(api: ApiClient | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      nodeId,
      value,
    }: {
      nodeId: string;
      // #4417: `null` clears an explicit cap back to automatic (tier/derived/default).
      value: number | null;
    }) => {
      if (!api) throw new Error("API unavailable");
      return await api.setNodeMaxConcurrency(nodeId, value);
    },
    onSuccess: (_data, { nodeId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.daemonCapacity });
      queryClient.invalidateQueries({
        queryKey: queryKeys.nodeMaxConcurrency(nodeId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    },
  });
}
