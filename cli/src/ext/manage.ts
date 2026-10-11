// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Filesystem lifecycle operations for the `hapi ext` commands (issue #1290).
 *
 * Pure(ish) helpers — no CLI-argument parsing (that lives in
 * `cli/src/commands/ext.ts`). They install / uninstall / update / list filesystem
 * extensions under `${HAPI_HOME}/extensions/<id>/` (the runtime-loader path from
 * #1289, scanned by `cli/src/ext/fsLoader.ts` behind `HAPI_FS_EXTENSIONS`).
 *
 * Enablement is delegated to the SOLE enable store (`extension_prefs`, via
 * `./prefs`). Data purge on uninstall drops the extension's server-owned
 * `ext_<sanitizedId>_*` tables from the shared instance DB.
 *
 * v0.1 scope (directive D2/D3): `install` accepts a local path, a URL (git / tarball),
 * OR a bare registry id (`<publisher>.<name>`) which resolves via the marketplace catalog
 * (#1292) to the author repo's git URL. `update` re-installs from a recorded install-source
 * sidecar (registry ids re-resolve against the catalog) and skips build-time builtins.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  parseFsManifest,
  resolveRegistryId,
  RegistryError,
  DEFAULT_CATALOG_URL,
} from "@hapi/protocol/ext";
import type { ScanBeforeInstall } from "@hapi/protocol";
import { extensions as builtinCliExtensions } from "@/extensions.generated";
import { logger } from "@/ui/logger";

import { readCliExtensionPref, removeCliExtensionPref } from "./prefs";
import { assertScanPass } from "./scanGate";
import { openDatabase, resolveDbPath } from "./sqlite";

/** Sidecar filename written into each installed extension's dir (see {@link InstallSidecar}). */
const INSTALL_SIDECAR = ".hapi-install.json";

/** One row of `hapi ext list` output. */
export interface InstalledExtension {
  id: string;
  displayName: string;
  version: string;
  source: "builtin" | "filesystem";
  enabled: boolean;
}

/** Recorded so `hapi ext update` can re-fetch a filesystem extension from its origin. */
export interface InstallSidecar {
  source: string;
  installedAt: string;
  version: string;
  id: string;
}

/** Result of a successful {@link installExtension}. */
export interface InstallResult {
  id: string;
  version: string;
  warnings: string[];
}

/**
 * Thrown when a registry install's staged manifest declares an `id` that does not match
 * the catalog id the user requested (#1292 R4 integrity). A catalog entry pointing at a
 * repo whose `manifest.json` declares a different id is refused rather than silently
 * installing the wrong extension under the requested id.
 */
export class RegistryIntegrityError extends Error {
  constructor(expectedId: string, actualId: string) {
    super(
      `Integrity check failed: catalog id '${expectedId}' resolved to a repo whose manifest declares id '${actualId}'. Refusing to install.`
    );
    this.name = "RegistryIntegrityError";
  }
}

/**
 * Options controlling how a bare registry id (`<publisher>.<name>`) resolves against the
 * marketplace catalog (#1292). Both fields are optional; the defaults hit the real
 * catalog via the global `fetch`.
 */
export interface RegistrySourceOpts {
  /**
   * Catalog URL override. Defaults to the `HAPI_EXTENSION_CATALOG_URL` env var, then to
   * `DEFAULT_CATALOG_URL` (the dedicated `hapimatic-extensions` repo).
   */
  catalogUrl?: string;
  /** Injectable `fetch` (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Supply-chain scan hook (#3120 seam; Sub Q / #3131 supplies it). Invoked INSIDE the
   * staged pipeline — after the manifest is read + validated, BEFORE the `cpSync` finalize —
   * with the STAGED bytes (`stagedDir`) available. A `block` verdict aborts before finalize
   * (the `finally` staging cleanup handles teardown). Absent = documented no-op pass.
   */
  scanBeforeInstall?: ScanBeforeInstall;
}

/** Resolve the effective catalog URL: explicit override → env → default. */
function resolveCatalogUrl(override?: string): string {
  if (override && override.trim()) return override.trim();
  const env = (process.env.HAPI_EXTENSION_CATALOG_URL || "").trim();
  return env || DEFAULT_CATALOG_URL;
}

/** Thrown when the install target `${extensionsDir}/<id>/` already exists. */
export class ExtensionAlreadyInstalledError extends Error {
  constructor(id: string) {
    super(
      `Extension '${id}' is already installed. Use 'hapi ext update ${id}' to update it, ` +
        `or 'hapi ext uninstall ${id}' first.`
    );
    this.name = "ExtensionAlreadyInstalledError";
  }
}

/** Thrown when an operation targets an id that is not installed on the filesystem. */
export class ExtensionNotInstalledError extends Error {
  constructor(id: string) {
    super(`Extension '${id}' is not installed under the extensions directory.`);
    this.name = "ExtensionNotInstalledError";
  }
}

/**
 * Sanitize an extension id the SAME way the server host does for its
 * `ext_<sanitizedId>_<table>` prefixes (`server/src/ext/host.ts:116`), so purge
 * targets the exact table namespace the extension's data lives in.
 */
export function sanitizeExtensionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
}

