// SPDX-License-Identifier: AGPL-3.0-only
/// <reference lib="webworker" />
import { precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { getCacheNameForServiceWorker } from "@/lib/storage-keys";
import { decidePushAction } from "@/lib/pushDisplayGate";
import { applyBadge, decidePushBadge } from "@/lib/pushBadge";
import { withoutWebManifest } from "@/lib/precacheEntries";
import {
  boundedFetchPlugin,
  unlessReplacementWaiting,
} from "@/lib/swRouteGuards";
// Type-only (erased at build): the app module itself is window-bound and must
// never be bundled into the service worker — see pushDisplayGate.ts.
import type { NotificationPreferences } from "@/lib/notificationPreferences";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

// Issue #1793: do NOT force skipWaiting() on install. A freshly-deployed SW
// (when a controller already exists) now parks in the "waiting" state instead
// of taking over immediately — that is what lets "prompt" mode surface the
// user-controlled "tap to reload" affordance (surfaced by the single
// UpdateAvailableBadge update bar, #3057). The waiting SW activates only when the user taps
// reload, which posts { type: "SKIP_WAITING" } below. First install (no existing
// controller) still activates immediately — skipWaiting only matters on update.
//
// precacheAndRoute() installs its own workbox install handler for precaching, so
// removing our explicit skipWaiting install listener does not affect precaching.
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

type PushPayload = {
  title: string;
  body?: string;
  icon?: string;
  badge?: string;
  tag?: string;
  data?: {
    type?: string;
    sessionId?: string;
    url?: string;
  };
  // Issue #4921: the server's unread count at send time (PushBadgeFields in
  // shared/src/notifications.ts); absent from an older server.
  unreadCount?: number;
};

// Instance-specific cache name to prevent cross-contamination between instances
const PREFERENCES_CACHE_NAME = getCacheNameForServiceWorker(
  "notification-preferences"
);
// Issue #4836: root-relative so it resolves to the same entry the page writes
// from any route; must stay identical to PREFERENCES_KEY in
// @/lib/notificationPreferences (see the comment there).
const PREFERENCES_KEY = "/preferences.json";

async function getNotificationPreferences(): Promise<NotificationPreferences> {
  const defaultPrefs: NotificationPreferences = {
    permissions: true,
    questions: true,
    ready: true,
    errors: true,
    stalls: true,
    usage: true,
    // Issue #4915: the pop-up switch and the per-kind toggles default on, so an
    // older cached snapshot that lacks them never silences a push.
    showPopups: true,
    toolErrors: true,
    promptBlocked: true,
    apiErrors: true,
    accountUnrefreshable: true,
    sessionRestartFailed: true,
    spawnFailed: true,
    waitingForSlot: true,
    loopsResuming: true,
    modelReverted: true,
    mutedSessions: [],
    globalOptOut: false,
  };

  try {
    const cache = await caches.open(PREFERENCES_CACHE_NAME);
    const response = await cache.match(PREFERENCES_KEY);
    if (!response) {
      return defaultPrefs;
    }
    const prefs = await response.json();
    return { ...defaultPrefs, ...prefs };
  } catch {
    return defaultPrefs;
  }
}

// #4797: the manifest always goes to the network — the server picks its identity
// per instance, and a precached copy would pin an existing client to production.
// #4924: the precache route is NOT wrapped in `whileCurrent` below. It answers
// from Cache Storage (nothing for the swap to wait on), and it is the only place
// the running bundle's lazily loaded chunks still exist once the server has
// moved on to a newer build.
precacheAndRoute(withoutWebManifest(self.__WB_MANIFEST));

// #4924: while a newer worker waits, this (outgoing) worker hands every runtime
// request straight to the network. Chromium swaps workers only once the outgoing
// one has no event in flight (or after 5 minutes), so without this a busy hub
// kept the "A new version of the app is ready" bar on screen for 5 minutes after
// the tap. Separately, and at all times, every API-route fetch gives up after
// 30 s (the page's own ApiClient timeout), so an API request already in flight
// when the replacement installed still finishes first, within the bound. The
// asset routes (CDN, /ext-assets/) take only the guard: the bound also cuts the
// response body, and nothing on the page gives up on a slow asset at 30 s.
// Every registerRoute below must use `whileCurrent`, and every /api/ route must
// also carry `boundedFetch` (src/lib/swRouteGuards.test.ts checks this file).
const whileCurrent = <A>(match: (arg: A) => boolean) =>
  unlessReplacementWaiting(match, () => self.registration);
const boundedFetch = boundedFetchPlugin();

registerRoute(
  whileCurrent(({ url }: { url: URL }) => url.pathname === "/api/sessions"),
  new NetworkFirst({
    cacheName: "api-sessions",
    networkTimeoutSeconds: 10,
    plugins: [
      boundedFetch,
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 60 * 5,
      }),
    ],
  })
);

/**
 * Session detail waits longer than the other API routes before falling back to
 * its own cache (#5410). For a session on a hung federation peer the hub gives
 * up after its 25 s read budget (`FEDERATION_READ_TIMEOUT_MS`,
 * server/src/federation/proxyFetchSignal.ts) and falls back to its own cached
 * session summary (`GET /api/sessions/:id` in server/src/web/routes/
 * sessions.ts). A shorter timeout served this worker's older (up to 5 min)
 * copy before the hub's answer could arrive. 28 s stays below the browser's
 * 30 s request timeout (`ApiClient` `DEFAULT_TIMEOUT_MS`,
 * web/src/api/client.ts). Offline use still gets the cache: an offline fetch
 * fails at once, without waiting for this timeout.
 */
const SESSION_DETAIL_NETWORK_TIMEOUT_SECONDS = 28;

