// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.notifications-push` — browser/PWA push notifications (issue #1271,
 * Sub-Issue G of epic #1264).
 *
 * `requiredAtBuild: true` for v0.1: push is the notification floor (the
 * `notify-pm` cascade's last resort) and several CORE services call
 * `PushService` directly (errorLogger, scheduler, taskExecutor, stallWatchdog,
 * heartbeat), so the channel must never be absent. The loader's enable check
 * short-circuits on `requiredAtBuild`, bypassing `extension_prefs` entirely.
 *
 * NOTE: only the CHANNEL lives here. `PushService` stays at
 * `server/src/push/pushService.ts` because it is shared core infrastructure.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.notifications-push",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Push Notifications",
  description: "Browser/PWA push notifications via web-push (VAPID).",
  defaultEnabled: true,
  requiredAtBuild: true,
  entryPoints: {
    server: async () => import("./server"),
  },
};
