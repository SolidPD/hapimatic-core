// SPDX-License-Identifier: AGPL-3.0-only
import type { Stats } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { logger } from "@/ui/logger";

/**
 * Thrown by {@link withFileLock} when the lock could not be acquired within
 * the configured timeout. Distinct from generic IO/transport errors so callers
 * can map it to a contention-specific error code (e.g. `config_lock_timeout`)
 * and surface a "another process is mutating this file, please retry" message
 * instead of a misleading "transport failed".
 */
export class FileLockTimeoutError extends Error {
  readonly lockPath: string;
  readonly attempts: number;
  readonly timeoutMs: number;
  constructor(lockPath: string, attempts: number, timeoutMs: number) {
    super(
      `Failed to acquire file lock at ${lockPath} after ${attempts} attempts ` +
        `(${timeoutMs}ms total). The lock may be held by another process.`
    );
    this.name = "FileLockTimeoutError";
    this.lockPath = lockPath;
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
  }
}

export interface FileLockOptions {
  /** Path to the .lock sentinel file. */
  lockPath: string;
  /** ms between lock acquisition attempts. Default: 100. */
  retryIntervalMs?: number;
  /** Maximum number of attempts. Default: 50 (5 seconds at 100ms). */
  maxAttempts?: number;
  /** ms after which a lock file's mtime is considered stale and reaped. Default: 10000. */
  staleTimeoutMs?: number;
  /**
   * ms between refreshes of the holder's own lock mtime, made through its open
   * handle so a live holder is never judged stale. Default:
   * `max(10, floor(staleTimeoutMs / 3))`. `0` disables the refresh.
   */
  heartbeatMs?: number;
}

/**
 * Acquire an exclusive cross-process lock on `lockPath`, run `fn`, then release
 * the lock. Uses Node's `wx` open flag (POSIX `O_CREAT | O_EXCL`) which is
 * atomic across processes — exactly one of N concurrent callers succeeds and
 * the rest receive `EEXIST` and retry.
 *
 * Stale lock detection is mtime-based, and the holder refreshes its lock's
 * mtime every `heartbeatMs` while `fn` runs (issue #4502). A lock is therefore
 * stale only when its holder has not refreshed it for `staleTimeoutMs` — the
 * holder died or its process stalled — and it is removed before retrying.
 * `fn` must be bounded: a hung-but-alive holder keeps its lock, and waiters
 * time out with {@link FileLockTimeoutError} instead of reaping it.
 *
 * The release removes `lockPath` only if the file there is still the one this
 * call created: the device and inode of the call's open handle are compared
 * with a fresh `stat` BEFORE the handle is closed, because an open handle pins
 * its inode and a closed one lets the number be reused by a successor's lock.
 * A holder whose lock was reaped logs one warning and leaves whatever is at
 * `lockPath` in place. The heartbeat refreshes through the same handle, never
 * by path, so it can only touch this call's file. A dev/ino check needs no file
 * format and no extra I/O, and holds across the OmniBox PID-namespace jail
 * (which bind-mounts the same filesystem), where a PID record would not; every
 * lock path lives on local POSIX storage. A per-acquire token written into the
 * file is the alternative if a lock ever moves to a non-POSIX filesystem.
 *
 * On lock-acquisition timeout, throws {@link FileLockTimeoutError}.
 *
 * Pattern modeled after the inline lock implementation in
 * `cli/src/persistence.ts`'s `updateSettings` (issue #1100). Other in-codebase
 * locks (e.g. `SessionStore.withLock`) should eventually migrate to this
 * helper for consistency.
 */
export async function withFileLock<T>(
  opts: FileLockOptions,
  fn: () => Promise<T>
): Promise<T> {
  const retryIntervalMs = opts.retryIntervalMs ?? 100;
  const maxAttempts = opts.maxAttempts ?? 50;
  const staleTimeoutMs = opts.staleTimeoutMs ?? 10000;
  const { lockPath } = opts;

  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      fileHandle = await open(lockPath, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
        try {
          const stats = await stat(lockPath);
          if (Date.now() - stats.mtimeMs > staleTimeoutMs) {
            await unlink(lockPath).catch(() => {});
          }
        } catch {
          // Lock file may have been released between EEXIST and stat — fine,
          // next iteration will try to acquire it again.
        }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new FileLockTimeoutError(
      lockPath,
      maxAttempts,
      maxAttempts * retryIntervalMs
    );
  }
  const handle = fileHandle;

  // Capture this call's identity right after the create, while the fd is open.
  let mine: Stats;
  try {
    mine = await handle.stat();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw err;
  }

  const heartbeatMs =
    opts.heartbeatMs ?? Math.max(10, Math.floor(staleTimeoutMs / 3));
  let releasing = false;
  let heartbeatFailed = false;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          const now = new Date();
          handle.utimes(now, now).catch((err: unknown) => {
            // A silent failure would make the holder reapable again with no
            // signal, so the first one is reported; later ones add nothing.
            if (releasing || heartbeatFailed) return;
            heartbeatFailed = true;
            logger.warn(
              `[fileLock] heartbeat refresh of ${lockPath} failed ` +
                `(${err instanceof Error ? err.message : String(err)}); ` +
                `a holder that runs past staleTimeoutMs=${staleTimeoutMs} can be reaped`
            );
          });
        }, heartbeatMs)
      : undefined;
  heartbeat?.unref?.();

  try {
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    releasing = true;
    await releaseIfOwned(handle, mine, lockPath, staleTimeoutMs);
  }
}

/**
 * Remove `lockPath` only if it is still the file behind `handle`, then close
 * the handle. The compare runs before the close so the inode stays pinned.
 */
async function releaseIfOwned(
  handle: Awaited<ReturnType<typeof open>>,
  mine: Stats,
  lockPath: string,
  staleTimeoutMs: number
): Promise<void> {
  let current: Stats | null = null;
  let ownershipKnown = true;
  try {
    current = await stat(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      ownershipKnown = false;
      // Unknown ownership: leave the file — once the heartbeat stops, the
      // stale reaper recovers it if it was ours.
      logger.warn(
        `[fileLock] could not check ${lockPath} before releasing it ` +
          `(${err instanceof Error ? err.message : String(err)}); leaving it in place`
      );
    }
  }

  if (current && current.dev === mine.dev && current.ino === mine.ino) {
    await unlink(lockPath).catch(() => {});
  } else if (ownershipKnown) {
    logger.warn(
      `[fileLock] ${lockPath} was reaped while held ` +
        `(staleTimeoutMs=${staleTimeoutMs}); leaving ` +
        `${current ? "the successor's lock" : "no lock"} in place`
    );
  }
  await handle.close();
}
