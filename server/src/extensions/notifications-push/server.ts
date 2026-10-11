// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.notifications-push` (issue #1271).
 *
 * Registers the push `NotificationChannel`. `PushService` is reached through
 * the host's late-bound core accessor rather than a direct core import — the
 * loader runs at `server/src/index.ts` AFTER `pushService` is constructed
 * (`errorLogger.setPushService(pushService)` precedes it), so the accessor is
 * non-null here; the guard is defensive.
 *
 * The late-bound accessors are typed `unknown` in `@hapi/protocol/ext` (shared
 * cannot import server types), so each is narrowed at this call site — the
 * established pattern for every core accessor on the host.
 */
import type { ServerRegister } from "@hapi/protocol/ext";

import type { PushService } from "../../push/pushService";
import { PushNotificationChannel } from "./pushNotificationChannel";

/**
 * The slice of core `Configuration` this extension reads. Declared structurally
 * rather than importing the (non-exported) `Configuration` class, so the
 * extension states exactly what it depends on and is unaffected by unrelated
 * core-config changes.
 */
interface PushCoreConfig {
  miniAppUrl: string;
}

export const register: ServerRegister = async host => {
  const pushService = host.getPushService() as PushService | null;
  if (!pushService) {
    throw new Error(
      "[builtin.notifications-push] pushService is unavailable at register()"
    );
  }

  // Core config (NOT `host.config.get()`, which reads this extension's own
  // extension_prefs row) — via the #1271 `getCoreConfig()` contract amendment.
  const coreConfig = host.getCoreConfig() as PushCoreConfig | null;

  host.notifications.addChannel(
    new PushNotificationChannel(pushService, coreConfig?.miniAppUrl ?? "")
  );
};
