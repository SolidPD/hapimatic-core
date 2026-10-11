// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CLI-side filesystem extension scanner (Sub-Issue Y of epic #1264, #1289).
 *
 * The CLI mirror of `server/src/ext/fsLoader.ts`: discovers runtime extensions
 * under `<extensionsDir>/<name>/manifest.json`, validates each against the
 * serializable `FsExtensionManifestSchema` (`@hapi/protocol/ext`), and adapts
 * each into a `CliExtensionEntry` whose `entryPoints.cli` is a dynamic `import()`
 * thunk built from the manifest's relative entry-point path. The returned
 * entries feed the EXISTING `loadCliExtensions(host, entries)` injection seam
 * (`./loader`) unchanged.
 *
 * Ships behind the `HAPI_FS_EXTENSIONS` opt-in flag (default OFF, wired at the
 * call site in `cli/src/commands/runCli.ts`).
 *
 * ⚠️ CLI enable model (locked contract §5g): the CLI loader reads NO
 * `extension_prefs` DB — enablement is `manifest.requiredAtBuild ||
 * manifest.defaultEnabled` only, so a filesystem CLI extension is enabled by its
 * own `defaultEnabled`. Forward-contract breadcrumb: when #1290 (Extension
 * lifecycle CLI commands) adds a CLI prefs source, the CLI enable check will need
 * that prefs read (the server path already has it) — that is the seam to extend.
 *
 * Fail-soft at TWO levels (R2): a directory-level error returns `[]`; a
 * per-extension error (unreadable / invalid / apiVersion-incompatible manifest,
 * or a colliding id) logs and skips that ONE extension. Uses the file-based
 * `logger` (never `console`) so scan noise never disturbs a Claude session.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { parseFsManifest } from "@hapi/protocol/ext";
import { logger } from "@/ui/logger";

import type { CliExtensionEntry } from "./loader";

/**
 * Sanitize an extension id the SAME way the server host does for its table
 * prefixes (`server/src/ext/host.ts:115-117`), so the duplicate-id guard
 * compares SANITIZED ids (two ids like `a.b` and `a_b` collide).
 */
function sanitizeExtensionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

/**
 * Scan `extensionsDir` for filesystem extensions declaring a `cli` entry point,
 * returning `CliExtensionEntry[]` sorted by id (R6 determinism). `builtinIds`
 * (the CLI codegen registry's ids) seeds the duplicate-id guard so a filesystem
 * extension cannot shadow or double-load a builtin.
 */
export async function scanFilesystemExtensions(
  extensionsDir: string,
  builtinIds: ReadonlySet<string>
): Promise<CliExtensionEntry[]> {
  let dirents: Dirent<string>[];
  try {
    if (!existsSync(extensionsDir)) return [];
    dirents = readdirSync(extensionsDir, { withFileTypes: true });
  } catch (err) {
    logger.error(
      `[ext:fsLoader] cannot read extensions dir '${extensionsDir}' — skipping filesystem extensions:`,
      err
    );
    return [];
  }

  const seenSanitizedIds = new Set<string>();
  for (const id of builtinIds) seenSanitizedIds.add(sanitizeExtensionId(id));

  const entries: CliExtensionEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const extDir = join(extensionsDir, dirent.name);
    const manifestPath = join(extDir, "manifest.json");

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      logger.warn(
        `[ext:fsLoader] skipping '${dirent.name}': missing or invalid manifest.json:`,
        err
      );
      continue;
    }

    const parsed = parseFsManifest(raw);
    if (!parsed.ok) {
      logger.warn(`[ext:fsLoader] skipping '${dirent.name}': ${parsed.error}`);
      continue;
    }
    const fsm = parsed.manifest;

    // Per-runtime filter (R8): the CLI loader only receives extensions with a
    // `cli` entry point.
    const cliEntry = fsm.entryPoints.cli;
    if (!cliEntry) continue;

    // Duplicate-id guard (MED-1).
    const sanitized = sanitizeExtensionId(fsm.id);
    if (seenSanitizedIds.has(sanitized)) {
      logger.warn(
        `[ext:fsLoader] skipping filesystem extension '${fsm.id}' (dir '${dirent.name}'): its id ` +
          `(sanitized '${sanitized}') collides with a builtin or an earlier filesystem extension — builtin/first wins`
      );
      continue;
    }
    seenSanitizedIds.add(sanitized);

    const entryModule = isAbsolute(cliEntry)
      ? cliEntry
      : resolve(extDir, cliEntry);

    const manifest: HapiExtensionManifest = {
      id: fsm.id,
      version: fsm.version,
      apiVersion: fsm.apiVersion,
      displayName: fsm.displayName,
      description: fsm.description,
      defaultEnabled: fsm.defaultEnabled,
      dependsOn: fsm.dependsOn,
      conflictsWith: fsm.conflictsWith,
      requiredAtBuild: false,
      // Propagate declared capabilities (issue #1291) — the loader default-deny
      // gates this untrusted filesystem extension against them.
      capabilities: fsm.capabilities,
      entryPoints: {
        cli: () => import(entryModule),
      },
    };
    // `trusted: false` — runtime filesystem extension = the untrusted surface the
    // capability gate protects (ADR-0003).
    entries.push({ manifest, trusted: false });
  }

  entries.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return entries;
}
