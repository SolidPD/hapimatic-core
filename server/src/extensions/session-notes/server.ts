// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.session-notes` (issue #1284, Sub-Issue T of
 * epic #1264).
 *
 * The FIRST brand-new feature to ship as an extension end-to-end — nothing is
 * being migrated out of core here. That makes this file the reference shape for
 * "server-owned table + REST routes, contributed entirely from an extension".
 *
 * ## Why the store is constructed in `register()`, not `onStartup`
 *
 * This is the inverse of `builtin.scheduler` (#1274), and the difference is
 * worth stating because copying the scheduler's shape here would be cargo-cult.
 * The scheduler defers construction because `SchedulerService` eagerly captures
 * `SyncEngine`/`PushService`/`NotificationHub` — services that do not exist when
 * extensions load — and three of them are OPTIONAL constructor params, so
 * capturing null would fail SILENTLY.
 *
 * `SessionNotesStore` captures exactly one collaborator: the raw `bun:sqlite`
 * `Database`. Core's init order constructs `Store` at step 2 and loads
 * extensions at step 6, so `host.getRawDb()` is already non-null in `register()`.
 * There is nothing to wait for, and no silent-null hazard to defend against.
 *
 * `SyncEngine` (needed only to resolve a session's namespace) IS late-bound, so
 * the route factory receives it as a getter and resolves it per request. A
 * request arriving before boot completes gets a clean 503 instead of a crash.
 */
import type { ServerRegister } from "@hapi/protocol/ext";
import type { Database } from "bun:sqlite";

import type { SyncEngine } from "../../sync/syncEngine";
import { sessionNotesMigration } from "./migration";
import { createSessionNotesRoutes } from "./routes/notes";
import { SessionNotesStore } from "./store/notesStore";

export const register: ServerRegister = host => {
  // 1. Create the table + index. Runs via Store.runExtensionMigrations(), which
  //    the loader invokes after every core migration — so the `sessions` table
  //    the FK references already exists.
  host.store.addMigration(sessionNotesMigration);

  // 2. Build the store. `getRawDb()` is non-null here (see the file docstring);
  //    a null would be a genuine contract violation, so fail loudly rather than
  //    mounting routes that would 503 forever.
  const rawDb = host.getRawDb() as Database | null;
  if (!rawDb) {
    throw new Error(
      "[builtin.session-notes] host.getRawDb() returned null at register() — " +
        "the core Store must exist before extensions load"
    );
  }
  const store = new SessionNotesStore(rawDb);

  // 3. Mount CRUD. The loader mounts every registered factory under /api AFTER
  //    the JWT auth middleware (locked §5f), so these routes are authenticated
  //    and `c.get("namespace")` is populated.
  host.routes.add(() =>
    createSessionNotesRoutes({
      getStore: () => store,
      getSyncEngine: () => host.getSyncEngine() as SyncEngine | null,
    })
  );
};
