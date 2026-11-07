// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One scratch root per test run (issue #6158, D3).
 *
 * Server tests that need a scratch dir under `$HOME` (the porter's
 * `isSafeMachinePath` denies `/tmp`, and several tests expand `~/…`) create it
 * under `testScratchRoot()` = `~/.hapi-test-scratch/<pid>-<start>/` instead of
 * directly in `$HOME`. Three leak mechanisms used to strand those dirs in
 * `$HOME`: a describe-body `mkdtempSync` with `afterAll` cleanup under
 * `bun test -t` (the hook never runs), a killed run, and a test's `chmod 000`
 * folder that makes `rmSync` throw. The preload (`scratchSweep.ts`) removes any
 * run dir whose process is gone before the tests, and this process's own run
 * dir in a global `afterAll` — making unreadable folders writable first.
 *
 * Measured on bun 1.4.4: `bun test` never fires `process` "exit"/"beforeExit"
 * listeners, while a preload's `afterAll` runs after every file under
 * `--isolate` (once at the end without it), even when `-t` matched nothing.
 * `--isolate` also gives each file a fresh `process.env`, so the run dir is
 * found on disk: the first `<pid>-*` entry for this pid, else a new one.
 */
import { lstatSync, mkdirSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TEST_SCRATCH_DIRNAME = ".hapi-test-scratch";
/** A live process's run dir untouched this long belongs to a reused pid. */
export const STALE_RUN_DIR_MS = 24 * 60 * 60 * 1000;

const RUN_DIR_NAME = /^(\d+)-[0-9a-z]+$/;

export function testScratchBase(): string {
  return join(homedir(), TEST_SCRATCH_DIRNAME);
}

/** This process's existing run dir under `base`, or null. */
function findOwnRunDir(base: string): string | null {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return null;
  }
  const prefix = `${process.pid}-`;
  const own = names
    .filter(n => n.startsWith(prefix) && RUN_DIR_NAME.test(n))
    .sort();
  return own.length > 0 ? join(base, own[0]) : null;
}

/**
 * This run's scratch root, created (mode 0700) on first use. Callers pass it to
 * `mkdtempSync(join(testScratchRoot(), ".prefix-"))`.
 */
export function testScratchRoot(): string {
  const base = testScratchBase();
  const dir =
    findOwnRunDir(base) ??
    join(base, `${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Remove this process's run dir, if any (the preload's global `afterAll`). */
export function removeOwnRunDir(base: string = testScratchBase()): void {
  const dir = findOwnRunDir(base);
  if (dir) removeScratchTree(dir);
}

/** Make every directory under `path` owner-writable without following symlinks. */
function makeTreeWritable(path: string): void {
  if (process.platform !== "win32") {
    // GNU chmod -R does not follow symlinks below the top; it fixes a 000
    // folder before descending into it.
    Bun.spawnSync(["chmod", "-R", "u+rwx", path], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  const walk = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    try {
      chmodSync(p, st.mode | 0o700);
    } catch {
      // best effort
    }
    if (!st.isDirectory()) return;
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const name of names) walk(join(p, name));
  };
  walk(path);
}

/** Remove a scratch tree, including folders a test left unreadable. Never throws. */
export function removeScratchTree(path: string): void {
  try {
    makeTreeWritable(path);
  } catch {
    // fall through to the removal attempt
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // EBUSY from a child still holding a handle: the next sweep retries
  }
}

function pidAlive(pid: number): boolean {
  if (pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SweepOptions {
  base?: string;
  now?: number;
  isAlive?: (pid: number) => boolean;
}

/**
 * Remove run dirs left by a run that is no longer alive (or a reused pid whose
 * dir is older than `STALE_RUN_DIR_MS`). Only `<pid>-<base36>` names are
 * touched, never a dir of this process's pid. Returns the removed paths.
 */
export function sweepStaleTestScratch(options: SweepOptions = {}): string[] {
  const base = options.base ?? testScratchBase();
  const now = options.now ?? Date.now();
  const isAlive = options.isAlive ?? pidAlive;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = RUN_DIR_NAME.exec(name);
    if (!match) continue;
    const dir = join(base, name);
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    let stale = !isAlive(pid);
    if (!stale) {
      try {
        stale = now - lstatSync(dir).mtimeMs > STALE_RUN_DIR_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      removeScratchTree(dir);
      removed.push(dir);
    }
  }
  return removed;
}
