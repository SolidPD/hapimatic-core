// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  OpenAiLoginStartResponse,
  OpenAiLoginStatusResponse,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Codex (OpenAI) in-app login actions (issue #3807, epic #3345).
 *
 * `start` runs the synchronous API-key path or begins the device-auth flow;
 * `status`/`cancel` poll/abort the device-auth child. On a terminal `ok` the
 * #3806 provider section is refreshed by invalidating `queryKeys.providerAuthState`
 * (R5) — the API-key path invalidates in `start.onSuccess`; the device-auth path
 * invalidates via `invalidateAuthState()` once the wizard's poll reaches `ok`.
 *
 * No key/token is ever stored client-side: the raw key is passed straight to
 * `start` and never held in this hook or its cache.
 */
export function useOpenAiLogin(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const invalidateAuthState = () =>
    queryClient.invalidateQueries({
      queryKey: queryKeys.providerAuthState,
    });

  const start = useMutation({
    mutationFn: async (input: {
      nodeId: string;
      kind: "api-key" | "device-auth";
      label?: string;
      key?: string;
    }): Promise<OpenAiLoginStartResponse> => {
      if (!api) throw new Error("API unavailable");
      return await api.startOpenAiLogin(input);
    },
    onSuccess: res => {
      // The API-key path completes synchronously — refresh the section on ok.
      // The device-auth path returns `pending`; its refresh happens when the
      // wizard's poll reaches a terminal `ok` (via invalidateAuthState).
      if (res.state === "ok") void invalidateAuthState();
    },
  });

  const status = async (
    nodeId: string,
    loginToken: string
  ): Promise<OpenAiLoginStatusResponse> => {
    if (!api) throw new Error("API unavailable");
    return await api.openAiLoginStatus(nodeId, loginToken);
  };

  const cancel = async (
    nodeId: string,
    loginToken: string
  ): Promise<{ cancelled: boolean }> => {
    if (!api) throw new Error("API unavailable");
    return await api.cancelOpenAiLogin(nodeId, loginToken);
  };

  return { start, status, cancel, invalidateAuthState };
}
