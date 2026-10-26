// SPDX-License-Identifier: AGPL-3.0-only
import { type JobRegistry, SupervisedLoop } from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import type { NotificationService } from "./notificationService";

/** How often the purge runs. Hourly bounds a row's life at 49 hours. */
export const NOTIFICATION_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Build the 48-hour notification purge loop (issue #4913, epic #4912),
 * modelled on the 30-day `error-log-cleanup` loop in `index.ts`. It deletes
 * rows whose `last_at` is older than 48 hours regardless of read state and
 * logs the count at `info` when non-zero. Hourly with a first tick at boot,
 * instead of the error-log sweep's 24 hours, so a row lives at most 49 hours;
 * reads also filter by the TTL, so no surface shows an expired row between
 * ticks. The caller starts and stops it.
 */
export function createNotificationPurgeLoop(opts: {
  service: NotificationService;
  node: string;
  registry: JobRegistry;
  errorLogger: ErrorLogger;
}): SupervisedLoop {
  return new SupervisedLoop({
    name: "notification-purge",
    node: opts.node,
    intervalMs: NOTIFICATION_PURGE_INTERVAL_MS,
    immediate: true,
    registry: opts.registry,
    tick: () => {
      try {
        const purged = opts.service.purgeExpired();
        if (purged > 0) {
          opts.errorLogger.info(
            `Purged ${purged} notifications older than 48 hours`,
            { category: "notification-purge" }
          );
        }
      } catch (err) {
        console.error("[Notifications] Purge failed:", err);
        throw err;
      }
    },
  });
}
