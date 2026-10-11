// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI-side accessor for the `extension_prefs` enable store (issue #1290).
 *
 * `extension_prefs` is the SOLE authoritative enable store for extensions (epic
 * #1264, decision D1264-5 — the retired `extensions.json` is NOT used). It is a
 * core table in the server's SQLite database (`server/src/store/extensionPrefsStore.ts`),
 * created by the server's `runMigrations()`. The CLI and server share ONE instance
 * database at `${HAPI_HOME}/hapi.db` (server default; `DB_PATH` override), so the CLI
 * reads and writes the SAME store the server's extension loader consults at boot —
 * there is no second, CLI-local enable store to keep in sync.
 *
 * This module is the "CLI prefs source" the §5g gap deferred to #1290. Before it,
 * `cli/src/ext/loader.ts` gated enablement on `requiredAtBuild || defaultEnabled`
 * only (no prefs read), so a user who disabled an extension still saw its CLI
 * registration. The loader now consults {@link readCliExtensionPref} so a
 * `hapi ext disable <id>` actually withholds a non-`requiredAtBuild` extension's
 * CLI contributions.
 *
 * SQLite access is runtime-adaptive (`./sqlite`): `bun:sqlite` under the compiled Bun
 * binary, `node:sqlite` under Node/vitest — the direct-SQLite choice (D1) keeps the
 * loader's per-invocation enable read OFFLINE, with no dependency on a running server.
 * That rationale is unchanged by issue #2329, which added an authenticated HTTP
 * mutation surface for the browser (`PUT /api/extension-prefs/:id` plus
 * `GET /api/extension-registry`, in `server/src/web/routes/extensionAdmin.ts`): the CLI
 * still reads and writes the shared DB directly, because the loader runs on every `hapi`
 * invocation — including the short-lived hook-forwarder subprocess — where an HTTP
 * round-trip to a possibly-not-running server would be both slow and unreliable.
 *
 * Fail-soft: reads NEVER throw (missing DB / table / row → the manifest default), so
 * the loader hot path cannot be crashed by a fresh instance. Writes fail LOUD only
 * when the store does not exist yet (server never booted), with an actionable message.
 */
import { existsSync } from "node:fs";

import { logger } from "@/ui/logger";

import {
  openDatabase,
  resolveDbPath,
  extensionPrefsTableReady,
  type PortableDatabase,
} from "./sqlite";

export { resolveDbPath } from "./sqlite";

/** One extension's enable state — the CLI-relevant subset of `StoredExtensionPref`. */
export interface CliExtensionPref {
  id: string;
  enabled: boolean;
}

/**
 * Open the instance DB for reading. Returns `null` when the file is absent (a fresh
 * instance whose server has never booted) so callers fall back to the manifest
 * default instead of creating an empty file on the loader hot path.
 */
function openReadonly(): PortableDatabase | null {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return null;
  try {
    return openDatabase(dbPath, true);
  } catch (err) {
    logger.warn(
      `[ext:prefs] cannot open instance DB (readonly) at ${dbPath}:`,
      err
    );
    return null;
  }
}

/**
 * Read an extension's enable state. Returns `{ enabled: defaultEnabled }` when the DB
 * is absent, the table is missing, or no row exists — and NEVER throws (this runs on
 * the loader's per-invocation hot path). Mirrors `ExtensionPrefsStore.get`: an
 * explicit `enabled = 0` row survives (is not masked by a `true` manifest default).
 */
export function readCliExtensionPref(
  id: string,
  defaultEnabled: boolean
): CliExtensionPref {
  const db = openReadonly();
  if (!db) return { id, enabled: defaultEnabled };
  try {
    if (!extensionPrefsTableReady(db)) return { id, enabled: defaultEnabled };
    const row = db
      .prepare("SELECT enabled FROM extension_prefs WHERE id = ?")
      .get(id) as { enabled: number } | undefined;
    if (!row) return { id, enabled: defaultEnabled };
    return { id, enabled: row.enabled === 1 };
  } catch (err) {
    logger.warn(`[ext:prefs] read failed for '${id}':`, err);
    return { id, enabled: defaultEnabled };
  } finally {
    db.close();
  }
}

/**
 * Enumerate all persisted prefs in id order. Returns `[]` when the DB / table is
 * absent (never throws). Only extensions with an explicit row appear — callers merge
 * this with the manifest-default set for extensions that have no row.
 */
export function listCliExtensionPrefs(): CliExtensionPref[] {
  const db = openReadonly();
  if (!db) return [];
  try {
    if (!extensionPrefsTableReady(db)) return [];
    const rows = db
      .prepare("SELECT id, enabled FROM extension_prefs ORDER BY id ASC")
      .all() as { id: string; enabled: number }[];
    return rows.map(r => ({ id: r.id, enabled: r.enabled === 1 }));
  } catch (err) {
    logger.warn(`[ext:prefs] list failed:`, err);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Thrown when a write is attempted against a non-existent enable store — the server
 * has never booted on this instance, so `${HAPI_HOME}/hapi.db` (or its
 * `extension_prefs` table) does not exist. A write cannot silently succeed against a
 * missing store, so this is surfaced rather than swallowed.
 */
export class ExtensionPrefsStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionPrefsStoreUnavailableError";
  }
}

/** Open the DB for read-write WITHOUT creating it, throwing a clear error if absent. */
function openReadWriteOrThrow(): PortableDatabase {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    throw new ExtensionPrefsStoreUnavailableError(
      `Extension preferences database not found at ${dbPath}. Start the Hapimatic server once to initialize it, then retry.`
    );
  }
  return openDatabase(dbPath, false);
}

/**
 * Upsert an extension's `enabled` flag. A single `INSERT … ON CONFLICT(id) DO UPDATE`
 * is atomic and portable across both SQLite back-ends (no `db.transaction()` — which
 * `node:sqlite` lacks): a new row is inserted with `config = NULL`; an existing row
 * has ONLY its `enabled` + `updated_at` updated, preserving `config` (matching
 * `ExtensionPrefsStore.set` with just `enabled` supplied). Throws
 * {@link ExtensionPrefsStoreUnavailableError} when the store does not exist.
 */
export function setCliExtensionPref(id: string, enabled: boolean): void {
  const db = openReadWriteOrThrow();
  try {
    if (!extensionPrefsTableReady(db)) {
      throw new ExtensionPrefsStoreUnavailableError(
        `The 'extension_prefs' table does not exist in ${resolveDbPath()}. Start the Hapimatic server once to run its migration, then retry.`
      );
    }
    db.prepare(
      "INSERT INTO extension_prefs (id, enabled, config, updated_at) VALUES (?, ?, NULL, ?) " +
        "ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at"
    ).run(id, enabled ? 1 : 0, Date.now());
  } finally {
    db.close();
  }
}

/**
 * Delete an extension's pref row (reverts it to its manifest default). Returns `true`
 * when a row was removed. Used by `hapi ext uninstall --purge`. No-throw when the
 * store is absent (nothing to remove → `false`).
 */
export function removeCliExtensionPref(id: string): boolean {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return false;
  const db = openDatabase(dbPath, false);
  try {
    if (!extensionPrefsTableReady(db)) return false;
    const result = db
      .prepare("DELETE FROM extension_prefs WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
  } finally {
    db.close();
  }
}
