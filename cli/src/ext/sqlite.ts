// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runtime-adaptive SQLite access for the CLI extension commands (issue #1290).
 *
 * The CLI's PRODUCTION runtime is Bun (the compiled binary), which provides
 * `bun:sqlite` but NOT `node:sqlite`. The CLI's TEST runtime is Node (vitest), which
 * provides `node:sqlite` but NOT `bun:sqlite`. There is no single SQLite module common
 * to both, so this module loads whichever the current runtime provides and exposes a
 * tiny portable subset (`prepare().get/all/run`, `close`) that both back-ends share.
 *
 * The two builtins are loaded via `createRequire` with a per-branch literal specifier,
 * so the branch not taken is never resolved (a `require("bun:sqlite")` never executes
 * under Node, and vice-versa) — and a runtime `require()` is invisible to vitest/vite's
 * static import analysis, unlike a static `import` of a Bun-only module.
 *
 * The extension enable store (`extension_prefs`) lives in the server's instance DB at
 * `${HAPI_HOME}/hapi.db` (server default; `DB_PATH` override). This module never
 * CREATES that DB — callers guard on existence so a fresh instance fails soft (reads)
 * or loud (writes) rather than materializing an empty database on the loader hot path.
 */
import { createRequire } from "node:module";

import { configuration } from "@/configuration";

const nodeRequire = createRequire(import.meta.url);

/** The portable statement subset shared by `bun:sqlite` and `node:sqlite`. */
export interface PortableStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint };
}

/** The portable database subset shared by both back-ends. */
export interface PortableDatabase {
  prepare(sql: string): PortableStatement;
  close(): void;
}

/** True when running under the Bun runtime (production binary), false under Node (tests). */
function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Resolve the instance database path the SAME way the server does
 * (`server/src/configuration.ts`): `DB_PATH` env override, else
 * `${HAPI_HOME}/hapi.db` (= `configuration.happyHomeDir`).
 */
export function resolveDbPath(): string {
  return (
    process.env.DB_PATH ||
    `${configuration.happyHomeDir.replace(/\/$/, "")}/hapi.db`
  );
}

/**
 * Open a database at `path`. `readonly` opens read-only (never creates); otherwise
 * opens read-write WITHOUT creating a missing file. Callers guard existence first.
 */
export function openDatabase(
  path: string,
  readonly: boolean
): PortableDatabase {
  if (isBun()) {
    const { Database } = nodeRequire("bun:sqlite");
    return new Database(
      path,
      readonly ? { readonly: true } : { readwrite: true, create: false }
    ) as PortableDatabase;
  }
  const { DatabaseSync } = nodeRequire("node:sqlite");
  return new DatabaseSync(
    path,
    readonly ? { readOnly: true } : {}
  ) as PortableDatabase;
}

/** True when the open DB carries the `extension_prefs` table. */
export function extensionPrefsTableReady(db: PortableDatabase): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'extension_prefs'"
    )
    .get() as { name: string } | undefined;
  return row != null;
}
