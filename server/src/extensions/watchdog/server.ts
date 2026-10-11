// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.watchdog` (issue #1276, Sub-Issue L of epic
 * #1264).
 *
 * Migrates the stall watchdog out of `server/src/index.ts`:
 *   - constructs `StallWatchdogService` from late-bound core services,
 *   - mounts the `/api/watchdog/*` routes via `host.routes.add` (the loader
 *     mounts route factories under `/api` AFTER the JWT auth middleware — the
 *     same post-auth position the inline `app.route("/api", createWatchdogRoutes)`
 *     occupied), and
 *   - moves the poll-loop lifecycle onto the host hooks: `onStartup` (drained
 *     after core services exist) starts the loop; `onShutdown` stops it — the
 *     same ordering the inline `start()` / `stop()` calls provided.
 *
 * #1963 supervised-loop integration is preserved: the service's internal
 * `SupervisedLoop` registers with the core `JobRegistry` and is tagged with the
 * federation node id, both reached via the host's `getJobRegistry()` /
 * `getJobNodeId()` accessors (added by `builtin.scheduler` #1274, which migrated
 * the same way). Without them the watchdog loop would vanish from the System Jobs
 * portal and mislabel its stall/death events as "standalone" on federation nodes.
 *
 * The late-bound core accessors are typed `unknown` in `@hapi/protocol/ext`
 * (shared cannot import server types), so each is narrowed at this call site —
 * the established pattern for every core accessor on the host.
 */
import type { JobRegistry } from "@hapi/protocol";
import type { ServerRegister } from "@hapi/protocol/ext";

import type { PushService } from "../../push/pushService";
import type { Store } from "../../store";
import type { SyncEngine } from "../../sync/syncEngine";
import { loadStallWatchdogConfig } from "./config";
import { createWatchdogRoutes } from "./routes";
import { StallWatchdogService } from "./stallWatchdogService";

/**
 * The slice of core `Configuration` this extension reads. Declared structurally
 * rather than importing the (non-exported) `Configuration` class — matching the
 * notifications-push / notifications-telegram pattern.
 */
interface WatchdogCoreConfig {
  dataDir: string;
}

export const register: ServerRegister = async host => {
  const syncEngine = host.getSyncEngine() as SyncEngine | null;
  if (!syncEngine) {
    throw new Error(
      "[builtin.watchdog] syncEngine is unavailable at register()"
    );
  }
  const pushService = host.getPushService() as PushService | null;
  if (!pushService) {
    throw new Error(
      "[builtin.watchdog] pushService is unavailable at register()"
    );
  }
  const coreConfig = host.getCoreConfig() as WatchdogCoreConfig | null;
  if (!coreConfig) {
    throw new Error(
      "[builtin.watchdog] coreConfig is unavailable at register()"
    );
  }

  const store = host.getStore() as Store;
  const jobRegistry = host.getJobRegistry() as JobRegistry | null;

  const watchdogConfig = await loadStallWatchdogConfig(coreConfig.dataDir);

  // The federation node id for the #1963 supervised-loop (System Jobs portal /
  // alert-router labelling). Provided by the host — the same value core supplies
  // to every other SupervisedLoop; `builtin.scheduler` (#1274) added this accessor.
  const jobNodeId = host.getJobNodeId();

  const service = new StallWatchdogService(
    syncEngine,
    pushService,
    store,
    watchdogConfig,
    { node: jobNodeId, jobRegistry }
  );

  // Mount the /api/watchdog/* routes. The factory closes over the constructed
  // service via the same `() => Service | null` getter the routes file expects;
  // the loader invokes the factory with `undefined`, which the getter ignores.
  host.routes.add(() => createWatchdogRoutes(() => service));

  // Long-running work never starts in register() — start the poll loop in
  // onStartup (after core services exist) and stop it in onShutdown, matching
  // the pre-migration inline `start()` / `stop()` ordering.
  host.lifecycle.onStartup(async () => {
    await service.start();
  });
  host.lifecycle.onShutdown(() => {
    service.stop();
  });
};
