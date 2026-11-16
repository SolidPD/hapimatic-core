// SPDX-License-Identifier: AGPL-3.0-only
// Issue #3150: read-only "is push delivery globally active on THIS device?" —
// the subscription state the Settings → Notifications
// Enable/Disable control manages. usePushNotifications owns the mutating
// subscribe/unsubscribe flow (and needs an ApiClient for it); this hook is the
// cheap read-only mirror a consumer can mount without one. Global-off ≡
// push unsupported, permission not granted, or no live push subscription — in
// all three, no session on this device can deliver a notification.
//
// Issue #6660: the per-session mute moved from a bell in every session row to
// the kebab menu, and that menu's cluster is mounted on every row. So the check
// runs only while `active` (the menu is open), again at each opening, instead of
// once per mounted row.
import { useEffect, useState } from "react";

function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * How long to wait for a service-worker registration before reading "off".
 * `navigator.serviceWorker.ready` never settles on a page with no registration,
 * and the menu entry awaits this check when the user selects it before the
 * first reading arrived, so an unbounded wait would leave the tap doing nothing.
 */
const SERVICE_WORKER_READY_TIMEOUT_MS = 3000;

/**
 * One reading of the device's push state. Fail-closed: unsupported, permission
 * not granted, no subscription, an error, or no service worker within the
 * timeout all read false.
 */
export async function checkGlobalNotificationsEnabled(): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>(resolve => {
        timer = setTimeout(
          () => resolve(null),
          SERVICE_WORKER_READY_TIMEOUT_MS
        );
      }),
    ]);
    if (!registration) return false;
    const subscription = await registration.pushManager.getSubscription();
    return Boolean(subscription);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The device's push state, checked each time `active` turns true. `null` until
 * the first check settles; after that, the last result (so a reopened menu shows
 * the previous reading while the new one runs).
 */
export function useGlobalNotificationsEnabled(
  active: boolean = true
): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void checkGlobalNotificationsEnabled().then(value => {
      if (!cancelled) setEnabled(value);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  return enabled;
}
