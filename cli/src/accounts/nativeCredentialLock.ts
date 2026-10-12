// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Native Claude Code's credential locks, taken from Hapimatic (issue #5020).
 *
 * Every Hapimatic writer of an account's isolated `.credentials.json` must join
 * the lock protocol native Claude Code already uses on that dir, because native
 * is a writer too: it refreshes the account's token in-session and saves the
 * rotated pair back to the same file. Hapimatic's own `.rotate.lock` and
 * `.recovery.lock` (`machineRotator.ts`) are invisible to native, so before
 * #5020 a Hapimatic rotation and a native refresh could present the same refresh
 * token at the same moment, and a Hapimatic rename could be lost under native's
 * read-modify-write.
 *
 * Native's protocol, read from the installed binary (Claude Code 2.1.287; the
 * #5020 research read the same paths in 2.1.280):
 *  - refresh lock — proper-lockfile on `<dir>/.oauth_refresh.lock`
 *    (`realpath:false`, stale 60 s, mtime update every 5 s), then the legacy
 *    lock `<realpath(dir)>.lock` with the same options. If the legacy lock is
 *    busy, native releases the primary one and retries. Native retries a busy
 *    refresh lock 5 times (1-2 s jitter) and then takes it over only when its
 *    owner record (`.oauth_refresh.lock.owner`) names a dead pid; a lock with no
 *    owner record makes native give up instead.
 *  - storage-write lock — proper-lockfile on `<dir>/.storage-write`, i.e. the
 *    directory `<dir>/.storage-write.lock` (`realpath:false`, stale 15 s,
 *    10 retries of 100-1000 ms). Native's compare-and-swap save runs under it.
 *
 * proper-lockfile's lock is a DIRECTORY created with `mkdir` (atomic: exactly
 * one creator wins, the rest get `EEXIST`); a lock whose mtime is older than
 * `stale` is presumed abandoned and removed with `rmdir`. This module speaks
 * that format without the dependency. It writes no owner record, so native
 * never takes over a lock Hapimatic holds — it waits for the holder or gives up.
 *
 * Lock order (machine-global, per account; never taken in another order):
 *   `.recovery.lock` → `.rotate.lock` → `.oauth_refresh.lock` (+ legacy)
 *   → `.storage-write.lock` → the account store's own file lock.
 * Native takes `.oauth_refresh.lock` before `.storage-write.lock` too. None of
 * these locks is re-entrant: a holder must not take one it already holds.
 */

import { mkdir, realpath, rmdir, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { FileLockTimeoutError } from "@/utils/fileLock";
import { logger } from "@/ui/logger";

/** Native's refresh lock, inside the account's config dir. */
export const NATIVE_REFRESH_LOCK_NAME = ".oauth_refresh.lock";
/** Native's storage-write lock, inside the account's config dir. */
export const NATIVE_STORAGE_WRITE_LOCK_NAME = ".storage-write.lock";

/** Timing budgets for one native-format lock. All values in ms. */
export interface NativeLockBudgets {
  /** A lock whose mtime is older than this is presumed abandoned and reaped. */
  staleMs: number;
  /** How often the holder refreshes the lock's mtime. */
  heartbeatMs: number;
  /** How long a waiter tries to acquire before giving up. */
  waitMs: number;
  /** Retry delay bounds (uniform jitter between them). */
  minRetryMs: number;
  maxRetryMs: number;
}

/**
 * The refresh lock: native's stale and update values. The 30 s wait covers one
 * native refresh (one OAuth round trip plus its save) with room to spare.
 */
export const NATIVE_REFRESH_LOCK_BUDGETS: NativeLockBudgets = {
  staleMs: 60_000,
  heartbeatMs: 5_000,
  waitMs: 30_000,
  minRetryMs: 1_000,
  maxRetryMs: 2_000,
};

/** The storage-write lock: native's stale value and retry bounds. */
export const NATIVE_STORAGE_WRITE_LOCK_BUDGETS: NativeLockBudgets = {
  staleMs: 15_000,
  heartbeatMs: 5_000,
  waitMs: 10_000,
  minRetryMs: 100,
  maxRetryMs: 1_000,
};

/** Budgets for both locks (a test seam; production uses the constants above). */
export interface NativeLockBudgetSet {
  refresh: NativeLockBudgets;
  storageWrite: NativeLockBudgets;
}

export const NATIVE_LOCK_BUDGETS: NativeLockBudgetSet = {
  refresh: NATIVE_REFRESH_LOCK_BUDGETS,
  storageWrite: NATIVE_STORAGE_WRITE_LOCK_BUDGETS,
};

/** mtimes this close to the one we last wrote still belong to our lock. */
const OWN_MTIME_TOLERANCE_MS = 1_000;

function jitter(b: NativeLockBudgets): number {
  return b.minRetryMs + Math.random() * (b.maxRetryMs - b.minRetryMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/** A held native-format lock. */
interface HeldDirLock {
  release: () => Promise<void>;
}

/**
 * One attempt to take the lock directory `lockPath`. Returns the held lock, or
 * `null` when another process holds a live lock. A lock older than
 * `budgets.staleMs` is reaped and the attempt repeated once.
 */
async function tryAcquireDirLock(
  lockPath: string,
  budgets: NativeLockBudgets
): Promise<HeldDirLock | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 0700 like the credentials dir it guards (native's mode is umask-default).
      await mkdir(lockPath, { mode: 0o700 });
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(lockPath)).mtimeMs;
      } catch (statErr) {
        if (errCode(statErr) === "ENOENT") continue; // released meanwhile
        throw statErr;
      }
      if (Date.now() - mtimeMs <= budgets.staleMs) return null;
      // Abandoned (its holder stopped refreshing the mtime): reap and retry.
      await rmdir(lockPath).catch(rmErr => {
        if (errCode(rmErr) !== "ENOENT") throw rmErr;
      });
      logger.warn(
        `[NATIVE_LOCK] reaped a stale lock at ${lockPath} (mtime ${Math.round((Date.now() - mtimeMs) / 1000)} s old)`
      );
      continue;
    }
    return holdDirLock(lockPath, budgets);
  }
  return null;
}