/**
 * Thrown when a manifest's `id` is not a safe single path segment (contains a path
 * separator or `.`/`..` traversal). The FS-manifest schema only requires a non-empty
 * string, so `install` guards against a crafted id escaping the extensions dir.
 */
export class UnsafeExtensionIdError extends Error {
  constructor(id: string) {
    super(
      `Extension id '${id}' is not a safe directory name (path separators or '.'/'..' traversal are not allowed).`
    );
    this.name = "UnsafeExtensionIdError";
  }
}

/**
 * Reject an id that would escape `${extensionsDir}/<id>/` when used as a directory
 * name — the manifest schema does not constrain id characters, so `install` must.
 * A legitimate id is a single segment like `publisher.name` (`basename(id) === id`).
 */
function assertSafeExtensionId(id: string): void {
  if (
    id.length === 0 ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    basename(id) !== id
  ) {
    throw new UnsafeExtensionIdError(id);
  }
}

/**
 * Write the install-source sidecar (`.hapi-install.json`) into an installed extension's
 * dir, recording where it came from so `update` can re-fetch. Shared by install and the
 * in-place update swap so the sidecar shape stays in one place.
 */
function writeInstallSidecar(
  target: string,
  source: string,
  version: string,
  id: string
): void {
  const sidecar: InstallSidecar = {
    source,
    installedAt: new Date().toISOString(),
    version,
    id,
  };
  writeFileSync(
    join(target, INSTALL_SIDECAR),
    JSON.stringify(sidecar, null, 2)
  );
}

/** `true` when the source string looks like a git or HTTP(S) URL (not a local path). */
function isUrlSource(source: string): boolean {
  return (
    /^https?:\/\//.test(source) ||
    /^git@/.test(source) ||
    /^git\+/.test(source) ||
    /\.git$/.test(source)
  );
}

/** `true` when the source looks like a filesystem path (even if it does not exist). */
function looksLikePath(source: string): boolean {
  return (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~") ||
    source.includes("/")
  );
}

/** Classify an install source into the three v0.1 source kinds. */
export function classifySource(source: string): "url" | "local" | "registry" {
  if (isUrlSource(source)) return "url";
  if (existsSync(source)) return "local";
  if (looksLikePath(source)) return "local"; // path-shaped but missing → clear error downstream
  return "registry";
}

/**
 * Run a subprocess (git / tar), returning its exit code + captured stderr. Uses
 * `node:child_process` `spawnSync` (not `Bun.spawnSync`) so it works under both the Bun
 * binary and Node/vitest — mirroring `cli/src/commands/launcher.ts`.
 */
function runProcess(
  cmd: string[],
  cwd?: string
): { code: number; stderr: string } {
  const r = spawnSync(cmd[0], cmd.slice(1), cwd ? { cwd } : undefined);
  return { code: r.status ?? 1, stderr: r.stderr ? r.stderr.toString() : "" };
}

/**
 * Locate the directory containing an extension's `manifest.json` within `root`.
 * Accepts the manifest at `root` itself, or in a SINGLE top-level subdirectory (the
 * common shape of a git-archive / tarball extraction). Returns null when neither holds.
 */
function findManifestDir(root: string): string | null {
  if (existsSync(join(root, "manifest.json"))) return root;
  const entries = readdirSync(root, { withFileTypes: true }).filter(e =>
    e.isDirectory()
  );
  if (entries.length === 1) {
    const sub = join(root, entries[0].name);
    if (existsSync(join(sub, "manifest.json"))) return sub;
  }
  return null;
}

