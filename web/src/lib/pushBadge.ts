// SPDX-License-Identifier: AGPL-3.0-only
// App-badge and delivered-notification handling for the service worker's push
// handler and the open page (N1, 2026-10-29, which replaced #4921's
// unread-count badge). A displayed push sets the badge to 1; opening the app
// clears it and closes the delivered notifications. Window-free so sw.ts can
// bundle it and vitest can test it (sw.ts itself has no test harness), the same
// split as `pushDisplayGate.ts`.

export type BadgeAction = { kind: "set"; count: number } | { kind: "clear" };

/** The subset of `Navigator` / `WorkerNavigator` the badge API needs. */
export type BadgeNavigator = {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

/** The subset of `ServiceWorkerRegistration` that lists shown notifications. */
export type NotificationRegistration = {
  getNotifications?: () => Promise<ReadonlyArray<{ close(): void }>>;
};

/** The subset of `Navigator` the open-app clear needs. */
export type OpenClearNavigator = BadgeNavigator & {
  serviceWorker?: { ready: Promise<NotificationRegistration> };
};

/**
 * The badge for a push the service worker DISPLAYS: 1, whatever the server's
 * unread count, so the badge means "something arrived since you last opened
 * the app". A positive integer because `setAppBadge()` with no argument shows
 * an empty badge on iOS Safari.
 */
export const PUSH_BADGE: BadgeAction = { kind: "set", count: 1 };

/**
 * Apply a badge action. Feature-detected: a browser tab without the Badging
 * API, or a context that rejects the call, is a silent no-op — a badge is
 * cosmetic and must never break a push or a render.
 */
export async function applyBadge(
  nav: BadgeNavigator | null | undefined,
  action: BadgeAction
): Promise<void> {
  if (!nav) return;
  try {
    if (action.kind === "set") {
      if (typeof nav.setAppBadge === "function") {
        await nav.setAppBadge(action.count);
      }
    } else if (typeof nav.clearAppBadge === "function") {
      await nav.clearAppBadge();
    }
  } catch {
    // Badge API unavailable in this context — ignore.
  }
}

/**
 * Close every notification the registration is still showing. Fails soft: a
 * registration without `getNotifications`, a rejected listing, or one
 * notification that refuses to close never stops the rest.
 */
export async function closeDeliveredNotifications(
  registration: NotificationRegistration | null | undefined
): Promise<void> {
  if (!registration || typeof registration.getNotifications !== "function") {
    return;
  }
  let delivered: ReadonlyArray<{ close(): void }>;
  try {
    delivered = await registration.getNotifications();
  } catch {
    return;
  }
  for (const notification of delivered) {
    try {
      notification.close();
    } catch {
      // Already gone, or this context cannot close it — keep going.
    }
  }
}

/**
 * What opening the app does (N1): clear the home-screen badge and close the
 * delivered notifications. The two run independently, so a Badging API that
 * hangs or throws never keeps the banners open. Without a service worker
 * there is nothing to close.
 */
export async function clearOnAppOpen(
  nav: OpenClearNavigator | null | undefined
): Promise<void> {
  if (!nav) return;
  const closeBanners = async () => {
    try {
      const sw = nav.serviceWorker;
      if (!sw) return;
      await closeDeliveredNotifications(await sw.ready);
    } catch {
      // No usable service worker in this context — nothing to close.
    }
  };
  await Promise.all([applyBadge(nav, { kind: "clear" }), closeBanners()]);
}
