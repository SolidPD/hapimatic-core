// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { arch, platform } from "node:os";
import * as tar from "tar";
import type { EmbeddedAsset } from "#embedded-assets";
import { isBunCompiled, runtimeAssetsBasePath } from "@/projectPath";
import { runtimeAssetsKey } from "@/runtime/assetsKey";
import { logger } from "@/ui/logger";

/** Names the key a runtime directory was extracted for; written last, before publishing. */
const RUNTIME_MARKER = ".runtime-version";
/** A private extraction in progress: `.tmp-<key>-<pid>-<random>`. */
const TEMP_PREFIX = ".tmp-";
/** A torn final directory moved aside before publishing over it. */
const STALE_PREFIX = ".stale-";

/** R6: a runtime directory modified within this window is never pruned. */
export const PRUNE_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** A `.tmp-*` extraction younger than this may still be running; never touch it. */
export const TEMP_MIN_AGE_MS = 60 * 60 * 1000;

type RuntimeLog = (message: string, error?: unknown) => void;

const defaultLog: RuntimeLog = (message, error) => {
  if (error === undefined) {
    logger.debug(message);
  } else {
    logger.debug(message, error);
  }
};

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

const bunRuntime = (
  globalThis as typeof globalThis & {
    Bun?: {
      file: (source: string | URL) => {
        arrayBuffer: () => Promise<ArrayBuffer>;
      };
    };
  }
).Bun;

async function copyAssetFile(
  asset: EmbeddedAsset,
  targetPath: string
): Promise<void> {
  ensureDirectory(dirname(targetPath));
  if (bunRuntime) {
    const data = await bunRuntime.file(asset.sourcePath).arrayBuffer();
    writeFileSync(targetPath, Buffer.from(data));
    return;
  }

  copyFileSync(asset.sourcePath, targetPath);
  try {
    const stats = statSync(asset.sourcePath);
    chmodSync(targetPath, stats.mode);
  } catch {
    // Best-effort; permission adjustments are not critical.
  }
}

function getPlatformDir(): string {
  const platformName = platform();
  const archName = arch();

  if (platformName === "darwin") {
    if (archName === "arm64") return "arm64-darwin";
    if (archName === "x64") return "x64-darwin";
  } else if (platformName === "linux") {
    if (archName === "arm64") return "arm64-linux";
    if (archName === "x64") return "x64-linux";
  } else if (platformName === "win32") {
    if (archName === "x64") return "x64-win32";
  }

  throw new Error(`Unsupported platform: ${archName}-${platformName}`);
}

function areToolsUnpacked(unpackedPath: string): boolean {
  if (!existsSync(unpackedPath)) {
    return false;
  }

  const isWin = platform() === "win32";
  const difftBinary = isWin ? "difft.exe" : "difft";
  const rgBinary = isWin ? "rg.exe" : "rg";

  const expectedFiles = [
    join(unpackedPath, difftBinary),
    join(unpackedPath, rgBinary),
  ];

  return expectedFiles.every(file => existsSync(file));
}

/**
 * Extracts the platform's tool archives into `<runtimeRoot>/tools/unpacked`.
 * Always a full extract: it only ever runs on a fresh private directory, so
 * existing binaries can never shadow the archives' contents (#4594 fixture S2).
 */
export function unpackTools(runtimeRoot: string): void {
  const platformDir = getPlatformDir();
  const toolsDir = join(runtimeRoot, "tools");
  const archivesDir = join(toolsDir, "archives");
  const unpackedPath = join(toolsDir, "unpacked");

  rmSync(unpackedPath, { recursive: true, force: true });
  ensureDirectory(unpackedPath);

  const archives = [
    `difftastic-${platformDir}.tar.gz`,
    `ripgrep-${platformDir}.tar.gz`,
  ];

  for (const archiveName of archives) {
    const archivePath = join(archivesDir, archiveName);
    if (!existsSync(archivePath)) {
      throw new Error(`Archive not found: ${archivePath}`);
    }
    tar.extract({
      file: archivePath,
      cwd: unpackedPath,
      sync: true,
      preserveOwner: false,
    });
  }

  if (platform() !== "win32") {
    const files = readdirSync(unpackedPath);
    for (const file of files) {
      if (file.endsWith(".node")) {
        continue;
      }
      const filePath = join(unpackedPath, file);
      const stats = statSync(filePath);
      if (stats.isFile()) {
        chmodSync(filePath, 0o755);
      }
    }
  }
}

/** A published runtime directory: its marker names `key` and both tools are unpacked. */
export function isRuntimeDirReady(dir: string, key: string): boolean {
  try {
    return (
      readFileSync(join(dir, RUNTIME_MARKER), "utf-8").trim() === key &&
      areToolsUnpacked(join(dir, "tools", "unpacked"))
    );
  } catch {
    return false;
  }
}

