// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ExtensionSummary } from "@hapi/protocol/ext";
import { type ApiClient } from "@/api/client";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { queryKeys } from "@/lib/query-keys";

/**
 * Toggle one extension's enable state — backs the Admin → Extensions page
 * (issue #2329). Writes `PUT /api/extension-prefs/:id` (authenticated), which
 * persists through the existing `ExtensionPrefsStore.set()` upsert.
 *
 * On success the registry query is invalidated so the list reflects the change.
 *
 * The server's `error` string is surfaced verbatim rather than swallowed, because
 * the two rejection cases are user-meaningful: 409 `required_at_build` (the
 * extension is mandatory — the UI should already render it non-toggleable, so a
 * 409 here means a stale registry) and 404 `unknown_extension`.
 */
export function useExtensionPrefActions(api: ApiClient | null) {
  const queryClient = useQueryClient();

  const setEnabled = useMutation({
    mutationFn: async (input: {
      id: string;
      enabled: boolean;
    }): Promise<ExtensionSummary> => {
      if (!api) throw new Error("API unavailable");
      try {
        return await api.extensionRequest<ExtensionSummary>(
          `/api/extension-prefs/${encodeURIComponent(input.id)}`,
          { method: "PUT", body: JSON.stringify({ enabled: input.enabled }) }
        );
      } catch (err) {
        // Surface the server's message so `required_at_build` /
        // `unknown_extension` are visible instead of a generic HTTP failure.
        throw new Error(apiErrorMessage(err));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.extensionRegistry });
    },
  });

  return { setEnabled };
}