/**
 * Materialize an install source into a local staging directory that contains the
 * extension's `manifest.json` at its root. Handles a local directory (copy), a local
 * tarball (extract), an HTTP(S) tarball (download + extract), and a git URL (shallow
 * clone). The caller owns cleanup of `stagingParent`.
 */
async function materializeSource(
  source: string,
  kind: "url" | "local",
  stagingParent: string
): Promise<string> {
  if (kind === "local") {
    if (!existsSync(source)) {
      throw new Error(`Install source path does not exist: ${source}`);
    }
    const stat = statSync(source);
    if (stat.isDirectory()) {
      const dest = join(stagingParent, "src");
      cpSync(source, dest, { recursive: true });
      const mdir = findManifestDir(dest);
      if (!mdir) {
        throw new Error(
          `No manifest.json found in '${source}' (or a single top-level subdir).`
        );
      }
      return mdir;
    }
    // Local tarball
    return extractTarball(source, stagingParent);
  }

  // URL source
  if (/\.git$/.test(source) || /^git[@+]/.test(source)) {
    const dest = join(stagingParent, "clone");
    const { code, stderr } = runProcess([
      "git",
      "clone",
      "--depth",
      "1",
      source.replace(/^git\+/, ""),
      dest,
    ]);
    if (code !== 0) {
      throw new Error(`git clone failed for '${source}': ${stderr.trim()}`);
    }
    rmSync(join(dest, ".git"), { recursive: true, force: true });
    const mdir = findManifestDir(dest);
    if (!mdir) {
      throw new Error(
        `Cloned repo '${source}' has no manifest.json at root or one subdir.`
      );
    }
    return mdir;
  }

  // HTTP(S) tarball download
  const tarballPath = join(stagingParent, "download.tgz");
  const res = await fetch(source);
  if (!res.ok) {
    throw new Error(`Download failed for '${source}': HTTP ${res.status}`);
  }
  writeFileSync(tarballPath, Buffer.from(await res.arrayBuffer()));
  return extractTarball(tarballPath, stagingParent);
}

/** Extract a `.tgz`/`.tar.gz` into `stagingParent/extract` and locate the manifest dir. */
function extractTarball(tarballPath: string, stagingParent: string): string {
  const extractDir = join(stagingParent, "extract");
  mkdirSync(extractDir, { recursive: true });
  const { code, stderr } = runProcess([
    "tar",
    "-xzf",
    tarballPath,
    "-C",
    extractDir,
  ]);
  if (code !== 0) {
    throw new Error(
      `tar extraction failed for '${tarballPath}': ${stderr.trim()}`
    );
  }
  const mdir = findManifestDir(extractDir);
  if (!mdir) {
    throw new Error(
      `Tarball '${tarballPath}' has no manifest.json at root or one subdir.`
    );
  }
  return mdir;
}

/** Parse + validate a staged `manifest.json`, returning the parsed manifest. */
function readStagedManifest(dir: string): { id: string; version: string } {
  const manifestPath = join(dir, "manifest.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Invalid manifest.json in '${dir}': ${(err as Error).message}`
    );
  }
  const parsed = parseFsManifest(raw);
  if (!parsed.ok) {
    throw new Error(`manifest.json validation failed: ${parsed.error}`);
  }
  return { id: parsed.manifest.id, version: parsed.manifest.version };
}

/**
 * Install an extension from `source` into `${extensionsDir}/<id>/`.
 *
 * - local path / URL (git or tarball) OR a bare registry id resolved via the marketplace
 *   catalog (#1292 → {@link resolveRegistryId}); the resolved manifest id is integrity-checked
 *   against the requested catalog id ({@link RegistryIntegrityError}).
 * - The staged `manifest.json` is validated via `parseFsManifest` BEFORE placement;
 *   on any failure the partial staging is removed and nothing lands under the
 *   extensions dir.
 * - An `.hapi-install.json` sidecar records the origin so `update` can re-fetch.
 * - Returns `warnings` the command layer surfaces (loader gating + trust posture).
 */
