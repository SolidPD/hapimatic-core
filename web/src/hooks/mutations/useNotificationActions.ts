// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@/api/client";
import type { NotificationListResponse, StoredNotification } from "@/types/api";
import { useToast } from "@/components/Toast";
import { applyNotificationToCache } from "@/lib/notificationCache";
import { queryKeys } from "@/lib/query-keys";

/**
 * A 404 means no row with that id exists in the namespace any more (purged
 * after 48 hours, or not this namespace's). Read and dismiss are idempotent on
 * the server, so an already-dismissed row answers 200, not 404.
 */
function isGone(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** The nodes a dismiss-all 502 names as not having dismissed their rows. */
function failedNodeCount(err: unknown): number {
  if (!(err instanceof ApiError) || err.status !== 502 || !err.body) return 0;
  try {
    const parsed = JSON.parse(err.body) as { failedNodes?: unknown };
    return Array.isArray(parsed.failedNodes) ? parsed.failedNodes.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Read, dismiss and clear-all for the notification inbox (issue #4916, epic
 * #4912 Sub D). All three are optimistic. Read and dismiss go through the same
 * `applyNotificationToCache` the SyncEvent listener uses, so the user's action
 * and the server's echo of it converge on one code path; clear-all empties the
 * cached lists directly.
 *
 * - Every `onMutate` cancels in-flight list fetches first, so an older fetch
 *   cannot land after the optimistic write and bring a dismissed row back.
 * - A read's answer is written back only while the row is still listed, so a
 *   read that returns after the row was dismissed or cleared cannot re-add it.
 *   A dismiss applies the server's dismissed row and refetches the lists, so a
 *   list read that raced the dismiss cannot keep the row either.
 * - Read and dismiss roll back ONE row on failure by re-applying the original;
 *   a whole-list snapshot restore would also erase rows a SyncEvent added
 *   meanwhile. A 404 means the row is gone, so it is dropped, not restored.
 * - Clear-all is not rolled back: on a 502 the local node and the reachable
 *   peers have already dismissed theirs. It refetches the lists and the count
 *   on settle so the inbox shows what the server kept.
 * - The unread count is the server's figure and is only invalidated, never set
 *   (Sub C / Sub G R7). Read and dismissed state live on the server only
 *   (epic decision D2): nothing here touches localStorage.
 */
export function useNotificationActions(api: ApiClient | null): {
  markRead: (row: StoredNotification) => void;
  dismiss: (row: StoredNotification) => void;
  dismissAll: () => Promise<void>;
} {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  const cancelLists = () =>
    queryClient.cancelQueries({ queryKey: queryKeys.notificationLists });
  const invalidateLists = () =>
    void queryClient.invalidateQueries({
      queryKey: queryKeys.notificationLists,
    });
  const invalidateCount = () =>
    void queryClient.invalidateQueries({
      queryKey: queryKeys.notificationUnreadCount,
    });
  const isListed = (id: string) =>
    queryClient
      .getQueriesData<NotificationListResponse>({
        queryKey: queryKeys.notificationLists,
      })
      .some(([, data]) => data?.notifications.some(r => r.id === id));

  const readMutation = useMutation({
    mutationFn: async (row: StoredNotification) => {
      if (!api) throw new Error("API unavailable");
      const res = await api.markNotificationRead(row.id, row.nodeId);
      return res.notification;
    },
    onMutate: async (row: StoredNotification) => {
      await cancelLists();
      applyNotificationToCache(queryClient, { ...row, readAt: Date.now() });
    },
    onSuccess: serverRow => {
      if (isListed(serverRow.id)) {
        applyNotificationToCache(queryClient, serverRow);
      }
      invalidateCount();
    },
    onError: (err, row) => {
      if (isGone(err)) {
        applyNotificationToCache(queryClient, {
          ...row,
          dismissedAt: Date.now(),
        });
      } else {
        applyNotificationToCache(queryClient, row);
        console.warn("[useNotificationActions] mark-read failed", err);
      }
      invalidateLists();
      invalidateCount();
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (row: StoredNotification) => {
      if (!api) throw new Error("API unavailable");
      const res = await api.dismissNotification(row.id, row.nodeId);
      return res.notification;
    },
    onMutate: async (row: StoredNotification) => {
      await cancelLists();
      applyNotificationToCache(queryClient, {
        ...row,
        dismissedAt: Date.now(),
      });
    },
    onSuccess: serverRow => {
      applyNotificationToCache(queryClient, serverRow);
      invalidateLists();
      invalidateCount();
    },
    onError: (err, row) => {
      if (!isGone(err)) {
        applyNotificationToCache(queryClient, row);
        showToast("Couldn't dismiss the notification", { type: "error" });
      }
      invalidateLists();
      invalidateCount();
    },
  });

  const dismissAllMutation = useMutation({
    mutationFn: async () => {
      if (!api) throw new Error("API unavailable");
      await api.dismissAllNotifications();
    },
    onMutate: async () => {
      await cancelLists();
      const lists = queryClient.getQueriesData<NotificationListResponse>({
        queryKey: queryKeys.notificationLists,
      });
      for (const [queryKey, data] of lists) {
        if (!data) continue;
        queryClient.setQueryData<NotificationListResponse>(queryKey, {
          ...data,
          notifications: [],
        });
      }
    },
    onError: err => {
      const failed = failedNodeCount(err);
      showToast(
        failed > 0
          ? `Couldn't clear notifications on ${failed} node(s)`
          : "Couldn't clear notifications",
        { type: "error" }
      );
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
  });

  return {
    markRead: row => readMutation.mutate(row),
    dismiss: row => dismissMutation.mutate(row),
    dismissAll: async () => {
      await dismissAllMutation.mutateAsync();
    },
  };
}
