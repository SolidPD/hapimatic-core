// SPDX-License-Identifier: AGPL-3.0-only
// Issue #3150: read-only "is push delivery globally active on THIS device?" —
// the subscription state the Settings → Preferences → Notifications
// Enable/Disable control manages. usePushNotifications owns the mutating
// subscribe/unsubscribe flow (and needs an ApiClient for it); this hook is the
// cheap read-only mirror per-row consumers can mount without one. Global-off ≡
// push unsupported, permission not granted, or no live push subscription — in
// all three, no session on this device can deliver a notification.
import { useEffect, useState } from "react";

function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function useGlobalNotificationsEnabled(): boolean {
  // Defaults false (gray "not active" bell) until the async check proves a live
  // subscription — fail-closed matches the semantic: unknown ⇒ can't notify.
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      if (!isPushSupported() || Notification.permission !== "granted") {
        if (!cancelled) setEnabled(false);
        return;
      }
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!cancelled) setEnabled(Boolean(subscription));
      } catch {
        if (!cancelled) setEnabled(false);
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);

  return enabled;
}
