// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { INBOX_PAGE_LIMIT } from "@/lib/notificationInbox";

/**
 * Notification inbox queries (issue #4915, epic #4912 Sub C). The cache is kept
 * live by `NotificationListener`: every `notification` SyncEvent patches the
 * cached lists in place and refetches the unread count. The inbox on Settings →
 * Notifications (Sub D #4916) renders from `useNotificationList`; Sub G (#4921)
 * mirrors `useNotificationUnreadCount` to the app badge.
 *
 * The app's QueryClient turns `refetchOnWindowFocus` off
 * (`web/src/lib/query-client.ts`). The unread count opts back in, so the badge
 * is right when the app returns to the foreground, and it also polls every
 * 30 s. The list does not refetch on focus: the inbox passes its own
 * `refetchInterval` and refetches when the event stream reconnects.
 */
export function useNotificationList(
  api: ApiClient | null,
  options: {
    unreadOnly?: boolean;
    enabled?: boolean;
    /** Poll interval while mounted; omitted means no poll. */
    refetchInterval?: number | false;
  } = {}
) {
  const unreadOnly = options.unreadOnly ?? false;
  return useQuery({
    queryKey: queryKeys.notificationList(unreadOnly),
    queryFn: async () => {
      if (!api) return { notifications: [] };
      // One page of the server's maximum: a paged query would break the cache
      // shape `applyNotificationToCache` patches (#4916 D4).
      return await api.getNotifications({
        unread: unreadOnly,
        limit: INBOX_PAGE_LIMIT,
      });
    },
    enabled: (options.enabled ?? true) && Boolean(api),
    staleTime: 30_000,
    refetchInterval: options.refetchInterval,
  });
}

/**
 * The server's unread count (unread AND undismissed, across federated nodes).
 * Never incremented locally: the hub's count is a fan-out, so a local guess
 * drifts. Polls every 30 s as the fallback when an event is missed.
 */
export function useNotificationUnreadCount(
  api: ApiClient | null,
  options: { enabled?: boolean } = {}
) {
  return useQuery({
    queryKey: queryKeys.notificationUnreadCount,
    queryFn: async () => {
      if (!api) return { count: 0 };
      return await api.getNotificationUnreadCount();
    },
    enabled: (options.enabled ?? true) && Boolean(api),
    staleTime: 30_000,
    refetchInterval: 30_000,
    // #4921 R7: refetch when the app returns to the foreground, overriding the
    // app-wide `refetchOnWindowFocus: false`. The badge mirror reads this query,
    // and it replaces App.tsx's old clear-on-visible: a backgrounded iOS PWA
    // shows the true count on return instead of waiting for the next poll.
    refetchOnWindowFocus: "always",
  });
}
