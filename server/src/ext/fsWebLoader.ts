// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side filesystem WEB-extension scanner (issue #1294, epic #1264 Phase 2
 * runtime web loading).
 *
 * The browser has no filesystem, so it cannot discover runtime extensions the
 * way the server/CLI `fsLoader.ts` does. This module is the server half of that
 * gap: it scans `<extensionsDir>/<name>/manifest.json` for extensions declaring
 * a **`web`** entry point and returns a serializable {@link FsWebExtensionInfo}
 * per extension. The discovery route (`server/src/web/routes/extWeb.ts`) resolves
 * enable state on top of these and ships the list to the browser, which then
 * dynamic-imports each `web` entry from `/ext-assets/<id>/dist/<entry>`.
 *
 * Mirrors `./fsLoader.ts` (`scanFilesystemExtensions`) exactly, with two
 * differences: it filters on `entryPoints.web` (not `server`), and it returns a
 * plain serializable info object (id + web entry path + styles + defaultEnabled)
 * instead of a `HapiExtensionManifest` with an `import()` thunk — the browser,
 * not the server, resolves the entry URL.
 *
 * Fail-soft at TWO levels (R5 — a bad filesystem extension never blocks the
 * discovery response): a missing / EACCES / non-directory `extensionsDir`
 * returns `[]`; an unreadable / invalid / apiVersion-incompatible manifest, or
 * an id colliding with a builtin, logs and skips that ONE extension.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { parseFsManifest } from "@hapi/protocol/ext";
import type { Capability } from "@hapi/protocol/ext";

/** Serializable discovery record for a filesystem extension with a web entry. */
export interface FsWebExtensionInfo {
  id: string;
  /** Relative path (under the extension's `dist/`) to the web ESM entry point. */
  webEntry: string;
  /** Relative stylesheet paths (under `dist/`) to inject as `<link>`. */
  styles: string[];
  /** Manifest default — the discovery route resolves the effective enable state. */
  defaultEnabled: boolean;
  /**
   * Declared privileged capabilities (issue #1291, ADR-0003). Server-validated
   * against the taxonomy at manifest-parse time; the browser's runtime web loader
   * default-deny gates this untrusted extension against them.
   */
  capabilities: Capability[];
}

/**
 * Sanitize an extension id the SAME way `ServerExtensionHostImpl` /
 * `fsLoader.ts` do, so the builtin-collision guard compares SANITIZED ids
 * (`a.b` and `a_b` share a namespace).
 */
function sanitizeExtensionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

/**
 * Scan `extensionsDir` for filesystem extensions declaring a `web` entry point,
 * returning `FsWebExtensionInfo[]` sorted by id (deterministic order). The
 * caller passes `builtinIds` (the codegen registry's ids) so a filesystem
 * extension cannot shadow or double-load a builtin in the browser.
 */
export function scanFilesystemWebExtensions(
  extensionsDir: string,
  builtinIds: ReadonlySet<string> = new Set()
): FsWebExtensionInfo[] {
  let dirents: Dirent<string>[];
  try {
    if (!existsSync(extensionsDir)) return [];
    dirents = readdirSync(extensionsDir, { withFileTypes: true });
  } catch (err) {
    console.error(
      `[ext:fsWebLoader] cannot read extensions dir '${extensionsDir}' — skipping filesystem web extensions:`,
      err
    );
    return [];
  }

  // Builtin/first wins — seed the "seen" set with every builtin's SANITIZED id.
  const seenSanitizedIds = new Set<string>();
  for (const id of builtinIds) seenSanitizedIds.add(sanitizeExtensionId(id));

  const infos: FsWebExtensionInfo[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = join(extensionsDir, dirent.name, "manifest.json");

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      console.error(
        `[ext:fsWebLoader] skipping '${dirent.name}': missing or invalid manifest.json:`,
        err
      );
      continue;
    }

    const parsed = parseFsManifest(raw);
    if (!parsed.ok) {
      console.error(
        `[ext:fsWebLoader] skipping '${dirent.name}': ${parsed.error}`
      );
      continue;
    }
    const fsm = parsed.manifest;

    // Per-runtime filter: this scanner only surfaces extensions with a `web`
    // entry point (the server scanner's mirror image, which filters on `server`).
    const webEntry = fsm.entryPoints.web;
    if (!webEntry) continue;

    // Builtin/duplicate-id guard — a filesystem id colliding with a builtin (or
    // an earlier filesystem extension) would double-register in the browser.
    const sanitized = sanitizeExtensionId(fsm.id);
    if (seenSanitizedIds.has(sanitized)) {
      console.warn(
        `[ext:fsWebLoader] skipping filesystem web extension '${fsm.id}' (dir '${dirent.name}'): its id ` +
          `(sanitized '${sanitized}') collides with a builtin or an earlier filesystem extension — builtin/first wins`
      );
      continue;
    }
    seenSanitizedIds.add(sanitized);

    infos.push({
      id: fsm.id,
      webEntry,
      styles: fsm.styles ?? [],
      defaultEnabled: fsm.defaultEnabled,
      capabilities: fsm.capabilities ?? [],
    });
  }

  // Deterministic order — sorted by id (mirrors fsLoader.ts's R6 sort).
  infos.sort((a, b) => a.id.localeCompare(b.id));
  return infos;
}
