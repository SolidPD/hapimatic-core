// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HAPI_INSTANCE_KIND_ENV,
  HAPI_WT_OWNER_WORKTREE_ENV,
  INSTANCE_KIND_FILE,
  classifyInstance,
  type InstanceKindPathStyle,
  type InstanceKindResult,
} from "./instanceKind";

/**
 * The Node-side reader of the instance-kind classifier (issue #6756). It gathers the inputs
 * `classifyInstance` (`./instanceKind`) takes and hands them over, and tells it which path
 * rules apply (`win32` on native Windows, `posix` elsewhere; #6981). Node-only: import it as
 * `@hapi/protocol/instanceKindReader`, never from the package root, so the web bundle never
 * pulls in `node:fs`.
 *
 * The caller passes the data dir its own configuration resolved (the CLI's
 * `configuration.happyHomeDir`, the server's `dataDir`); the reader never re-derives it from
 * the raw environment, so the classifier and the process can never disagree about which home
 * they mean.
 *
 * It NEVER throws: it runs in every daemon's and server's boot path on every node. A signal it
 * cannot read counts as absent and is named in `unreadable` (for the caller's one log line);
 * the other signals still apply. A missing file or path (ENOENT) is ordinary absence, not
 * "unreadable".
 */

export interface ReadInstanceKindOptions {
  /** The data dir the caller's configuration resolved; `null` when it could not be resolved. */
  dataDir: string | null;
  /** The instance's server port; `null` when unknown. */
  serverPort: number | null;
  /** The process's systemd unit name (CLI: `detectSelfUnitName`); the server passes nothing. */
  unitName?: string | null;
  /** Test seam: the environment to read `HAPI_INSTANCE_KIND` and `HAPI_WT_OWNER_WORKTREE` from. */
  env?: Record<string, string | undefined>;
  /** Test seam: the user's home (production: `os.homedir()`). */
  userHome?: string;
  /** Test seam: the path style (production: "win32" on native Windows, else "posix"). */
  pathStyle?: InstanceKindPathStyle;
}

export interface InstanceKindReading extends InstanceKindResult {
  /** Signals that could not be read (each counted as absent), e.g. `instance-kind file (EACCES)`. */
  unreadable: string[];
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

/** A path's realpath; `null` when it cannot be read (ENOENT silently, anything else named). */
function realpathOrNull(
  path: string | null,
  label: string,
  unreadable: string[]
): string | null {
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT") unreadable.push(`${label} realpath (${code})`);
    return null;
  }
}

/** The declaration file's first line, trimmed; `null` when absent. */
function readDeclarationFile(
  dataDir: string | null,
  unreadable: string[]
): string | null {
  if (!dataDir) return null;
  try {
    const first = readFileSync(join(dataDir, INSTANCE_KIND_FILE), "utf8").split(
      /\r?\n/,
      1
    )[0];
    return (first ?? "").trim();
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT")
      unreadable.push(`${INSTANCE_KIND_FILE} file (${code})`);
    return null;
  }
}

/** Read and classify this instance. Never throws. */
export function readInstanceKind(
  opts: ReadInstanceKindOptions
): InstanceKindReading {
  const unreadable: string[] = [];
  // Outside the `try` so the fallback below uses it too; reading the platform cannot throw.
  const pathStyle: InstanceKindPathStyle =
    opts.pathStyle ?? (process.platform === "win32" ? "win32" : "posix");
  try {
    const env = opts.env ?? process.env;
    let userHome = opts.userHome ?? "";
    if (!userHome) {
      try {
        userHome = homedir();
      } catch (error) {
        unreadable.push(`user home (${errorCode(error)})`);
      }
    }
    const result = classifyInstance({
      hapiHome: opts.dataDir,
      hapiHomeRealpath: realpathOrNull(opts.dataDir, "data dir", unreadable),
      userHome,
      userHomeRealpath: realpathOrNull(
        userHome || null,
        "user home",
        unreadable
      ),
      serverPort: opts.serverPort,
      unitName: opts.unitName ?? null,
      declared: {
        file: readDeclarationFile(opts.dataDir, unreadable),
        env: env[HAPI_INSTANCE_KIND_ENV] ?? null,
      },
      wtOwnerWorktree: env[HAPI_WT_OWNER_WORKTREE_ENV] ?? null,
      pathStyle,
    });
    return { ...result, unreadable };
  } catch (error) {
    // classifyInstance is pure and should not throw; if anything here does, fall back to the
    // inputs that need no I/O so a boot never fails on the classifier.
    unreadable.push(`classifier (${errorCode(error)})`);
    const fallback = classifyInstance({
      hapiHome: opts.dataDir,
      userHome: opts.userHome ?? "",
      serverPort: opts.serverPort,
      unitName: opts.unitName ?? null,
      declared: { file: null, env: null },
      wtOwnerWorktree: null,
      pathStyle,
    });
    return { ...fallback, unreadable };
  }
}
