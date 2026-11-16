// SPDX-License-Identifier: AGPL-3.0-only
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The server instance lock (issue #6651, Task G; plan section 14). A server
 * process takes an exclusive lock that belongs to its database before it opens
 * that database or writes its settings, and holds it for its whole life, so two
 * server processes never write one database. The lock is a POSIX record lock that
 * SQLite takes on a small file of its own, `<database>.server.lock`, beside the
 * database: `BEGIN EXCLUSIVE`, never committed, on a connection kept open in this
 * module. A second process waits up to `waitMs`, then is refused.
 *
 * - There is no stale lock: the kernel releases a record lock when its process
 *   ends (exit, crash, `SIGKILL`, the OOM killer), so a refusal because the
 *   lock is busy always means a live process holds it. The holder file names
 *   that process once it has written the file. Until then it can still name an
 *   earlier holder that has ended, and if the write fails the earlier file is
 *   removed; only if that removal fails too can it name the ended holder for
 *   the whole life of the new one, and the new one then warns with its path.
 * - A record lock is never inherited across `fork`, so no child of the server
 *   (an `ext install` process, a tmux session) holds it.
 * - The lock file must never be deleted while a server runs: the lock is on the
 *   file's inode, so a process that finds the name missing would create a new
 *   file and lock that one beside the running holder.
 * - Closing ANY descriptor of the lock file releases the lock for the whole
 *   process, so nothing in the server may open the lock file again: this module
 *   opens it once and never closes it, and whoever asks who holds the lock reads
 *   the holder file `<lock>.holder`, never the lock file.
 *
 * `HAPI_SERVER_INSTANCE_LOCK=off` skips the lock (an emergency bypass); a node
 * that runs with it is outside every claim of the plan of #6651.
 */

export interface InstanceLockHolder {
  pid: number;
  startedAtMs: number;
  version: string;
}

export type InstanceLockResult =
  | { kind: "held"; path: string }
  | { kind: "memory" }
  | { kind: "off" }
  | {
      kind: "refused";
      path: string;
      holder: InstanceLockHolder | null;
      error: string | null;
    };

/** Every connection that holds a lock; kept referenced so none is ever closed. */
const heldConnections: Database[] = [];

/** `<the database's real path, or its resolved path if it does not exist yet>.server.lock`. */
export function instanceLockPath(dbPath: string): string {
  let real: string;
  try {
    real = realpathSync(dbPath);
  } catch {
    real = resolve(dbPath);
  }
  return `${real}.server.lock`;
}

/** The holder file's content, or null when it is absent or unreadable. */
export function readInstanceLockHolder(
  lockPath: string
): InstanceLockHolder | null {
  try {
    const parsed = JSON.parse(
      readFileSync(`${lockPath}.holder`, "utf8")
    ) as Partial<InstanceLockHolder>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAtMs === "number" &&
      typeof parsed.version === "string"
    ) {
      return {
        pid: parsed.pid,
        startedAtMs: parsed.startedAtMs,
        version: parsed.version,
      };
    }
  } catch {
    // absent or not JSON
  }
  return null;
}

function describeHolder(holder: InstanceLockHolder | null): string {
  return holder === null
    ? "an unknown process"
    : `pid ${holder.pid} since ${new Date(holder.startedAtMs).toISOString()} (version ${holder.version})`;
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}

export async function acquireServerInstanceLock(options: {
  dbPath: string;
  version: string;
  waitMs?: number;
  pollMs?: number;
  env?: Record<string, string | undefined>;
  /** Called once, with the waiting line, when the lock is first found held. */
  onWaiting?: (line: string) => void;
}): Promise<InstanceLockResult> {
  const { dbPath, version } = options;
  const waitMs = options.waitMs ?? 90_000;
  const pollMs = options.pollMs ?? 1_000;
  const env = options.env ?? process.env;

  // Nothing is shared in memory (the same test as the store's constructor).
  if (dbPath === ":memory:" || dbPath.startsWith("file::memory:")) {
    return { kind: "memory" };
  }
  if (env.HAPI_SERVER_INSTANCE_LOCK === "off") return { kind: "off" };

  const path = instanceLockPath(dbPath);
  let db: Database;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new Database(path, { create: true, readwrite: true });
  } catch (error) {
    return { kind: "refused", path, holder: null, error: String(error) };
  }

  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    try {
      // No wait inside SQLite: this loop is the wait. The file never holds data,
      // so its journal is kept in memory: no `-journal` file beside it, and none
      // left behind for the next holder to roll back after a crash. (`OFF` is
      // refused by Bun's SQLite.)
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA journal_mode = MEMORY");
      db.exec("BEGIN EXCLUSIVE");
      break;
    } catch (error) {
      if (!isBusy(error)) {
        db.close();
        return { kind: "refused", path, holder: null, error: String(error) };
      }
    }
    const holder = readInstanceLockHolder(path);
    if (Date.now() >= deadline) {
      // This connection holds no lock, so closing it releases nothing.
      db.close();
      return { kind: "refused", path, holder, error: null };
    }
    if (!announced) {
      announced = true;
      options.onWaiting?.(
        `[Server] waiting for the instance lock ${path}: held by ${describeHolder(holder)}`
      );
    }
    await Bun.sleep(Math.max(0, Math.min(pollMs, deadline - Date.now())));
  }
  heldConnections.push(db);

  // Who holds it, for a waiting process: written after the lock is taken, by
  // write-temp-and-rename, so a reader never sees half a file.
  const holder: InstanceLockHolder = {
    pid: process.pid,
    startedAtMs: Date.now(),
    version,
  };
  const temp = `${path}.holder.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(holder), { mode: 0o600 });
    renameSync(temp, `${path}.holder`);
  } catch (error) {
    // The lock is held, but the holder file was not written. An earlier
    // holder's file would still name a process that has ended (or, after pid
    // reuse, an unrelated one), so it is removed, with the temporary file: a
    // waiting or refused process then names "an unknown process".
    const left: string[] = [];
    for (const stale of [`${path}.holder`, temp]) {
      try {
        rmSync(stale, { force: true });
      } catch {
        left.push(stale);
      }
    }
    console.warn(
      left.length === 0
        ? `[Server] could not write ${path}.holder (any earlier one removed):`
        : `[Server] could not write ${path}.holder, and could not remove ${left.join(" or ")}; a waiting or refused process may name an earlier holder that has ended:`,
      error
    );
  }
  return { kind: "held", path };
}

/** The start line for a result other than `refused` (plan section 14). */
export function instanceLockLine(result: InstanceLockResult): string {
  switch (result.kind) {
    case "held":
      return `[Server] instance lock: held ${result.path} (pid ${process.pid})`;
    case "memory":
      return "[Server] instance lock: memory";
    case "off":
      return "[Server] instance lock: off (bypassed)";
    case "refused":
      return result.error === null
        ? `[Server] refused: another server process holds the instance lock ${result.path} (${
            result.holder === null
              ? "an unknown process"
              : `pid ${result.holder.pid}, since ${new Date(result.holder.startedAtMs).toISOString()}, version ${result.holder.version}`
          }); this process opened no database, wrote no settings, and exits with code 75`
        : `[Server] refused: the instance lock ${result.path} could not be taken (${result.error}); this process opened no database, wrote no settings, and exits with code 75`;
  }
}
