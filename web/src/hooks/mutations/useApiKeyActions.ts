// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { AddApiKeyRequest } from "@hapi/protocol/schemas";
import { queryKeys } from "@/lib/query-keys";

/**
 * Add / remove stored provider API keys (issue #1955). On success, invalidate
 * the api-keys list query so the page reflects the change promptly. Mirrors
 * `useSetNodeMaxConcurrency`.
 */
export function useApiKeyActions(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const add = useMutation({
    mutationFn: async (input: AddApiKeyRequest) => {
      if (!api) throw new Error("API unavailable");
      return await api.addApiKey(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      if (!api) throw new Error("API unavailable");
      return await api.removeApiKey(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });

  // Probe a stored key and refresh its status (B3 #1956). On success, invalidate
  // the list so the page reflects the new status promptly.
  const validate = useMutation({
    mutationFn: async (id: string) => {
      if (!api) throw new Error("API unavailable");
      return await api.validateApiKey(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });

  return { add, remove, validate };
}
