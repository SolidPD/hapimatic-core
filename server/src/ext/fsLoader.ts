// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server-side filesystem extension scanner (Sub-Issue Y of epic #1264, #1289).
 *
 * Discovers runtime extensions under `<extensionsDir>/<name>/manifest.json`,
 * validates each against the serializable `FsExtensionManifestSchema`
 * (`@hapi/protocol/ext`), and adapts each into a `ServerExtensionEntry` whose
 * `entryPoints.server` is a dynamic `import()` thunk built from the manifest's
 * relative entry-point path. The returned entries feed the EXISTING
 * `loadServerExtensions(deps, entries)` injection seam (`./loader`) unchanged —
 * this module adds discovery, not a new loader.
 *
 * Ships behind the `HAPI_FS_EXTENSIONS` opt-in flag (default OFF, wired at the
 * call site in `server/src/index.ts`): filesystem loading is arbitrary
 * host-privilege code execution until Sub-Issue AA (#1291, sandboxing) lands.
 *
 * Fail-soft at TWO levels (R2 — a bad filesystem extension never blocks boot):
 *   - directory-level: a missing dir, an EACCES-unreadable dir, or a plain FILE
 *     named `extensions` (ENOTDIR) returns `[]`;
 *   - per-extension: an unreadable / invalid / apiVersion-incompatible manifest,
 *     or an id colliding with a builtin, logs and skips that ONE extension.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { parseFsManifest } from "@hapi/protocol/ext";

import type { ServerExtensionEntry } from "./loader";

/**
 * Sanitize an extension id the SAME way `ServerExtensionHostImpl` does for its
 * `ext_<sanitizedId>_<table>` prefixes (`server/src/ext/host.ts:115-117`). Two
 * ids that sanitize to the same value (e.g. `a.b` and `a_b`) share a table
 * namespace, so the duplicate-id guard compares SANITIZED ids, not raw ids.
 */
function sanitizeExtensionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

/**
 * Scan `extensionsDir` for filesystem extensions declaring a `server` entry
 * point, returning `ServerExtensionEntry[]` sorted by id (R6 determinism). The
 * caller passes `builtinIds` (the codegen registry's ids) so a filesystem
 * extension cannot shadow or double-load a builtin.
 */
export async function scanFilesystemExtensions(
  extensionsDir: string,
  builtinIds: ReadonlySet<string>
): Promise<ServerExtensionEntry[]> {
  let dirents: Dirent<string>[];
  try {
    if (!existsSync(extensionsDir)) return [];
    dirents = readdirSync(extensionsDir, { withFileTypes: true });
  } catch (err) {
    console.error(
      `[ext:fsLoader] cannot read extensions dir '${extensionsDir}' — skipping filesystem extensions:`,
      err
    );
    return [];
  }

  // Duplicate-id guard (expert-review MED-1): seed the "seen" set with every
  // builtin's SANITIZED id so builtins always win; add each accepted filesystem
  // id as we go (builtin/first wins). Without this, a filesystem extension
  // sharing a builtin id would double-load — sharing the same `extension_prefs`
  // row, the `ext_<sanitizedId>_` table namespace, duplicate route factories,
  // and `getService` shadowing.
  const seenSanitizedIds = new Set<string>();
  for (const id of builtinIds) seenSanitizedIds.add(sanitizeExtensionId(id));

  const entries: ServerExtensionEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const extDir = join(extensionsDir, dirent.name);
    const manifestPath = join(extDir, "manifest.json");

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      console.error(
        `[ext:fsLoader] skipping '${dirent.name}': missing or invalid manifest.json:`,
        err
      );
      continue;
    }

    const parsed = parseFsManifest(raw);
    if (!parsed.ok) {
      console.error(
        `[ext:fsLoader] skipping '${dirent.name}': ${parsed.error}`
      );
      continue;
    }
    const fsm = parsed.manifest;

    // Per-runtime filter (R8): the server loader only receives extensions with a
    // `server` entry point (mirrors the codegen filter).
    const serverEntry = fsm.entryPoints.server;
    if (!serverEntry) continue;

    // Duplicate-id guard (MED-1).
    const sanitized = sanitizeExtensionId(fsm.id);
    if (seenSanitizedIds.has(sanitized)) {
      console.warn(
        `[ext:fsLoader] skipping filesystem extension '${fsm.id}' (dir '${dirent.name}'): its id ` +
          `(sanitized '${sanitized}') collides with a builtin or an earlier filesystem extension — builtin/first wins`
      );
      continue;
    }
    seenSanitizedIds.add(sanitized);

    // Absolute entry-point path + its dynamic-import thunk. A non-literal
    // `import()` specifier is left as a genuine runtime import by Bun's bundler
    // (verified from a `bun build --compile` binary), so this loads the
    // extension's code from the real OS filesystem at runtime.
    const entryModule = isAbsolute(serverEntry)
      ? serverEntry
      : resolve(extDir, serverEntry);

    const manifest: HapiExtensionManifest = {
      id: fsm.id,
      version: fsm.version,
      apiVersion: fsm.apiVersion,
      displayName: fsm.displayName,
      description: fsm.description,
      defaultEnabled: fsm.defaultEnabled,
      dependsOn: fsm.dependsOn,
      conflictsWith: fsm.conflictsWith,
      // A filesystem extension is never build-composed, so it is never
      // build-required — it always has a real runtime disable path.
      requiredAtBuild: false,
      // Propagate the declared capabilities (issue #1291) — the loader gates
      // this untrusted filesystem extension against them (default-deny).
      capabilities: fsm.capabilities,
      // Propagate declaratively-contributed catalog entries (issue #3752). Already
      // validated by `parseFsManifest` (the #3741 allowlist); the loader stamps
      // `owner = id` + `trusted: false` (untrusted provenance) at its drain and
      // merges them into the live catalog as `runtime-only`.
      catalog: fsm.catalog,
      entryPoints: {
        server: () => import(entryModule),
      },
    };
    // `trusted: false` — a runtime filesystem extension is the untrusted surface
    // the capability gate exists for (ADR-0003); the loader default-deny gates it.
    entries.push({ manifest, trusted: false });
  }

  // R6: deterministic order — filesystem extensions sorted by id (the caller
  // concatenates them AFTER the builtins, which keep config order).
  entries.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return entries;
}