function uniqueSuffix(): string {
  return `${process.pid}-${randomBytes(4).toString("hex")}`;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

/**
 * Renames a complete private extraction to its final name (R5). A final
 * directory that is already published wins and the private copy is discarded;
 * a torn one (no marker, or tools missing) is moved aside first, never
 * rewritten in place.
 */
function publishRuntimeDir(
  tempDir: string,
  finalDir: string,
  baseDir: string,
  key: string,
  log: RuntimeLog
): void {
  if (existsSync(finalDir)) {
    if (isRuntimeDirReady(finalDir, key)) {
      rmSync(tempDir, { recursive: true, force: true });
      return;
    }
    const aside = join(baseDir, `${STALE_PREFIX}${key}-${uniqueSuffix()}`);
    try {
      renameSync(finalDir, aside);
      log(`[RUNTIME] moved a torn runtime directory aside: ${aside}`);
    } catch (error) {
      // A concurrent extractor moved it first.
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  try {
    renameSync(tempDir, finalDir);
  } catch (error) {
    // Lost the race: another extractor published between the check and the
    // rename (a rename onto a non-empty directory fails rather than merging).
    if (isRuntimeDirReady(finalDir, key)) {
      rmSync(tempDir, { recursive: true, force: true });
      return;
    }
    throw error;
  }
}

export interface PruneRuntimeDirsOptions {
  /** `<HAPI_HOME>/runtime` */
  baseDir: string;
  /** This binary's key: never pruned. */
  currentKey: string;
  now: number;
  log?: RuntimeLog;
}

/**
 * R6: keeps the current key's directory and the single most recently modified
 * other one (a session started by the previous build may still use it), and
 * deletes the rest once they are older than 24 hours. A `.stale-*` directory
 * (a torn copy moved aside) is removed after 24 hours and a `.tmp-*` extraction
 * after an hour; other dot-entries, files and symlinks are never touched. Never
 * throws: a pruning error is logged and swallowed.
 *
 * @returns the names it removed
 */
export function pruneRuntimeDirs(options: PruneRuntimeDirsOptions): string[] {
  const { baseDir, currentKey, now } = options;
  const log = options.log ?? defaultLog;
  const removed: string[] = [];
  try {
    const dirs: Array<{ name: string; mtimeMs: number }> = [];
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === currentKey) {
        continue;
      }
      const isDot = entry.name.startsWith(".");
      if (
        isDot &&
        !entry.name.startsWith(TEMP_PREFIX) &&
        !entry.name.startsWith(STALE_PREFIX)
      ) {
        continue;
      }
      try {
        dirs.push({
          name: entry.name,
          mtimeMs: statSync(join(baseDir, entry.name)).mtimeMs,
        });
      } catch (error) {
        log(`[RUNTIME] could not stat ${entry.name}; not pruning it`, error);
      }
    }

    const newestOther = dirs
      .filter(dir => !dir.name.startsWith("."))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name;

    for (const dir of dirs) {
      if (dir.name === newestOther) {
        continue;
      }
      const minAgeMs = dir.name.startsWith(TEMP_PREFIX)
        ? TEMP_MIN_AGE_MS
        : PRUNE_MIN_AGE_MS;
      if (now - dir.mtimeMs < minAgeMs) {
        continue;
      }
      try {
        rmSync(join(baseDir, dir.name), { recursive: true, force: true });
        removed.push(dir.name);
        log(`[RUNTIME] pruned runtime directory ${dir.name}`);
      } catch (error) {
        log(`[RUNTIME] could not prune ${dir.name}`, error);
      }
    }
  } catch (error) {
    log(`[RUNTIME] could not prune ${baseDir}`, error);
  }
  return removed;
}

export interface EnsureRuntimeDirOptions {
  /** `<HAPI_HOME>/runtime` */
  baseDir: string;
  key: string;
  /** Fills a fresh, empty directory with the embedded assets and unpacked tools. */
  populate: (dir: string) => Promise<void>;
  now?: () => number;
  log?: RuntimeLog;
}

/**
 * Returns `<baseDir>/<key>`, ready to use (#4594 R4-R6). When it is already
 * published this is a marker read and a few stats. Otherwise the assets are
 * extracted into a private `.tmp-*` directory, the marker is written last (only
 * once the tools are there), the directory is published with an atomic rename,
 * and older directories are pruned. A failed extraction, including one that
 * left the tools missing, removes its private directory and throws.
 */
export async function ensureRuntimeDir(
  options: EnsureRuntimeDirOptions
): Promise<string> {
  const { baseDir, key, populate } = options;
  const log = options.log ?? defaultLog;
  const finalDir = join(baseDir, key);
  if (isRuntimeDirReady(finalDir, key)) {
    return finalDir;
  }

  ensureDirectory(baseDir);
  const tempDir = join(baseDir, `${TEMP_PREFIX}${key}-${uniqueSuffix()}`);
  mkdirSync(tempDir);
  try {
    await populate(tempDir);
    // The marker promises the tools are there, so check them first: a
    // non-strict tar extract can return without having written its files.
    if (!areToolsUnpacked(join(tempDir, "tools", "unpacked"))) {
      throw new Error(
        `Runtime assets for ${key} were extracted without the difft and rg tools`
      );
    }
    writeFileSync(join(tempDir, RUNTIME_MARKER), key, "utf-8");
    publishRuntimeDir(tempDir, finalDir, baseDir, key, log);
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }

  pruneRuntimeDirs({
    baseDir,
    currentKey: key,
    now: (options.now ?? Date.now)(),
    log,
  });
  return finalDir;
}

async function populateFromEmbeddedAssets(dir: string): Promise<void> {
  const { loadEmbeddedAssets } = await import("#embedded-assets");
  for (const asset of await loadEmbeddedAssets()) {
    await copyAssetFile(asset, join(dir, asset.relativePath));
  }
  unpackTools(dir);
}

export async function ensureRuntimeAssets(): Promise<void> {
  if (!isBunCompiled()) {
    return;
  }

  await ensureRuntimeDir({
    baseDir: runtimeAssetsBasePath(),
    key: runtimeAssetsKey(),
    populate: populateFromEmbeddedAssets,
  });
}
