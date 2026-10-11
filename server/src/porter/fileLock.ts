// SPDX-License-Identifier: AGPL-3.0-only
import { open, stat, unlink } from "node:fs/promises";

/**
 * Cross-process advisory file lock for the Configuration Porter import path
 * (issue #2343, epic #2339 Sub D).
 *
 * Ported verbatim from `cli/src/utils/fileLock.ts` (issue #1100). The directive
 * (Task 10 / F14) requires the same locked read-modify-write discipline the CLI
 * uses for `~/.claude.json`, but the server package cannot cross-package import
 * from `cli/`, and this primitive is pure `node:fs` (no browser constraint) so
 * it cannot live in the zod-only `@hapi/protocol` package either. Re-implemented
 * here so the server owns its own copy.
 *
 * Used by:
 *  - `mcpImport.ts` — the locked `~/.claude.json` `mcpServers` merge (Task 10)
 *    plus the per-account isolated `.claude.json` merges (F1);
 *  - `importArchive.ts` — the instance-wide import mutex on
 *    `<dataDir>/porter-import.lock` (F14).
 */

/**
 * Thrown by {@link withFileLock} when the lock could not be acquired within the
 * configured timeout. Distinct from generic IO errors so callers can surface a
 * contention-specific "another import/toggle is in progress — retry" message.
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
 * atomic across processes — exactly one of N concurrent callers succeeds and the
 * rest receive `EEXIST` and retry.
 *
 * Stale lock detection is mtime-based: if a lock file's mtime is older than
 * `staleTimeoutMs`, it's assumed abandoned (holder crashed mid-mutation) and
 * removed before retrying.
 *
 * On acquisition timeout, throws {@link FileLockTimeoutError}.
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
          // the next iteration retries acquisition.
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
