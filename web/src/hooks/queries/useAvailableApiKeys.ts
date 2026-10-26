// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { AvailableApiKeysResponse } from "@hapi/protocol/schemas";
import { queryKeys } from "@/lib/query-keys";

const EMPTY: AvailableApiKeysResponse = {
  localNodeId: null,
  keys: [],
  unavailableNodes: [],
};

/**
 * Issue #5127: the Anthropic keys a Claude session on `targetNodeId` (null =
 * this node) can bill — this node's own keys and the keys other nodes share —
 * for the Create page's credential picker. Each key carries the `bindingRef`
 * the spawn sends (a bare id for a key on the target's own UI node, else a
 * qualified `<uuid>@<home>` ref). A ref is target-relative, so the query is
 * keyed by target. Redacted view only; `retry: false` + an empty fallback so a
 * transient failure never breaks the form (mirrors `useApiKeys`).
 */
export function useAvailableApiKeys(
  api: ApiClient | null,
  targetNodeId: string | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.availableApiKeys(targetNodeId),
    queryFn: async (): Promise<AvailableApiKeysResponse> => {
      if (!api) return EMPTY;
      return await api.listAvailableApiKeys(targetNodeId);
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    staleTime: 30_000,
    retry: false,
  });
}
