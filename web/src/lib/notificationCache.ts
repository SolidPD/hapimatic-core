// SPDX-License-Identifier: AGPL-3.0-only
// TanStack Query cache upkeep for the notification inbox (issue #4915, epic
// #4912 Sub C). `NotificationListener` calls these on every `notification` /
// `notifications-cleared` SyncEvent so the inbox (Sub D) and the gear badge
// (Sub E) stay live without refetching the list.
import type { QueryClient } from "@tanstack/react-query";
import type { NotificationListResponse, StoredNotification } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

function isUnreadOnlyKey(queryKey: readonly unknown[]): boolean {
  const filter = queryKey[2];
  return (
    typeof filter === "object" &&
    filter !== null &&
    (filter as { unreadOnly?: unknown }).unreadOnly === true
  );
}

/**
 * Apply one stored row to every cached inbox list: replace it by id or prepend
 * it, drop it when dismissed (and from an unread-only list when read), and keep
 * the newest-first order the server returns. A list that was never fetched is
 * left alone. An ephemeral row (never persisted) is not added, because the
 * server would never list it and the next refetch would make it vanish.
 *
 * A row bridged from a federation peer arrives without `nodeId` (the event
 * bridge forwards a peer's `notification` event as-is), so an incoming row with no
 * `nodeId` keeps the one the cached copy carries. The inbox's read and dismiss
 * send it, which routes the call straight to the node that holds the row
 * (#4916).
 */
export function applyNotificationToCache(
  queryClient: QueryClient,
  row: StoredNotification
): void {
  if (row.ephemeral) return;
  const lists = queryClient.getQueriesData<NotificationListResponse>({
    queryKey: queryKeys.notificationLists,
  });
  for (const [queryKey, data] of lists) {
    if (!data) continue;
    const drop =
      row.dismissedAt != null ||
      (row.readAt != null && isUnreadOnlyKey(queryKey));
    const existing = data.notifications.find(n => n.id === row.id);
    const merged =
      row.nodeId || !existing?.nodeId
        ? row
        : { ...row, nodeId: existing.nodeId };
    const rest = data.notifications.filter(n => n.id !== row.id);
    const next = drop ? rest : [merged, ...rest];
    next.sort((a, b) => b.lastAt - a.lastAt);
    queryClient.setQueryData<NotificationListResponse>(queryKey, {
      ...data,
      notifications: next,
    });
  }
}

/**
 * Dismiss-all on some node: its `dismissedAt` is that node's clock, so refetch
 * the lists and the count rather than applying the timestamp locally.
 */
export function applyNotificationsCleared(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
}

export type UnreadCountRefresher = {
  /** Requests a refetch of the unread count; bursts collapse into one. */
  schedule(): void;
  /** Cancels a pending refetch (on unmount). */
  cancel(): void;
};

/**
 * A trailing single-timer refresher for the unread count. The count is the
 * server's federation-wide figure and is never incremented locally (Sub G
 * #4921 R7); a burst of events (e.g. 50 tool errors) makes one request.
 */
export function createUnreadCountRefresher(
  queryClient: QueryClient,
  delayMs = 500
): UnreadCountRefresher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({
          queryKey: queryKeys.notificationUnreadCount,
        });
      }, delayMs);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
