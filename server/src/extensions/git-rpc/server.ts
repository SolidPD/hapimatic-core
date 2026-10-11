// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.git-rpc` (issue #1281, Sub-Issue Q of epic
 * #1264).
 *
 * Moves the 6 Git RPC + file-browser routes off the inline `app.route("/api",
 * createGitRoutes(...))` mount in `server/src/web/server.ts` onto
 * `host.routes.add`. The loader collects every registered factory and mounts it
 * under `/api` AFTER the JWT auth middleware — the same position
 * `createGitRoutes` occupied when core mounted it inline.
 *
 * ## Why the factory is wrapped in an outer `() =>` thunk
 *
 * `host.routes.add(factory)` stores the factory; the loader calls it at
 * createWebApp time (boot step 9), which runs AFTER Federation init (step 8).
 * Wrapping `createGitRoutes(...)` in `() =>` defers its argument evaluation to
 * that mount point, so:
 *
 *   - `host.getFederationApiToken()` and `host.getErrorLogger()` resolve their
 *     real post-boot values (they would be evaluated too early if called at
 *     `register()` time / boot step 6).
 *   - `getNodeRegistry` stays a per-request getter — `NodeRegistry` is created
 *     at step 8, so it MUST be read lazily on each request, never captured once.
 *
 * This mirrors `builtin.scheduler` / `builtin.watchdog`, whose route factories
 * use the identical `host.routes.add(() => createXRoutes(...))` shape.
 */
import type { ServerRegister } from "@hapi/protocol/ext";

import type { SyncEngine } from "../../sync/syncEngine";
import type { NodeRegistry } from "../../federation/nodeRegistry";
import type { ErrorLogger } from "../../logging/errorLogger";

import { createGitRoutes } from "./routes/git";

export const register: ServerRegister = async host => {
  host.routes.add(() =>
    createGitRoutes(() => host.getSyncEngine() as SyncEngine | null, {
      getNodeRegistry: () => host.getNodeRegistry() as NodeRegistry | null,
      federationApiToken: host.getFederationApiToken(),
      errorLogger: host.getErrorLogger() as ErrorLogger | null,
    })
  );
};
