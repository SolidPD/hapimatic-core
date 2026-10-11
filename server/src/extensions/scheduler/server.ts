// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.scheduler` (issue #1274, Sub-Issue J of epic
 * #1264).
 *
 * Replaces the inline `new SchedulerService(...)` / `schedulerService.start()` /
 * `schedulerService?.stop()` block that used to live in `server/src/index.ts`,
 * and moves schedule route mounting off `server/src/web/server.ts` onto
 * `host.routes.add`.
 *
 * ## Why the service is constructed in `onStartup`, not `register()`
 *
 * `loadServerExtensions()` runs EARLY in boot — after `Store` (so the enable
 * check can read `extension_prefs`) but BEFORE `NotificationHub`,
 * `HeartbeatService.systemEvents`, and `socketServer.rpcRegistry` exist. The
 * host's late-bound accessors return `null` for all three at `register()` time.
 *
 * `SchedulerService` captures its collaborators eagerly in its constructor (it
 * builds a `TaskExecutor` from them immediately), and three of them are OPTIONAL
 * parameters. Constructing at `register()` time would therefore capture `null`
 * for `notificationHub`, `systemEventQueue`, and `rpcRegistry` WITHOUT any type
 * error or runtime throw — the scheduler would tick normally while silently
 * never delivering completion notifications and never firing
 * `run_once_at_creation` tasks (`rpcRegistry?.hasAnyHandlerMatching(...)` would
 * be permanently false). Optional deps are the dangerous ones here precisely
 * because they fail silently.
 *
 * Constructing inside `onStartup` (drained after every core service exists)
 * resolves all seven collaborators for real. The cost is a brief boot window in
 * which the routes are mounted but the service is still null; `requireService()`
 * in `routes/schedules.ts` already answers that with a 503, which is the correct
 * response for "not booted yet".
 */
import type { ServerRegister } from "@hapi/protocol/ext";
import type { JobRegistry } from "@hapi/protocol";

import type { ErrorLogger } from "../../logging/errorLogger";
import type { SyncEngine } from "../../sync/syncEngine";
import type { PushService } from "../../push/pushService";
import type { NotificationHub } from "../../notifications/notificationHub";
import type { SystemEventQueue } from "../../heartbeat/systemEvents";
import type { RpcRegistry } from "../../socket/rpcRegistry";
import type { Database } from "bun:sqlite";

import { SchedulerService } from "./scheduler/schedulerService";
import { SchedulerStore } from "./store/schedulerStore";
import { createSchedulesRoutes } from "./routes/schedules";
import { schedulerMigration } from "./migration";

/**
 * Module-scoped handle. Null until the `onStartup` hook constructs it; the
 * route factory closes over this binding rather than a snapshot, so routes
 * registered at `register()` time see the instance once it exists.
 */
let schedulerService: SchedulerService | null = null;

export const register: ServerRegister = async host => {
  // 1. One-time table rename + full-schema creation. Runs via
  //    Store.runExtensionMigrations(), which the loader invokes after every
  //    core migration has already applied.
  host.store.addMigration(schedulerMigration);

  // 2. Mount the schedule routes. The loader mounts every registered factory
  //    under /api AFTER the JWT auth middleware (locked §5f) — the same
  //    position `createSchedulesRoutes` occupied when core mounted it inline.
  //
  //    `getErrorLogger()` rather than `host.log`: the scheduler tags its
  //    entries `category: "scheduler"`, and `ErrorLogger.child()` would rewrite
  //    every one of them to `ext:builtin.scheduler`, silently breaking existing
  //    log filters. The #1271 contract amendment added this accessor for
  //    exactly this case — an extension whose types predate the host.
  host.routes.add(() =>
    createSchedulesRoutes(() => schedulerService, {
      errorLogger: host.getErrorLogger() as ErrorLogger | null,
    })
  );

  // 3. Construct AND start once core services exist. See the file docstring for
  //    why construction cannot happen in register().
  host.lifecycle.onStartup(async () => {
    const syncEngine = host.getSyncEngine() as SyncEngine | null;
    const pushService = host.getPushService() as PushService | null;

    // Required collaborators — unlike the optional ones these have no safe
    // degraded mode, so fail loudly rather than starting a half-wired service.
    if (!syncEngine || !pushService) {
      throw new Error(
        "[builtin.scheduler] syncEngine and pushService are required but " +
          `unavailable at startup (syncEngine=${syncEngine ? "ok" : "null"}, ` +
          `pushService=${pushService ? "ok" : "null"})`
      );
    }

    const schedulerStore = new SchedulerStore(host.getRawDb() as Database);

    schedulerService = new SchedulerService(
      schedulerStore,
      syncEngine,
      pushService,
      (host.getNotificationHub() as NotificationHub | null) ?? undefined,
      (host.getSystemEventQueue() as SystemEventQueue | null) ?? undefined,
      host.getErrorLogger() as ErrorLogger | null,
      host.getRpcRegistry() as RpcRegistry | null,
      // #1963: register the tick loop with the process-wide JobRegistry so the
      // scheduler keeps appearing in the System Jobs portal. Core passed these
      // when it constructed the service inline; dropping them would leave the
      // loop running but invisible, and labelled "standalone" instead of the
      // real federation node.
      {
        node: host.getJobNodeId(),
        jobRegistry: host.getJobRegistry() as JobRegistry | null,
      }
    );

    await schedulerService.start();

    // Cross-extension handle (locked §3d). `builtin.heartbeat` (#1275, which
    // lands after this issue) resolves it via host.services.get("scheduler").
    host.services.register("scheduler", schedulerService);
  });

  // 4. Replaces core's `schedulerService?.stop()` in the shutdown path. Without
  //    it the supervised tick loop leaks across graceful shutdown.
  host.lifecycle.onShutdown(() => {
    schedulerService?.stop();
    schedulerService = null;
  });
};
