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
import type { EmbeddedAsset } from "#embedded-assets";
import { isBunCompiled, runtimeAssetsBasePath } from "@/projectPath";
import { runtimeAssetsKey } from "@/runtime/assetsKey";
import {
  TOOL_EXTRACT_OPTIONS,
  runtimeDirProblem,
  unpackTools,
} from "@/runtime/toolExtraction";
import { logger } from "@/ui/logger";

/** Names the key a runtime directory was extracted for; written last, before publishing. */
const RUNTIME_MARKER = ".runtime-version";
/** #5103: private to this user — every session executes the binaries in it. */
const RUNTIME_DIR_MODE = 0o700;

// #5125: the tool extraction and its size manifest live in toolExtraction.ts,
// shared with the source checkout's `bun run tools:unpack`.
export { TOOL_EXTRACT_OPTIONS, runtimeDirProblem, unpackTools };

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

/**
 * A published runtime directory: its marker names `key`, and its manifest lists
 * the tools with every file at its declared size (#5103).
 */
export function isRuntimeDirReady(dir: string, key: string): boolean {
  try {
    return (
      readFileSync(join(dir, RUNTIME_MARKER), "utf-8").trim() === key &&
      runtimeDirProblem(dir) === null
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
 * a torn one (wrong or missing marker, or a tool missing, truncated or absent
 * from its manifest) is moved aside first, never rewritten in place.
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
    const reason = runtimeDirProblem(finalDir) ?? "wrong or missing marker";
    try {
      renameSync(finalDir, aside);
      log(
        `[RUNTIME] moved a torn runtime directory aside (${reason}): ${aside}`
      );
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
 * published this is a marker read, a manifest read and a few stats. Otherwise
 * the assets are extracted into a private `.tmp-*` directory, the marker is
 * written last (only once the manifest check passes, #5103), the directory is
 * published with an atomic rename, and older directories are pruned. A failed
 * extraction, including one that left a tool missing or truncated, removes its
 * private directory and throws. A published directory whose files no longer
 * match its manifest is not ready, so it is moved aside and extracted again.
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

  mkdirSync(baseDir, { recursive: true, mode: RUNTIME_DIR_MODE });
  const tempDir = join(baseDir, `${TEMP_PREFIX}${key}-${uniqueSuffix()}`);
  // Created private and renamed into place, so the published <key> directory
  // holding the tools is private too (#5103).
  mkdirSync(tempDir, { mode: RUNTIME_DIR_MODE });
  try {
    await populate(tempDir);
    // The marker promises a complete directory, so check the manifest first:
    // every tool present at the size its archive entry declared (#5103). Strict
    // extraction already throws on a failed write; this also catches a populate
    // that returned without its files.
    const problem = runtimeDirProblem(tempDir);
    if (problem) {
      throw new Error(
        `Runtime assets for ${key} failed the manifest check: ${problem}`
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