/** Start the mtime heartbeat on a lock directory we just created. */
async function holdDirLock(
  lockPath: string,
  budgets: NativeLockBudgets
): Promise<HeldDirLock> {
  let lastSetMs = Date.now();
  await utimes(lockPath, new Date(lastSetMs), new Date(lastSetMs)).catch(
    () => {}
  );
  const heartbeat = setInterval(() => {
    const t = Date.now();
    utimes(lockPath, new Date(t), new Date(t)).then(
      () => {
        lastSetMs = t;
      },
      () => {}
    );
  }, budgets.heartbeatMs);
  heartbeat.unref?.();
  return {
    release: async () => {
      clearInterval(heartbeat);
      // Remove the lock only while it is still ours: if our heartbeat stalled
      // past the stale timeout, another process may have reaped it and taken
      // its own lock at the same path.
      try {
        const { mtimeMs } = await stat(lockPath);
        if (Math.abs(mtimeMs - lastSetMs) > OWN_MTIME_TOLERANCE_MS) {
          logger.warn(
            `[NATIVE_LOCK] not removing ${lockPath}: its mtime is not ours (the lock was reaped and re-taken while held)`
          );
          return;
        }
        await rmdir(lockPath);
      } catch (err) {
        if (errCode(err) !== "ENOENT") {
          logger.warn(
            `[NATIVE_LOCK] release of ${lockPath} failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    },
  };
}

/**
 * Take the lock directory `lockPath`, waiting up to `budgets.waitMs`. Throws
 * {@link FileLockTimeoutError} when the wait runs out.
 */
async function acquireDirLock(
  lockPath: string,
  budgets: NativeLockBudgets
): Promise<HeldDirLock> {
  const deadline = Date.now() + budgets.waitMs;
  let attempts = 0;
  for (;;) {
    attempts++;
    const held = await tryAcquireDirLock(lockPath, budgets);
    if (held) return held;
    if (Date.now() >= deadline) {
      throw new FileLockTimeoutError(lockPath, attempts, budgets.waitMs);
    }
    await sleep(Math.min(jitter(budgets), Math.max(0, deadline - Date.now())));
  }
}

/** Native's legacy refresh-lock path: `<realpath(dir)>.lock`. */
export async function legacyRefreshLockPath(dir: string): Promise<string> {
  return `${await realpath(dir).catch(() => dir)}.lock`;
}

/**
 * Run `fn` while holding native's refresh lock for the config dir `dir` (the
 * primary `<dir>/.oauth_refresh.lock` and the legacy `<realpath(dir)>.lock`),
 * so neither a native refresh nor another Hapimatic writer can present or
 * replace the account's refresh token meanwhile. Mirrors native's acquisition:
 * primary first; a busy legacy lock releases the primary and retries (never
 * hold one while waiting on the other); a legacy lock that cannot be created
 * for any other reason is skipped, as native does. Throws
 * {@link FileLockTimeoutError} when both cannot be held within the wait budget.
 */
export async function withNativeRefreshLock<T>(
  dir: string,
  fn: () => Promise<T>,
  budgets: NativeLockBudgets = NATIVE_REFRESH_LOCK_BUDGETS
): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const primaryPath = join(dir, NATIVE_REFRESH_LOCK_NAME);
  const legacyPath = await legacyRefreshLockPath(dir);
  const deadline = Date.now() + budgets.waitMs;
  let attempts = 0;
  for (;;) {
    attempts++;
    const remaining = Math.max(0, deadline - Date.now());
    const primary = await acquireDirLock(primaryPath, {
      ...budgets,
      waitMs: remaining,
    });
    let legacy: HeldDirLock | null = null;
    let legacyBusy = false;
    try {
      legacy = await tryAcquireDirLock(legacyPath, budgets);
      legacyBusy = legacy === null;
    } catch (err) {
      logger.warn(
        `[NATIVE_LOCK] legacy refresh lock ${legacyPath} unavailable; continuing with the primary lock only: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (legacyBusy) {
      await primary.release();
      if (Date.now() >= deadline) {
        throw new FileLockTimeoutError(legacyPath, attempts, budgets.waitMs);
      }
      await sleep(
        Math.min(jitter(budgets), Math.max(0, deadline - Date.now()))
      );
      continue;
    }
    try {
      return await fn();
    } finally {
      if (legacy) await legacy.release();
      await primary.release();
    }
  }
}

/**
 * Run `fn` while holding native's storage-write lock for the config dir `dir`
 * (`<dir>/.storage-write.lock`): native's read-modify-write save and a
 * Hapimatic write of `.credentials.json` never interleave. Throws
 * {@link FileLockTimeoutError} when the lock cannot be taken in time.
 */
export async function withNativeStorageWriteLock<T>(
  dir: string,
  fn: () => Promise<T>,
  budgets: NativeLockBudgets = NATIVE_STORAGE_WRITE_LOCK_BUDGETS
): Promise<T> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const held = await acquireDirLock(
    join(dir, NATIVE_STORAGE_WRITE_LOCK_NAME),
    budgets
  );
  try {
    return await fn();
  } finally {
    await held.release();
  }
}
