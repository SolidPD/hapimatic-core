// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompactAtPreferencePatch,
  CompactAtPreferenceResponse,
} from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { porterErrorText } from "@/components/porter/porterErrors";
import { queryKeys } from "@/lib/query-keys";

/**
 * This node's "compact at" preference (issue #6570): when every Claude session
 * this machine starts compacts its context.
 *
 * Server-only, like the Session Handoff switch: the GET is the displayed truth and
 * there is no localStorage mirror, because the value lives in this node's
 * settings.json and the session wrapper reads it from there. A write goes through
 * PUT, a failed one is reported inline (`applyError`), and the key is invalidated
 * when the write settles.
 *
 * Call it ONCE per page (`routes/settings/preferences.tsx`) and pass the result to
 * both `CompactAtSection` and `SessionHandoffSection`, so the handoff hint compares
 * against the same value the Compact-at rows show after an Apply.
 */
export interface UseCompactAtPreference {
  /** The server's value, or `undefined` until the first GET resolves. */
  data: CompactAtPreferenceResponse | undefined;
  loading: boolean;
  /** The GET failed (and no earlier value is cached). */
  failed: boolean;
  /** PUT a patch; the result replaces the cached value. */
  apply: (patch: CompactAtPreferencePatch) => void;
  applying: boolean;
  /** The last failed write's message, cleared by the next write. */
  applyError: string | null;
}

export function useCompactAtPreference(
  api: ApiClient | null
): UseCompactAtPreference {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.compactAtPreference,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getCompactAtPreference();
    },
    enabled: Boolean(api),
  });

  const mutation = useMutation({
    mutationFn: async (patch: CompactAtPreferencePatch) => {
      if (!api) throw new Error("API unavailable");
      return await api.setCompactAtPreference(patch);
    },
    onSuccess: result => {
      queryClient.setQueryData(queryKeys.compactAtPreference, result);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.compactAtPreference,
      });
    },
  });

  const { mutate } = mutation;
  const apply = useCallback(
    (patch: CompactAtPreferencePatch) => mutate(patch),
    [mutate]
  );

  return {
    data: query.data,
    loading: query.isLoading,
    failed: query.isError && query.data === undefined,
    apply,
    applying: mutation.isPending,
    // #6570 F2: the server's sentence, not the HTTP envelope.
    applyError: mutation.isError
      ? porterErrorText(mutation.error, "Failed to save")
      : null,
  };
}