export async function installExtension(
  source: string,
  extensionsDir: string,
  opts: RegistrySourceOpts = {}
): Promise<InstallResult> {
  let kind = classifySource(source);

  // A bare registry id (`<publisher>.<name>`) resolves via the marketplace catalog
  // (#1292): look the id up, get the author repo's git URL, then install through the
  // SAME pipeline as a URL source. The ORIGINAL id is recorded in the sidecar below so
  // `hapi ext update` re-resolves it against the catalog.
  let materializeUrl = source;
  let expectedId: string | undefined;
  const sidecarSource = source;
  if (kind === "registry") {
    const resolution = await resolveRegistryId(source, {
      catalogUrl: resolveCatalogUrl(opts.catalogUrl),
      fetchImpl: opts.fetchImpl,
    });
    materializeUrl = resolution.source;
    expectedId = resolution.id;
    kind = classifySource(materializeUrl);
  }
  // Defensive: a resolved registry source is always a URL; this narrows `kind` to
  // "url" | "local" for materializeSource and fail-closes if a future entryToSource
  // ever yielded a non-URL/non-path.
  if (kind === "registry") {
    throw new RegistryError(
      "invalid_catalog",
      `resolved source for '${source}' is not a URL or path`
    );
  }

  const stagingParent = mkdtempSync(join(tmpdir(), "hapi-ext-install-"));
  try {
    const stagedDir = await materializeSource(
      materializeUrl,
      kind,
      stagingParent
    );
    const { id, version } = readStagedManifest(stagedDir);
    // Integrity (#1292 R4): a catalog entry must not resolve to a repo whose manifest
    // declares a different id than the one the user requested.
    if (expectedId && id !== expectedId) {
      throw new RegistryIntegrityError(expectedId, id);
    }
    // Guard against a crafted manifest id escaping the extensions dir (the FS-manifest
    // schema does not constrain id characters).
    assertSafeExtensionId(id);

    const target = join(extensionsDir, id);
    if (existsSync(target)) {
      throw new ExtensionAlreadyInstalledError(id);
    }

    // Supply-chain scan seam (#3120; Sub Q / #3131 fills it). Runs on the STAGED bytes,
    // BEFORE finalize — a `block` verdict throws here, and the outer `finally` removes the
    // staging dir so nothing lands under the extensions dir. Absent hook = no-op pass.
    await assertScanPass(opts.scanBeforeInstall, {
      kind: "extension",
      id,
      stagedDir,
    });

    mkdirSync(extensionsDir, { recursive: true });
    cpSync(stagedDir, target, { recursive: true });

    writeInstallSidecar(target, sidecarSource, version, id);

    return { id, version, warnings: installWarnings() };
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}

/**
 * Warnings every successful install surfaces: filesystem extensions load only when
 * `HAPI_FS_EXTENSIONS` is truthy, and they run in-process at host privilege (no sandbox
 * in v0.x — #1291's decision). Purely advisory; not blocking.
 */
function installWarnings(): string[] {
  const warnings: string[] = [
    "Installed extensions run IN-PROCESS at host privilege (no sandbox in v0.x — see #1291).",
  ];
  const fsEnabled = ["true", "1", "yes"].includes(
    (process.env.HAPI_FS_EXTENSIONS || "").toLowerCase()
  );
  if (!fsEnabled) {
    warnings.push(
      "HAPI_FS_EXTENSIONS is not set — filesystem extensions will NOT load until you enable it (export HAPI_FS_EXTENSIONS=1) and restart."
    );
  }
  return warnings;
}

/**
 * Uninstall a filesystem extension: remove `${extensionsDir}/<id>/`. With `purge`,
 * ALSO drop the extension's server-owned `ext_<sanitizedId>_*` tables and its
 * `extension_prefs` row; without it, that data is preserved (arch-doc semantic).
 * Returns the list of purged table names (empty unless `purge`).
 */
export function uninstallExtension(
  id: string,
  extensionsDir: string,
  opts: { purge?: boolean } = {}
): { purgedTables: string[]; prefRemoved: boolean } {
  const target = join(extensionsDir, id);
  if (!existsSync(target)) {
    throw new ExtensionNotInstalledError(id);
  }
  rmSync(target, { recursive: true, force: true });

  if (!opts.purge) {
    return { purgedTables: [], prefRemoved: false };
  }
  const purgedTables = purgeExtensionTables(id);
  const prefRemoved = removeCliExtensionPref(id);
  return { purgedTables, prefRemoved };
}

/**
 * Drop every `ext_<sanitizedId>_*` table owned by the extension from the shared
 * instance DB. Table names cannot be bound parameters, so each is read back from
 * `sqlite_master` (a real, quoted identifier) — never interpolated from user input.
 * No-op (returns `[]`) when the DB is absent.
 */
function purgeExtensionTables(id: string): string[] {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) return [];
  const db = openDatabase(dbPath, false);
  try {
    const prefix = `ext_${sanitizeExtensionId(id)}_`;
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?"
      )
      .all(`${prefix}%`) as { name: string }[];
    for (const t of tables) {
      db.prepare(`DROP TABLE IF EXISTS "${t.name}"`).run();
    }
    return tables.map(t => t.name);
  } catch (err) {
    logger.warn(`[ext:manage] purge tables failed for '${id}':`, err);
    return [];
  } finally {
    db.close();
  }
}

