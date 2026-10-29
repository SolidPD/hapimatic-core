// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { clearOnAppOpen } from "@/lib/pushBadge";

/**
 * Opening the app clears the home-screen badge and closes the delivered
 * notifications (N1, 2026-10-29): on mount while visible, and on every
 * `visibilitychange` back to visible (a resumed PWA fires that, not a
 * remount). Notifications become read only in the in-app inbox; this touches
 * neither the inbox nor its unread count. A browser without the Badging API
 * or `getNotifications` is a no-op.
 */
export function useClearNotificationsOnOpen(): void {
  useEffect(() => {
    if (typeof document === "undefined" || typeof navigator === "undefined") {
      return;
    }
    const clearIfVisible = () => {
      if (document.visibilityState === "visible") {
        void clearOnAppOpen(navigator);
      }
    };
    clearIfVisible();
    document.addEventListener("visibilitychange", clearIfVisible);
    return () =>
      document.removeEventListener("visibilitychange", clearIfVisible);
  }, []);
}
