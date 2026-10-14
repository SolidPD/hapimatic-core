// SPDX-License-Identifier: AGPL-3.0-only
import { open, stat, unlink } from "node:fs/promises";

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
}

/**
 * Acquire an exclusive cross-process lock on `lockPath`, run `fn`, then release
 * the lock. Uses Node's `wx` open flag (POSIX `O_CREAT | O_EXCL`) which is
 * atomic across processes — exactly one of N concurrent callers succeeds and
 * the rest receive `EEXIST` and retry.
 *
 * Stale lock detection is mtime-based: if a lock file's mtime is older than
 * `staleTimeoutMs`, it's assumed to be abandoned (process crashed
 * mid-mutation) and removed before retrying. This handles the case where the
 * lock holder dies without releasing.
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

  try {
    return await fn();
  } finally {
    await fileHandle.close();
    await unlink(lockPath).catch(() => {});
  }
}