/**
 * Read every filesystem extension's manifest directly (any runtime — NOT filtered to
 * `cli` like `fsLoader.scanFilesystemExtensions`), so `hapi ext list` shows everything
 * the user installed. Invalid manifests are logged and skipped (fail-soft).
 */
function scanInstalledManifests(extensionsDir: string): {
  id: string;
  displayName: string;
  version: string;
  defaultEnabled: boolean;
}[] {
  if (!existsSync(extensionsDir)) return [];
  const out: {
    id: string;
    displayName: string;
    version: string;
    defaultEnabled: boolean;
  }[] = [];
  for (const dirent of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const manifestPath = join(extensionsDir, dirent.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      logger.warn(
        `[ext:manage] skipping '${dirent.name}': invalid manifest.json:`,
        err
      );
      continue;
    }
    const parsed = parseFsManifest(raw);
    if (!parsed.ok) {
      logger.warn(`[ext:manage] skipping '${dirent.name}': ${parsed.error}`);
      continue;
    }
    const m = parsed.manifest;
    out.push({
      id: m.id,
      displayName: m.displayName,
      version: m.version,
      defaultEnabled: m.defaultEnabled,
    });
  }
  return out;
}

/**
 * List all extensions the CLI can see: build-time CLI builtins (from the generated
 * registry) plus every filesystem extension under `extensionsDir`. Enabled state comes
 * from the `extension_prefs` store (builtins with `requiredAtBuild` are always enabled).
 * Sorted by id for deterministic output.
 */
