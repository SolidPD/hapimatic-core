// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.heartbeat` (issue #1275, Sub-Issue K of epic
 * #1264).
 *
 * Replaces the inline `new HeartbeatService(...)` / `heartbeatService.start()`
 * block that used to live in `server/src/index.ts`, and moves heartbeat route
 * mounting off `server/src/web/server.ts` onto `host.routes.add`.
 *
 * ## Why the service is constructed in `onStartup`, not `register()`
 *
 * `loadServerExtensions()` runs EARLY in boot — after `Store` but BEFORE
 * `NotificationHub`, `PushService`, and `SyncEngine` are fully wired. The host's
 * late-bound accessors return `null` for those at `register()` time.
 * `HeartbeatService` captures its collaborators eagerly in its constructor, so
 * constructing at `register()` time would capture `null` and silently never
 * deliver heartbeats. Constructing inside `onStartup` (drained after every core
 * service exists) resolves them for real. See the identical rationale in
 * `server/src/extensions/scheduler/server.ts` (#1274).
 *
 * ## SystemEventQueue is CORE-owned (locked §3c, #1275)
 *
 * The `SystemEventQueue` is created by core (`server/src/index.ts`) and exposed
 * via `host.getSystemEventQueue()`, then INJECTED into `HeartbeatService` here.
 * It is NOT created by the service. Core-ownership decouples the queue's
 * lifetime from extension load order — the scheduler (which snapshots
 * `host.getSystemEventQueue()` at its own onStartup) resolves a live queue
 * regardless of whether `builtin.scheduler` or `builtin.heartbeat` loads first,
 * which the append-only `extensions.config.ts` ordering would otherwise break.
 *
 * ## Dual-mode transition stays in core
 *
 * `onStartup` always constructs and starts the legacy `HeartbeatService`. The
 * "disable the legacy service when a DB heartbeat-task exists" transition
 * remains in `server/src/index.ts` (it runs after ALL onStartup callbacks, so
 * it can read the scheduler handle) — unchanged from pre-migration behavior.
 */
import type { ServerRegister } from "@hapi/protocol/ext";
import type { JobRegistry } from "@hapi/protocol";

import type { SyncEngine } from "../../sync/syncEngine";
import type { NotificationHub } from "../../notifications/notificationHub";
import type { PushService } from "../../push/pushService";
import type { SystemEventQueue } from "../../heartbeat/systemEvents";
import type { ErrorLogger } from "../../logging/errorLogger";
import type { SchedulerService } from "../scheduler/scheduler/schedulerService";

import { HeartbeatService } from "./heartbeatService";
import { createHeartbeatRoutes } from "./routes";
import { loadHeartbeatConfig } from "../../config/heartbeatConfig";
import { configuration } from "../../configuration";

/**
 * Module-scoped handle. Null until the `onStartup` hook constructs it; the route
 * factory closes over this binding rather than a snapshot, so routes registered
 * at `register()` time see the instance once it exists.
 */
let heartbeatService: HeartbeatService | null = null;

export const register: ServerRegister = async host => {
  // 1. Mount the heartbeat routes. The loader mounts every registered factory
  //    under /api AFTER the JWT auth middleware (locked §5f) — the same position
  //    `createHeartbeatRoutes` occupied when core mounted it inline. The
  //    scheduler handle is resolved lazily from the cross-extension registry
  //    (locked §3d); the routes already treat a null scheduler as "no DB
  //    heartbeat task".
  host.routes.add(() =>
    createHeartbeatRoutes(
      () => heartbeatService,
      () => host.services.get<SchedulerService>("scheduler"),
      { errorLogger: host.getErrorLogger() as ErrorLogger | null }
    )
  );

  // 2. Construct AND start once core services exist. See the file docstring for
  //    why construction cannot happen in register().
  host.lifecycle.onStartup(async () => {
    const syncEngine = host.getSyncEngine() as SyncEngine | null;
    const notificationHub = host.getNotificationHub() as NotificationHub | null;
    const pushService = host.getPushService() as PushService | null;
    const systemEvents = host.getSystemEventQueue() as SystemEventQueue | null;

    // Required collaborators — no safe degraded mode, so fail loudly rather than
    // starting a half-wired service that silently never delivers heartbeats.
    if (!syncEngine || !notificationHub || !pushService || !systemEvents) {
      throw new Error(
        "[builtin.heartbeat] required collaborators unavailable at startup " +
          `(syncEngine=${syncEngine ? "ok" : "null"}, ` +
          `notificationHub=${notificationHub ? "ok" : "null"}, ` +
          `pushService=${pushService ? "ok" : "null"}, ` +
          `systemEvents=${systemEvents ? "ok" : "null"})`
      );
    }

    const config = await loadHeartbeatConfig(configuration.dataDir);

    heartbeatService = new HeartbeatService(
      syncEngine,
      notificationHub,
      pushService,
      config,
      systemEvents,
      host.getErrorLogger() as ErrorLogger | null,
      {
        node: host.getJobNodeId(),
        jobRegistry: host.getJobRegistry() as JobRegistry | null,
      }
    );

    // Always start. Core's post-drain transition (server/src/index.ts) stops
    // this legacy service if a DB heartbeat-task is active — preserving the
    // pre-migration precedence exactly.
    await heartbeatService.start();

    // Cross-extension handle (locked §3d). Core reads it for the SystemEventQueue
    // bridge and the dual-mode transition; the web server reads it for the
    // heartbeat routes' `getHeartbeatService`.
    host.services.register("heartbeat", heartbeatService);
  });

  // 3. Replaces core's `heartbeatService?.stop()` in the shutdown path.
  host.lifecycle.onShutdown(() => {
    heartbeatService?.stop();
    heartbeatService = null;
  });
};
