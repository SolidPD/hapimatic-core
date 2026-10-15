// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Extracts the platform's tool archives (difftastic, ripgrep) and keeps the
 * size manifest that proves an extraction complete (#5103). Shared by the
 * compiled binary's runtime-asset directory (`./assets.ts`) and the source
 * checkout's `bun run tools:unpack` (`cli/scripts/unpack-tools.ts`, #5125).
 *
 * No `@/` imports. cli/scripts/unpack-tools.ts imports this before vitest sets
 * a scratch HAPI_HOME, and `@/configuration` creates HAPI_HOME and its logs
 * directory on import (#5125).
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";
import * as tar from "tar";

/**
 * #5103: `{ "files": { "<path under tools/unpacked>": <bytes> } }` — the size every
 * extracted file's archive entry declared. Written last by unpackTools (before the
 * compiled binary's marker) and checked before the tools are used — on every
 * compiled start and every `bun run tools:unpack` (#5125) — so a missing or
 * truncated tool is never trusted.
 */
export const RUNTIME_MANIFEST = ".runtime-manifest.json";
/**
 * #5103: how every tool archive is extracted. `strict` makes a failed write throw
 * instead of leaving a truncated file behind; `noMtime` skips restoring the
 * archive's timestamps, a step that strict mode would otherwise turn into a
 * failed start on a filesystem that refuses utimes (nothing reads tool mtimes).
 */
export const TOOL_EXTRACT_OPTIONS = {
  sync: true,
  preserveOwner: false,
  strict: true,
  noMtime: true,
} as const;

export function getPlatformDir(): string {
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

/** The tool binaries every runtime directory must carry. */
function requiredToolNames(): string[] {
  const isWin = platform() === "win32";
  return isWin ? ["difft.exe", "rg.exe"] : ["difft", "rg"];
}

/**
 * #5103: the first way `unpackedDir` differs from the manifest's declared files,
 * or null when every file is there at its declared size and the required tools
 * are listed.
 */
function findManifestProblem(
  unpackedDir: string,
  files: Record<string, number>
): string | null {
  for (const tool of requiredToolNames()) {
    if (!(tool in files)) {
      return `${tool} is not in the manifest`;
    }
  }
  for (const [relativePath, size] of Object.entries(files)) {
    let actual: number;
    try {
      actual = statSync(join(unpackedDir, relativePath)).size;
    } catch {
      return `${relativePath} is missing`;
    }
    if (actual !== size) {
      return `${relativePath} is ${actual} of ${size} bytes`;
    }
  }
  return null;
}

/** The manifest's declared files, or null when it is absent or malformed. */
function readRuntimeManifest(dir: string): Record<string, number> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, RUNTIME_MANIFEST), "utf-8"));
  } catch {
    return null;
  }
  const files = (parsed as { files?: unknown } | null)?.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return null;
  }
  const entries = Object.entries(files as Record<string, unknown>);
  if (
    entries.length === 0 ||
    entries.some(
      ([, size]) =>
        typeof size !== "number" || !Number.isInteger(size) || size < 0
    )
  ) {
    return null;
  }
  return files as Record<string, number>;
}

/**
 * #5103: why `dir` is not a complete runtime directory, or null when its
 * manifest lists the tools and every listed file is there at its declared size.
 * Called before the marker is written and on every start.
 */
export function runtimeDirProblem(dir: string): string | null {
  const files = readRuntimeManifest(dir);
  if (!files) {
    return "no readable manifest";
  }
  return findManifestProblem(join(dir, "tools", "unpacked"), files);
}

/**
 * Extracts the platform's tool archives into `<runtimeRoot>/tools/unpacked`.
 * Always a full extract: it removes tools/unpacked first, so existing binaries
 * can never shadow the archives' contents (#4594 fixture S2).
 *
 * #5103: the extract is strict, so a failed write throws instead of leaving a
 * truncated file behind, and the size each archive entry declared is checked and
 * recorded in the runtime manifest.
 */
export function unpackTools(runtimeRoot: string): void {
  const platformDir = getPlatformDir();
  const toolsDir = join(runtimeRoot, "tools");
  const archivesDir = join(toolsDir, "archives");
  const unpackedPath = join(toolsDir, "unpacked");

  rmSync(unpackedPath, { recursive: true, force: true });
  mkdirSync(unpackedPath, { recursive: true });

  const archives = [
    `difftastic-${platformDir}.tar.gz`,
    `ripgrep-${platformDir}.tar.gz`,
  ];

  const declared: Record<string, number> = {};
  for (const archiveName of archives) {
    const archivePath = join(archivesDir, archiveName);
    if (!existsSync(archivePath)) {
      throw new Error(`Archive not found: ${archivePath}`);
    }
    tar.extract({
      ...TOOL_EXTRACT_OPTIONS,
      file: archivePath,
      cwd: unpackedPath,
      onReadEntry: entry => {
        if (
          entry.type === "File" ||
          entry.type === "OldFile" ||
          entry.type === "ContiguousFile"
        ) {
          declared[entry.path.replace(/^(?:\.\/)+/, "")] = entry.size;
        }
      },
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

  const problem = findManifestProblem(unpackedPath, declared);
  if (problem) {
    throw new Error(`Runtime tools were extracted incompletely: ${problem}`);
  }
  writeFileSync(
    join(runtimeRoot, RUNTIME_MANIFEST),
    JSON.stringify({ files: declared }),
    "utf-8"
  );
}

/**
 * #5125: the dev/test path (`bun run tools:unpack`, root = cli/). Uses the
 * compiled binary's own manifest check: the tools count as unpacked only when
 * `.runtime-manifest.json` lists them and every listed file is at its declared
 * size. Otherwise the old manifest is removed first and unpackTools writes the
 * new one last, so a run that stops at any point (a thrown error, SIGINT or
 * SIGKILL) leaves no manifest, and the next run extracts again.
 *
 * @param onExtract called with the reason, before extracting
 * @returns whether the existing extraction was reused, and why it was not
 */
export function ensureToolsUnpacked(
  root: string,
  onExtract?: (reason: string) => void
): { alreadyUnpacked: boolean; reason: string | null } {
  const reason = runtimeDirProblem(root);
  if (reason === null) {
    return { alreadyUnpacked: true, reason: null };
  }
  onExtract?.(reason);
  rmSync(join(root, RUNTIME_MANIFEST), { force: true });
  try {
    unpackTools(root);
  } catch (error) {
    // A thrown extraction removes its partial directory. This is disk hygiene,
    // not correctness: with the manifest already gone, the next run extracts
    // again whatever is left here.
    rmSync(join(root, "tools", "unpacked"), { recursive: true, force: true });
    throw error;
  }
  return { alreadyUnpacked: false, reason };
}