export function listInstalledExtensions(
  extensionsDir: string
): InstalledExtension[] {
  const rows: InstalledExtension[] = [];
  const seen = new Set<string>();

  for (const { manifest } of builtinCliExtensions) {
    const enabled =
      manifest.requiredAtBuild === true ||
      readCliExtensionPref(manifest.id, manifest.defaultEnabled).enabled;
    rows.push({
      id: manifest.id,
      displayName: manifest.displayName,
      version: manifest.version,
      source: "builtin",
      enabled,
    });
    seen.add(manifest.id);
  }

  for (const m of scanInstalledManifests(extensionsDir)) {
    if (seen.has(m.id)) continue; // a builtin shadows a same-id filesystem entry
    rows.push({
      id: m.id,
      displayName: m.displayName,
      version: m.version,
      source: "filesystem",
      enabled: readCliExtensionPref(m.id, m.defaultEnabled).enabled,
    });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/** Read an installed extension's install sidecar, or null when absent/unreadable. */
function readSidecar(extensionsDir: string, id: string): InstallSidecar | null {
  const p = join(extensionsDir, id, INSTALL_SIDECAR);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as InstallSidecar;
  } catch {
    return null;
  }
}

/** Per-extension outcome of an {@link updateExtensions} run. */
export interface UpdateOutcome {
  id: string;
  status: "updated" | "skipped" | "failed";
  detail: string;
}

/**
 * Update filesystem extensions in place from their recorded install source.
 *
 * With `id`, updates that one extension; without, updates ALL filesystem extensions
 * that carry an install sidecar. Build-time builtins are never updated (they ship
 * inside the binary) — a builtin id is reported `skipped`. A registry-source sidecar
 * is `skipped` (registry updates pending #1292). Each update re-installs into a temp
 * target and atomically swaps, so a failed fetch never corrupts the live extension.
 */
export async function updateExtensions(
  extensionsDir: string,
  id?: string
): Promise<UpdateOutcome[]> {
  const builtinIds = new Set(builtinCliExtensions.map(e => e.manifest.id));
  const targetIds = id ? [id] : listUpdatableIds(extensionsDir);
  const outcomes: UpdateOutcome[] = [];

  for (const extId of targetIds) {
    if (builtinIds.has(extId)) {
      outcomes.push({
        id: extId,
        status: "skipped",
        detail:
          "build-time builtin — updates with the hapi binary, not via CLI",
      });
      continue;
    }
    if (!existsSync(join(extensionsDir, extId))) {
      outcomes.push({ id: extId, status: "failed", detail: "not installed" });
      continue;
    }
    const sidecar = readSidecar(extensionsDir, extId);
    if (!sidecar) {
      outcomes.push({
        id: extId,
        status: "skipped",
        detail: `no ${INSTALL_SIDECAR} — cannot determine update source`,
      });
      continue;
    }
    // Registry sidecar sources now re-resolve via the marketplace catalog (#1292) — no
    // longer skipped; reinstallInPlace() handles the catalog lookup + integrity gate.
    try {
      await reinstallInPlace(sidecar.source, extensionsDir, extId);
      outcomes.push({
        id: extId,
        status: "updated",
        detail: `from ${sidecar.source}`,
      });
    } catch (err) {
      outcomes.push({
        id: extId,
        status: "failed",
        detail: (err as Error).message,
      });
    }
  }
  return outcomes;
}

/** Filesystem extension ids that carry an install sidecar (candidates for `update`). */
function listUpdatableIds(extensionsDir: string): string[] {
  if (!existsSync(extensionsDir)) return [];
  return readdirSync(extensionsDir, { withFileTypes: true })
    .filter(
      e =>
        e.isDirectory() &&
        existsSync(join(extensionsDir, e.name, INSTALL_SIDECAR))
    )
    .map(e => e.name)
    .sort();
}

/**
 * Re-install `source` over an existing extension `id`: stage + validate first, confirm
 * the fetched id matches, then swap the live dir for the fresh one atomically (the old
 * dir is only removed once the new content is validated and staged next to it).
 */
async function reinstallInPlace(
  source: string,
  extensionsDir: string,
  id: string,
  opts: RegistrySourceOpts = {}
): Promise<void> {
  let kind = classifySource(source);
  let materializeUrl = source;
  if (kind === "registry") {
    // Registry sidecar source (#1292): re-resolve the id → the author repo's current URL
    // so `update` pulls the latest. The `fetchedId !== id` check below is the integrity gate.
    const resolution = await resolveRegistryId(source, {
      catalogUrl: resolveCatalogUrl(opts.catalogUrl),
      fetchImpl: opts.fetchImpl,
    });
    materializeUrl = resolution.source;
    kind = classifySource(materializeUrl);
  }
  if (kind === "registry") {
    throw new RegistryError(
      "invalid_catalog",
      `resolved source for '${source}' is not a URL or path`
    );
  }

  const stagingParent = mkdtempSync(join(tmpdir(), "hapi-ext-update-"));
  try {
    const stagedDir = await materializeSource(
      materializeUrl,
      kind,
      stagingParent
    );
    const { id: fetchedId, version } = readStagedManifest(stagedDir);
    if (fetchedId !== id) {
      throw new Error(
        `source now resolves to id '${fetchedId}', not '${id}' — refusing to update`
      );
    }
    const target = join(extensionsDir, id);
    const backup = join(extensionsDir, `.${id}.bak-${Date.now()}`);
    // Move the live dir aside, copy the fresh one in, then drop the backup.
    // On failure the backup is restored so the live extension is never lost.
    try {
      cpSync(target, backup, { recursive: true });
      rmSync(target, { recursive: true, force: true });
      cpSync(stagedDir, target, { recursive: true });
      writeInstallSidecar(target, source, version, id);
      rmSync(backup, { recursive: true, force: true });
    } catch (swapErr) {
      // Restore from backup on any swap failure.
      if (existsSync(backup)) {
        rmSync(target, { recursive: true, force: true });
        cpSync(backup, target, { recursive: true });
        rmSync(backup, { recursive: true, force: true });
      }
      throw swapErr;
    }
  } finally {
    rmSync(stagingParent, { recursive: true, force: true });
  }
}
