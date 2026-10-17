// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SupportChannelInfo } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * The in-app support channel (issue #4371): where "Contact a human" sends, the
 * human-support hours text, and the support workspace path that identifies a
 * support session. Static for the server process's lifetime, so it is cached
 * for the session (`staleTime: Infinity`). Goes through the authed `ApiClient`
 * (the endpoint is behind the JWT gate). `null` while loading, on error, or
 * without an api client. A failed request is retried twice; callers check
 * `isError` so the lifeline shows the open-an-issue path instead of waiting
 * forever on a result that will not come.
 */
export function useSupportChannel(api: ApiClient | null): {
  channel: SupportChannelInfo | null;
  isLoading: boolean;
  isError: boolean;
} {
  const query = useQuery<SupportChannelInfo | null>({
    queryKey: queryKeys.supportChannel,
    queryFn: async () => (api ? await api.getSupportChannel() : null),
    enabled: Boolean(api),
    retry: 2,
    staleTime: Infinity,
  });
  return {
    channel: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
