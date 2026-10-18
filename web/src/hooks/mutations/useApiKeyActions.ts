// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  AddApiKeyRequest,
  PatchApiKeyRequest,
} from "@hapi/protocol/schemas";
import { queryKeys } from "@/lib/query-keys";

/** gemini and google keys are Google accounts too (#4463 R3). */
function isGoogleProvider(provider: string | undefined): boolean {
  return provider === "gemini" || provider === "google";
}

/**
 * Add / update / remove / validate stored provider API keys (issue #1955). On
 * success, invalidate the api-keys list query so the page reflects the change
 * promptly. Mirrors `useSetNodeMaxConcurrency`.
 *
 * #4463: a gemini/google key has its own Google account (minted on add, given
 * the key's name on update, removed with the key), so those mutations also
 * invalidate every account-side read that lists or reports it.
 */
export function useApiKeyActions(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const invalidate = (provider?: string) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    if (isGoogleProvider(provider)) {
      for (const queryKey of [
        queryKeys.accounts,
        queryKeys.accountUsage,
        queryKeys.providerAuthState,
        queryKeys.accountHealth,
      ]) {
        queryClient.invalidateQueries({ queryKey });
      }
    }
  };

  const add = useMutation({
    mutationFn: async (input: AddApiKeyRequest) => {
      if (!api) throw new Error("API unavailable");
      return await api.addApiKey(input);
    },
    onSuccess: entry => invalidate(entry.provider),
  });

  // #4463 R6: one PATCH sets the key's name and monogram.
  const update = useMutation({
    mutationFn: async (input: { id: string; body: PatchApiKeyRequest }) => {
      if (!api) throw new Error("API unavailable");
      return await api.updateApiKey(input.id, input.body);
    },
    onSuccess: entry => invalidate(entry.provider),
  });

  // The provider rides the call so a removed Gemini key's account reads refresh
  // too (the DELETE answers with the REMAINING keys, not the removed one).
  const remove = useMutation({
    mutationFn: async (input: string | { id: string; provider?: string }) => {
      if (!api) throw new Error("API unavailable");
      const id = typeof input === "string" ? input : input.id;
      return await api.removeApiKey(id);
    },
    onSuccess: (_remaining, input) =>
      invalidate(typeof input === "string" ? undefined : input.provider),
  });

  // Probe a stored key and refresh its status (B3 #1956). On success, invalidate
  // the list so the page reflects the new status promptly. `force` (#4463 R5)
  // bypasses the server's validation cache.
  const validate = useMutation({
    mutationFn: async (input: string | { id: string; force?: boolean }) => {
      if (!api) throw new Error("API unavailable");
      return typeof input === "string"
        ? await api.validateApiKey(input)
        : await api.validateApiKey(input.id, { force: input.force });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys });
    },
  });

  return { add, update, remove, validate };
}
