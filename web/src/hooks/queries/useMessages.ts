// SPDX-License-Identifier: AGPL-3.0-only
import {
  notifyManager,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ApiClient } from "@/api/client";
import type { DecryptedMessage, MessagesResponse } from "@/types/api";
import { mergeMessages, reconcileOptimisticStore } from "@/lib/messages";
import {
  describeNodeUnavailableAfterRetries,
  describeNodeUnavailable,
  isNodeUnavailableError,
} from "@/lib/nodeAvailability";
import { queryKeys } from "@/lib/query-keys";

// Stable empty default so the client-only optimistic-store read never returns a
// fresh array identity on each render (issue #2556).
const EMPTY_BUBBLES: DecryptedMessage[] = [];

export function useMessages(
  api: ApiClient | null,
  sessionId: string | null,
  // #1083: session-peek options. `limit` overrides ONLY the initial page size
  // (see queryFn); `enabled` gates the fetch so a per-row peek does not fire on
  // every row mount — it only fires when the peek is open.
  options?: { limit?: number; enabled?: boolean }
): {
  messages: DecryptedMessage[];
  warning: string | null;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => Promise<unknown>;
  refetch: () => Promise<unknown>;
} {
  const resolvedSessionId = sessionId ?? "unknown";
  const queryClient = useQueryClient();
  const query = useInfiniteQuery<MessagesResponse>({
    queryKey: queryKeys.messages(resolvedSessionId),
    queryFn: async ({ pageParam }) => {
      if (!api || !sessionId) {
        throw new Error("Messages unavailable");
      }
      const beforeSeq = typeof pageParam === "number" ? pageParam : null;
      // Initial page (beforeSeq === null) stays small for fast session-open;
      // every "Load older" page fetches deeper (200) — issue #2415. #1083: the
      // session-peek overrides ONLY the initial page size (options.limit) so its
      // last-25 glance shares this query's cache with the full session view; the
      // "Load older" branch stays 200 so pagination depth is unchanged.
      const limit = beforeSeq === null ? (options?.limit ?? 50) : 200;
      return await api.getMessages(sessionId, { limit, beforeSeq });
    },
    initialPageParam: null,
    getNextPageParam: lastPage =>
      lastPage.page.hasMore ? lastPage.page.nextBeforeSeq : undefined,
    // #1083: default enabled (true) preserves every existing caller; the peek
    // passes enabled:false until it is open so the query stays idle per row.
    enabled: Boolean(api && sessionId) && (options?.enabled ?? true),
  });

  // Issue #2556: client-only optimistic bubble store. It is never fetched from
  // the server (enabled: false) — it is written by useSendMessage and read here
  // so a poll refetch of the messages query (which replaces query.data.pages
  // with server-only messages) cannot wipe an attempted-and-failed send.
  const { data: optimisticStore = EMPTY_BUBBLES } = useQuery<
    DecryptedMessage[]
  >({
    queryKey: queryKeys.optimisticMessages(resolvedSessionId),
    queryFn: () => EMPTY_BUBBLES,
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    initialData: EMPTY_BUBBLES,
  });

  const { messages, survivingStore } = useMemo(() => {
    // #3508 (Task 2, non-target): this empty-array fallback is INTERNAL to the
    // useMemo — the returned `messages` identity is memo-stable and the hook seeds
    // EMPTY_BUBBLES initialData, so no fresh per-render array reaches consumers.
    const pages = query.data?.pages ?? [];
    let serverMerged: DecryptedMessage[] = [];
    for (const page of pages) {
      serverMerged = mergeMessages(serverMerged, page.messages);
    }
    // Merge the optimistic store INTO the server messages (store as `existing`,
    // server as `incoming`) so mergeMessages de-dupes a bubble whose server echo
    // has arrived, while failed/sending bubbles with no echo survive.
    const { merged, survivingStore } = reconcileOptimisticStore(
      optimisticStore,
      serverMerged
    );
    return { messages: merged, survivingStore };
  }, [query.data?.pages, optimisticStore]);

  // Prune the store to the bubbles still shown — a bubble the server has echoed
  // was dropped from `messages` by mergeMessages, so drop it from the store too
  // (keeps the store bounded; cannot resurrect an already-delivered message).
  useEffect(() => {
    if (survivingStore.length !== optimisticStore.length) {
      queryClient.setQueryData<DecryptedMessage[]>(
        queryKeys.optimisticMessages(resolvedSessionId),
        survivingStore
      );
    }
  }, [survivingStore, optimisticStore, queryClient, resolvedSessionId]);

  const warning = useMemo(() => {
    if (!query.error) return null;
    // #5375: the session's node stayed offline past the retry budget — say so
    // in words instead of the raw `HTTP 503 : {…}` text.
    if (isNodeUnavailableError(query.error)) {
      return describeNodeUnavailableAfterRetries(query.error);
    }
    return query.error instanceof Error
      ? query.error.message
      : "Failed to load messages";
  }, [query.error]);

  const loadMore = async () => {
    if (!query.hasNextPage || query.isFetchingNextPage) return;
    await query.fetchNextPage();
  };

  return {
    messages,
    warning,
    isLoading: query.isLoading,
    isLoadingMore: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
    loadMore,
    refetch: query.refetch,
  };
}

/**
 * #5375: the reconnecting notice for a session's messages, read straight from
 * the query cache (no second fetch observer, no prop threading). While TanStack
 * retries a node_offline / node_unreachable error it keeps `error` null and
 * records the attempt's error as `fetchFailureReason` (cleared when a new fetch
 * starts or succeeds), so the notice shows exactly for that window — on a cold
 * open as well as on a loaded thread. Returns null otherwise, including once the
 * retry budget is spent and `error` is set (`useMessages`' warning takes over).
 */
export function useMessagesReconnecting(
  sessionId: string | null
): string | null {
  const queryClient = useQueryClient();
  const resolvedSessionId = sessionId ?? "unknown";
  // batchCalls, as TanStack's own hooks do: the cache notifies synchronously,
  // possibly while another component renders, so the update is deferred to
  // the notify manager's batch instead of setting state mid-render.
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onChange)),
    [queryClient]
  );
  const getSnapshot = useCallback((): string | null => {
    const state = queryClient.getQueryState(
      queryKeys.messages(resolvedSessionId)
    );
    if (!state || state.error) return null;
    return isNodeUnavailableError(state.fetchFailureReason)
      ? describeNodeUnavailable(state.fetchFailureReason)
      : null;
  }, [queryClient, resolvedSessionId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