registerRoute(
  whileCurrent(({ url }: { url: URL }) =>
    /^\/api\/sessions\/[^/]+$/.test(url.pathname)
  ),
  new NetworkFirst({
    cacheName: "api-session-detail",
    networkTimeoutSeconds: SESSION_DETAIL_NETWORK_TIMEOUT_SECONDS,
    plugins: [
      boundedFetch,
      new ExpirationPlugin({
        maxEntries: 20,
        maxAgeSeconds: 60 * 5,
      }),
    ],
  })
);

registerRoute(
  whileCurrent(({ url }: { url: URL }) => url.pathname === "/api/machines"),
  new NetworkFirst({
    cacheName: "api-machines",
    networkTimeoutSeconds: 10,
    plugins: [
      boundedFetch,
      new ExpirationPlugin({
        maxEntries: 5,
        maxAgeSeconds: 60 * 10,
      }),
    ],
  })
);

// The two CDN routes were `RegExp` captures. Workbox matches a cross-origin URL
// against a RegExp only from index 0; the `^` anchors keep that semantics in the
// function form the guard needs.
registerRoute(
  whileCurrent(({ url }: { url: URL }) =>
    /^https:\/\/cdn\.socket\.io\//.test(url.href)
  ),
  new CacheFirst({
    cacheName: "cdn-socketio",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 5,
        maxAgeSeconds: 60 * 60 * 24 * 30,
      }),
    ],
  })
);

registerRoute(
  whileCurrent(({ url }: { url: URL }) =>
    /^https:\/\/telegram\.org\//.test(url.href)
  ),
  new CacheFirst({
    cacheName: "cdn-telegram",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 5,
        maxAgeSeconds: 60 * 60 * 24 * 7,
      }),
    ],
  })
);

// #1294: runtime extension bundles served from /ext-assets/<id>/dist/. These are
// NOT in __WB_MANIFEST (they're runtime filesystem assets, not build output), so
// without this route they'd pass straight to network. NetworkFirst gives offline
// support while always preferring the freshest bundle; extension builds SHOULD
// content-hash their filenames so a version bump busts the cache. Inert unless a
// runtime extension is loaded (HAPI_FS_EXTENSIONS on) — no /ext-assets/* traffic
// otherwise.
registerRoute(
  whileCurrent(({ url }: { url: URL }) =>
    url.pathname.startsWith("/ext-assets/")
  ),
  new NetworkFirst({
    cacheName: "ext-assets",
    plugins: [
      new ExpirationPlugin({
        maxEntries: 60,
        maxAgeSeconds: 60 * 60 * 24 * 7,
      }),
    ],
  })
);

self.addEventListener("push", event => {
  const payload = event.data?.json() as PushPayload | undefined;
  if (!payload) {
    return;
  }

  event.waitUntil(
    (async () => {
      const prefs = await getNotificationPreferences();
      const action = decidePushAction(
        prefs,
        payload.data?.type,
        payload.data?.sessionId
      );

      // Show a notification ONLY on an explicit "display" — anything else
      // shows nothing, so a future edit that drops a branch fails safe.
      if (action !== "display") {
        // Issue #4836: the user disabled notifications on this origin. Remove
        // the push subscription; the push service then rejects the server's
        // next send with 404/410 and the server prunes the row
        // (pushService.ts). See decidePushAction for why dropping alone is not
        // enough.
        if (action === "unsubscribe") {
          try {
            const subscription =
              await self.registration.pushManager.getSubscription();
            await subscription?.unsubscribe();
          } catch {
            // Fail soft — the app reconciles on its next load (App.tsx).
          }
        }
        // "drop": per-type toggle off, or a muted session (issue #87).
        return;
      }

      // Detect dev instance based on hostname or port
      // Dev: hostname contains 'hapi-dev' (Tailscale Services) OR port 3009/8443
      const hostname = self.location.hostname;
      const port = self.location.port;
      const isDev =
        hostname.includes("hapi-dev") || port === "3009" || port === "8443";
      const iconsPath = isDev ? "/icons" : "/icons-production";
      const defaultTitle = isDev ? "Hapimatic DEV" : "Hapimatic";

      const title = payload.title || defaultTitle;
      const body = payload.body ?? "";
      const icon = payload.icon ?? `${iconsPath}/pwa-192x192.png`;
      // Issue #4798: Android draws the badge (the status-bar icon) from the
      // image's alpha channel alone, so it is the white H on a transparent
      // square, not the tile, which showed as a filled square. One file
      // serves both instances: the DEV badge cannot be read at 24 dp. Safari
      // ignores the badge option. The file comes from scripts/generate-icons.js.
      const badge = payload.badge ?? "/notification-badge-96x96.png";
      const data = payload.data;
      const tag = payload.tag;

      await self.registration.showNotification(title, {
        body,
        icon,
        badge,
        data,
        tag,
      });

      // Set the iOS home-screen badge (iOS 16.4+) from the server's unread
      // count (issue #4921): max(count, 1), or 1 from an older server. Always a
      // positive integer — setAppBadge() with no args shows an empty badge on
      // iOS Safari. The open app's mirror is the only thing that clears it.
      await applyBadge(self.navigator, decidePushBadge(payload.unreadCount));
    })()
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const url = data?.url ?? "/";

  event.waitUntil(
    (async () => {
      // Issue #4921: a tap does not clear the badge — it opens the session,
      // and the page's unread-count mirror then writes the true count.

      // Try to navigate an existing window instead of opening a new one
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: false,
      });

      // Find an existing visible client window to reuse
      for (const client of clients) {
        if ("navigate" in client) {
          await client.navigate(url);
          await client.focus();
          return;
        }
      }

      // No existing window found - open a new one
      await self.clients.openWindow(url);
    })()
  );
});
