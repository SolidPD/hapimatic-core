// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stale env-file sweep (issue #5994).
 *
 * Two 0600 files carry a session's secrets from the process that writes them to
 * the shell that sources them:
 *   - `/tmp/hapi-tmux-env-<sid>[-rN]`, written by the tmux launcher for each
 *     launch attempt (`claudeTmuxRemote.ts`), holding `CLAUDE_CODE_OAUTH_TOKEN`;
 *   - `<tmpdir>/hapi-spawn-env-<id>.sh`, written by the daemon for the hop into
 *     a session pane (`tmuxSpawnAdapter.ts`), holding `CLI_API_TOKEN`, and
 *     `CLAUDE_CODE_OAUTH_TOKEN` for an unbound session.
 * Each launch chain sources its file and then `rm`s it. The wrapper also removes
 * its file on every exit it can handle (an `exit` listener). A file is still
 * left when its process is SIGKILLed, when it dies on a SIGHUP (the wrapper has
 * no handler for it), or when the hop's chain stops before its `rm` (a failed
 * `cd`, say; the hop's shell is a non-login `bash <script>`). Without a sweep it
 * stays readable by every later same-uid process until `/tmp`'s own cleanup, 30
 * days or a reboot on a stock systemd host.
 *
 * Every daemon removes such files once they are 10 minutes old, on its 60 s
 * maintenance tick:
 *   - Why 10 minutes: a launch consumes its file within seconds, and an attempt
 *     holds it at most until the deaf-launch probe (5 s) or the readiness
 *     watchdog (45 s by default, `HAPI_TMUX_READINESS_TIMEOUT_MS`) ends it.
 *   - Why every daemon on a host may run it, each instance's files included: it
 *     is age-based and idempotent, and it never touches a file young enough to
 *     belong to a live launch.
 *
 * Only the two exact name shapes match. The daemon's persistent
 * `hapi-spawn-<id>.sh` scripts share the `hapi-spawn-` prefix but hold no
 * secret, and their 8-character base36 id has no hyphen, so they never match
 * `hapi-spawn-env-*.sh`. An entry is removed only when `lstat` reports a regular
 * file (a symlink is never followed), owned by this process's uid, last modified
 * more than `maxAgeMs` ago. The sweep never throws, and it logs each removal by
 * path and age, never by content.
 *
 * The `{ dirs, readdir, lstat, unlink, now, uid, maxAgeMs }` seam is injectable
 * so `healthScheduler.test.ts` and `run.test.ts` can stub the module and keep
 * their ticks off the real `/tmp`, and so this module's own tests can sweep a
 * temporary directory.
 */
import { lstatSync, readdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { logger } from "@/ui/logger";

/** A file this old cannot belong to a live launch. */
export const STALE_ENV_FILE_MAX_AGE_MS = 10 * 60_000;

/** The tmux launcher's per-attempt env file (`claudeTmuxRemote.ts`). */
const LAUNCHER_ENV_FILE = /^hapi-tmux-env-[A-Za-z0-9_-]+$/;
/** The daemon hop's env file (`tmuxSpawnAdapter.ts`), never its script. */
const SPAWN_ENV_FILE = /^hapi-spawn-env-[A-Za-z0-9_-]+\.sh$/;

/** The fields of an `lstat` result the sweep reads. */
export type EnvFileStat = {
  isFile(): boolean;
  uid: number;
  mtimeMs: number;
};

/** Injectable I/O seam (production defaults applied via `?? default`). */
export type StaleEnvFileSweepSeam = {
  /** Directories to sweep (default: `/tmp` and `os.tmpdir()`, de-duplicated). */
  dirs: string[];
  /** List a directory's entries (default: `readdirSync`). */
  readdir: (dir: string) => string[];
  /** `lstat` an entry — NOT `stat`, so a symlink is never followed. */
  lstat: (path: string) => EnvFileStat;
  /** Remove a file (default: `unlinkSync`). */
  unlink: (path: string) => void;
  /** Current time in ms since the epoch (default: `Date.now`). */
  now: () => number;
  /** The uid a file must have (default: `process.getuid()`); `null` disables
   * the sweep, as it is on a platform with no uid. */
  uid: number | null;
  /** Remove only files last modified more than this long ago. */
  maxAgeMs: number;
};

export type StaleEnvFileSweepOptions = Partial<StaleEnvFileSweepSeam>;

export type StaleEnvFileSweepResult = {
  /** Matching regular files examined. */
  scanned: number;
  /** Paths removed this sweep. */
  unlinked: string[];
  /** Files kept because they are not older than `maxAgeMs`. */
  youngKept: number;
  /** Files kept because another uid owns them. */
  foreignKept: number;
  /** Files kept because `lstat` or `unlink` failed with anything but ENOENT. */
  errorKept: number;
  /** Files that were gone (ENOENT) by the time the sweep reached them. */
  absent: number;
};

function defaultDirs(): string[] {
  return [...new Set([resolve("/tmp"), resolve(tmpdir())])];
}

/**
 * One sweep pass over `dirs`. Never throws: an unreadable directory is skipped
 * and every per-file failure keeps the file. Returns a summary for the caller's
 * debug log.
 */
export function sweepStaleEnvFiles(
  options: StaleEnvFileSweepOptions = {}
): StaleEnvFileSweepResult {
  const result: StaleEnvFileSweepResult = {
    scanned: 0,
    unlinked: [],
    youngKept: 0,
    foreignKept: 0,
    errorKept: 0,
    absent: 0,
  };

  const uid =
    options.uid !== undefined ? options.uid : (process.getuid?.() ?? null);
  if (uid === null) return result;

  const dirs = options.dirs ?? defaultDirs();
  const readdir = options.readdir ?? ((dir: string) => readdirSync(dir));
  const lstat = options.lstat ?? ((path: string) => lstatSync(path));
  const unlink = options.unlink ?? ((path: string) => unlinkSync(path));
  const now = options.now ?? Date.now;
  const maxAgeMs = options.maxAgeMs ?? STALE_ENV_FILE_MAX_AGE_MS;

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdir(dir);
    } catch {
      continue; // Missing or unreadable — nothing to sweep here.
    }

    for (const entry of entries) {
      if (!LAUNCHER_ENV_FILE.test(entry) && !SPAWN_ENV_FILE.test(entry)) {
        continue;
      }
      const path = join(dir, entry);

      let stat: EnvFileStat;
      try {
        stat = lstat(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          result.absent += 1;
        } else {
          result.errorKept += 1;
          logger.debug(`[DAEMON RUN] could not lstat ${path}; keeping`, err);
        }
        continue;
      }
      if (!stat.isFile()) continue; // a symlink, directory or FIFO — never touched
      result.scanned += 1;

      if (stat.uid !== uid) {
        result.foreignKept += 1;
        continue;
      }
      const ageMs = now() - stat.mtimeMs;
      if (!(ageMs > maxAgeMs)) {
        result.youngKept += 1;
        continue;
      }

      try {
        unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          result.absent += 1;
        } else {
          result.errorKept += 1;
          logger.debug(`[DAEMON RUN] could not remove ${path}; keeping`, err);
        }
        continue;
      }
      result.unlinked.push(path);
      logger.info(
        `[DAEMON RUN] removed stale env file ${path} (${Math.round(ageMs / 1000)} s old)`
      );
    }
  }

  return result;
}
