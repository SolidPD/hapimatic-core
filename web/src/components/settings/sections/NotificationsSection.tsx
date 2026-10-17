// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from "react";
import { useAppContext } from "@/lib/app-context";
import { NotificationSettingsBody } from "@/components/NotificationSettings";

/**
 * NotificationsSection — the notification settings on Settings → Notifications
 * (Sub-Issue D, #1038; folded onto Preferences by the Settings sidebar
 * reorganization, then back onto its own page by #4906).
 *
 * Renders the same `NotificationSettingsBody` content as the legacy notification
 * modal so the two surfaces stay behaviorally identical (the modal is retained
 * for the top-bar bell until Sub-Issue I, #1043, removes it).
 *
 * R4: on unmount (drawer close or navigation away) this fires APP's
 * `refreshPushSubscription` — exposed via AppContext — exactly once per visit.
 * App's own `usePushNotifications` instance drives the top-bar bell; a
 * section-local instance's refresh would be a no-op for the bell. This mirrors
 * the modal's existing on-close refresh.
 *
 * Rendered inside `routes/settings/notifications.tsx` under the `#preferences`
 * anchor; the menu's top-level "Notifications" row opens that page.
 */
export function NotificationsSection() {
  const { api, refreshPushSubscription } = useAppContext();

  useEffect(() => {
    return () => {
      void refreshPushSubscription?.();
    };
  }, [refreshPushSubscription]);

  return <NotificationSettingsBody api={api} />;
}
