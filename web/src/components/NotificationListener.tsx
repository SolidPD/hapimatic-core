// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/Toast";
import type { StoredNotification } from "@/types/api";
import { readNotificationPreferences } from "@/lib/notificationPreferences";
import {
  createToastGate,
  formatNotificationToast,
  type ToastGate,
  type ToastGatePreferences,
} from "@/lib/notificationToast";
import {
  applyNotificationToCache,
  applyNotificationsCleared,
  createUnreadCountRefresher,
  type UnreadCountRefresher,
} from "@/lib/notificationCache";

/** Enough of a row to act on; `useSSE` forwards the event unvalidated. */
function isNotificationRow(value: unknown): value is StoredNotification {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.title === "string" &&
    typeof v.kind === "string" &&
    typeof v.lastAt === "number"
  );
}

/**
 * The preferences, or all-on when localStorage throws: a broken store must not
 * silence an `error` notification the user never turned off.
 */
function readPreferencesFailOpen(): ToastGatePreferences {
  try {
    return readNotificationPreferences();
  } catch (error) {
    console.warn(
      "[NotificationListener] could not read preferences; showing pop-ups with defaults",
      error
    );
    return {};
  }
}

/**
 * The one Lane 2 listener (issue #4915, epic #4912 Sub C). It replaced seven
 * `*ToastListener` components: every `notification` SyncEvent (re-emitted by
 * `useSSE` as `hapi:notification`) updates the inbox cache and the unread
 * count, and pops up only when "Show pop-ups", the kind's toggle, the
 * post-reconnect window and the per-minute budget all allow it (the policy is
 * in `@/lib/notificationToast`). Lane 1 feedback toasts never pass through
 * here, so "Show pop-ups: off" never silences a reply to the user's own click.
 *
 * Lives inside ToastProvider (App.tsx) so `useToast()` resolves to the real
 * provider, whose MAX_VISIBLE cap and 2 s dedup stay the last line of the #1612
 * burst protection.
 */
export function NotificationListener(): null {
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const gateRef = useRef<ToastGate | null>(null);
  const gate = gateRef.current ?? (gateRef.current = createToastGate());
  const refresherRef = useRef<UnreadCountRefresher | null>(null);

  useEffect(() => {
    const refresher = createUnreadCountRefresher(queryClient);
    refresherRef.current = refresher;
    return () => {
      refresher.cancel();
      refresherRef.current = null;
    };
  }, [queryClient]);

  // #1612: a reconnect-delivered backlog must never flood the renderer.
  useEffect(() => {
    const onConnect = () => gate.onReconnect();
    window.addEventListener("hapi:sseConnected", onConnect);
    return () => window.removeEventListener("hapi:sseConnected", onConnect);
  }, [gate]);

  useEffect(() => {
    const onNotification = (e: Event) => {
      try {
        const row = (e as CustomEvent<unknown>).detail;
        if (!isNotificationRow(row)) {
          console.warn("[NotificationListener] malformed notification", row);
          return;
        }
        applyNotificationToCache(queryClient, row);
        refresherRef.current?.schedule();

        if (gate.decide(row, readPreferencesFailOpen()) !== "show") return;
        const toast = formatNotificationToast(row);
        // Keep this the ONE showToast call site. #4921: a session row's
        // toast carries its session title as the first line.
        showToast(toast.message, {
          type: toast.type,
          duration: toast.duration,
          ...(toast.title ? { title: toast.title } : {}),
          ...(toast.action ? { action: toast.action } : {}),
        });
        gate.noteShown(row);
      } catch (error) {
        console.warn(
          "[NotificationListener] failed to handle notification",
          error
        );
      }
    };
    const onCleared = () => {
      try {
        applyNotificationsCleared(queryClient);
      } catch (error) {
        console.warn("[NotificationListener] failed to handle clear", error);
      }
    };
    window.addEventListener("hapi:notification", onNotification);
    window.addEventListener("hapi:notificationsCleared", onCleared);
    return () => {
      window.removeEventListener("hapi:notification", onNotification);
      window.removeEventListener("hapi:notificationsCleared", onCleared);
    };
  }, [gate, queryClient, showToast]);

  return null;
}
