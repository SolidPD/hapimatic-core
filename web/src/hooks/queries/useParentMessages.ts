// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ApiClient } from "@/api/client";
import type { DecryptedMessage } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Fetches the parent session's messages for branch context carry-over.
 * Returns all messages from the parent session so the branch UI can
 * display the conversation history up to the branch point.
 *
 * Skips the query entirely when parentSessionId is null (non-branch sessions).
 */
export function useParentMessages(
  api: ApiClient | null,
  parentSessionId: string | null | undefined
): {
  parentMessages: DecryptedMessage[];
  isLoading: boolean;
} {
  const enabled = Boolean(api && parentSessionId);

  const query = useQuery({
    queryKey: queryKeys.messages(`parent:${parentSessionId ?? "none"}`),
    queryFn: async () => {
      if (!api || !parentSessionId) {
        return { messages: [] as DecryptedMessage[] };
      }
      // Fetch up to 200 messages (the API max per page).
      // For most sessions this captures the full conversation.
      const result = await api.getMessages(parentSessionId, { limit: 200 });
      return { messages: result.messages };
    },
    enabled,
    staleTime: 5 * 60_000, // Parent messages are immutable — cache 5 min
    gcTime: 10 * 60_000,
  });

  // #3508 (Task 2, non-target): already stable — while pending the dep
  // `query.data?.messages` stays `undefined`, so this useMemo returns the same
  // `[]` instance across renders. No module-level constant needed.
  const parentMessages = useMemo(
    () => query.data?.messages ?? [],
    [query.data?.messages]
  );

  return {
    parentMessages,
    isLoading: query.isLoading && enabled,
  };
}
