// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cross-instance fleet lock (issue #2468, R7).
 *
 * On RP1 both prod (:3008) and dev (:3009) are separate PROCESSES sharing one
 * OCI tenancy, DNS zone, and fleet inventory. Exactly one MUTATING provisioning
 * job may run fleet-wide at a time; read-only jobs (health-check, dry-runs) are
 * exempt and never touch this lock. An in-process mutex therefore cannot express
 * the invariant — the lock is a FILE.
 *
 * ## Why not reuse `server/src/porter/fileLock.ts`
 *
 * That primitive reaps a lock whose mtime is older than ~10 s. A provision runs
 * for many minutes and its lock's mtime never refreshes, so mtime-staleness
 * would reap a LIVE lock and let a second concurrent OCI mutation run. Here
 * staleness is keyed on the holder's DETACHED unit + persisted record, both
 * observable cross-instance through the shared `systemd --user` manager:
 *
 *     stale  ⇔  the holder's unit is inactive  AND  its job record is terminal
 *
 * A still-running unit is NEVER stale regardless of wall-clock age. The lock
 * survives a server restart; `reattach()` (jobRunner) re-adopts a still-running
 * mutating job's lock via {@link FleetLock.adopt}.
 *
 * The acquisition primitive itself is the same atomic `open(path, "wx")`
 * (`O_CREAT | O_EXCL`) the porter lock uses — only the staleness policy differs.
 */

import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The repo's provisioning state dir (provision.sh already uses this path). */
export const DEFAULT_FLEET_LOCK_PATH = join(
  homedir(),
  ".local/state/hapimatic-provision/vm-provision.lock"
);

/**
 * A present-but-unparseable lock file (an empty/torn write from a process
 * killed between the O_EXCL create and the holder write) older than this is a
 * dead torn write and is reaped. A legitimate holder write completes in
 * microseconds, so this window never reaps an in-flight write — and it applies
 * ONLY to the malformed case; a VALID holder is never mtime-reaped (that is the
 * whole reason this lock does not reuse porter/fileLock's mtime staleness).
 * (security review 2026-08-01)
 */
const MALFORMED_LOCK_GRACE_MS = 5_000;

/**
 * Lock holder metadata. Deliberately NOT a pid: the mutating job is a detached
 * unit that OUTLIVES the acquiring server process, so pid-liveness is
 * meaningless — unit-liveness is the truth source.
 */
export interface LockHolder {
  /** Which instance acquired it (e.g. `prod:3008`, `dev:3009`, `wt:3013`). */
  instance: string;
  jobId: string;
  unitName: string;
  acquiredAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** Present when not acquired — a clear "held by <holder>" reason. */
  reason?: string;
  /** The current holder (self on success; the blocker on failure). */
  holder?: LockHolder;
}

export interface FleetLockStatus {
  held: boolean;
  holder?: LockHolder;
}

export interface FleetLockDeps {
  lockPath?: string;
  /**
   * Probe: is the holder's transient unit active? Injected by the runner
   * (`systemctl --user is-active <unit>` — works cross-instance, same user
   * manager). Default: `false` (no probe → treat as inactive).
   */
  isUnitActive?: (unitName: string) => boolean | Promise<boolean>;
  /**
   * Probe: is the holder's job record terminal? Injected by the runner (store
   * lookup). Default: `false`. With both defaults, `isStale` is always false —
   * a lock is never auto-reaped without real probes (fail-safe).
   */
  isJobTerminal?: (jobId: string) => boolean | Promise<boolean>;
  /** Clock (default `Date.now`) — injectable for the malformed-file grace test. */
  now?: () => number;
}

/** Thrown by {@link FleetLock.withFleetLock} when the lock is already held. */
export class FleetLockHeldError extends Error {
  readonly holder?: LockHolder;
  constructor(reason: string, holder?: LockHolder) {
    super(reason);
    this.name = "FleetLockHeldError";
    this.holder = holder;
  }
}

export class FleetLock {
  private readonly lockPath: string;
  private readonly isUnitActive: (u: string) => boolean | Promise<boolean>;
  private readonly isJobTerminal: (j: string) => boolean | Promise<boolean>;
  private readonly now: () => number;

  constructor(deps: FleetLockDeps = {}) {
    this.lockPath = deps.lockPath ?? DEFAULT_FLEET_LOCK_PATH;
    this.isUnitActive = deps.isUnitActive ?? (() => false);
    this.isJobTerminal = deps.isJobTerminal ?? (() => false);
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Read the lock file into a discriminated state. `absent` (ENOENT) and
   * `malformed` (present but empty/unparseable — a torn write, or a transient
   * read error) are kept DISTINCT from a `valid` holder so callers neither
   * steal a valid lock nor block forever on a dead torn write.
   */
  private async readLockFile(): Promise<
    | { state: "absent" }
    | { state: "malformed"; ageMs: number }
    | { state: "valid"; holder: LockHolder }
  > {
    let raw: string;
    try {
      raw = await readFile(this.lockPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { state: "absent" };
      }
      // A transient read error is NOT "absent" — treat as malformed with age 0
      // (within grace) so it is never reaped or deleted as if empty.
      return { state: "malformed", ageMs: 0 };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LockHolder>;
      if (
        parsed &&
        typeof parsed.jobId === "string" &&
        typeof parsed.unitName === "string" &&
        typeof parsed.instance === "string"
      ) {
        return { state: "valid", holder: parsed as LockHolder };
      }
    } catch {
      // fall through to malformed
    }
    let ageMs = 0;
    try {
      ageMs = this.now() - (await stat(this.lockPath)).mtimeMs;
    } catch {
      ageMs = 0; // stat raced with a delete → treat as fresh (do not reap)
    }
    return { state: "malformed", ageMs };
  }

  private async readHolder(): Promise<LockHolder | null> {
    const lf = await this.readLockFile();
    return lf.state === "valid" ? lf.holder : null;
  }

  /**
   * A lock is stale ONLY when the holder's unit is inactive AND its job record
   * is terminal — i.e. the holder finished but never released (e.g. server
   * crashed between finalize and release). A live unit is never stale.
   */
  private async isStale(holder: LockHolder): Promise<boolean> {
    if (await this.isUnitActive(holder.unitName)) return false;
    return await this.isJobTerminal(holder.jobId);
  }

  /**
   * Attempt to acquire the lock for `holder`. Reaps a stale holder once, then
   * returns `{acquired:false, reason}` if a live holder blocks — never blocks
   * or spins.
   */
  async tryAcquire(holder: LockHolder): Promise<AcquireResult> {
    await mkdir(dirname(this.lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(this.lockPath, "wx");
        try {
          await fh.writeFile(JSON.stringify(holder));
        } finally {
          await fh.close();
        }
        return { acquired: true, holder };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        const lf = await this.readLockFile();
        if (lf.state === "absent") {
          continue; // file vanished between our O_EXCL and our read — retry
        }
        if (lf.state === "valid" && (await this.isStale(lf.holder))) {
          await unlink(this.lockPath).catch(() => {});
          continue; // reaped a dead holder — retry acquisition once
        }
        if (lf.state === "malformed" && lf.ageMs > MALFORMED_LOCK_GRACE_MS) {
          // A torn/empty lock file left by a crashed acquirer — reap it so the
          // fleet is not wedged forever (a null holder is never "stale").
          await unlink(this.lockPath).catch(() => {});
          continue;
        }
        return {
          acquired: false,
          reason:
            lf.state === "valid"
              ? `fleet lock held by ${lf.holder.instance}/${lf.holder.jobId} (unit ${lf.holder.unitName})`
              : "fleet lock held (holder metadata unreadable)",
          holder: lf.state === "valid" ? lf.holder : undefined,
        };
      }
    }

    // Reaped a stale holder but lost the re-acquire race to another instance.
    const existing = await this.readHolder();
    return {
      acquired: false,
      reason: existing
        ? `fleet lock held by ${existing.instance}/${existing.jobId}`
        : "fleet lock contended",
      holder: existing ?? undefined,
    };
  }

  /**
   * Release the lock IFF this job POSITIVELY owns it. A transient read error or
   * a malformed file is left untouched — we never delete a possibly-valid lock
   * on an ambiguous read (security review 2026-08-01). If this job's own release
   * fails to run, the lock self-heals: the holder is terminal + its unit
   * inactive, so the next acquirer reaps it as stale.
   *
   * KNOWN RESIDUAL RACE (documented, not fixed — security review 2026-08-01):
   * between the read here and the unlink, a concurrent instance could reap this
   * now-terminal holder and acquire a successor; this unlink would then delete
   * the successor's lock, permitting two concurrent mutating jobs. The window is
   * microseconds and needs cross-instance contention at the exact release
   * instant. A fully-correct fix needs a per-acquisition nonce + atomic
   * compare-and-delete (e.g. renameat2 RENAME_EXCHANGE); deferred beyond Sub-A,
   * tracked for #2470 when live submissions are wired.
   */
  async release(jobId: string): Promise<void> {
    const lf = await this.readLockFile();
    if (lf.state === "valid" && lf.holder.jobId === jobId) {
      await unlink(this.lockPath).catch(() => {});
    }
  }

  /**
   * Non-acquiring read for #2469's preflight. Reports whether a lock file with a
   * parseable holder exists — it never creates, reaps, or mutates the lock.
   */
  async status(): Promise<FleetLockStatus> {
    const holder = await this.readHolder();
    return holder ? { held: true, holder } : { held: false };
  }

  /**
   * Re-adopt ownership of a still-running mutating job's lock after a server
   * restart (called by `reattach()` once it has confirmed the unit is active).
   * Idempotent: creates the lock file if it was lost, refreshes it if it already
   * names this job, and REFUSES to steal a lock held by a different job.
   */
  async adopt(holder: LockHolder): Promise<boolean> {
    const existing = await this.readHolder();
    if (existing && existing.jobId !== holder.jobId) return false; // conflict — do not steal
    await mkdir(dirname(this.lockPath), { recursive: true });
    await writeFile(this.lockPath, JSON.stringify(holder));
    return true;
  }

  /**
   * Acquire, run `fn`, release. Throws {@link FleetLockHeldError} if the lock is
   * already held (the mutating-serialization guarantee).
   */
  async withFleetLock<T>(holder: LockHolder, fn: () => Promise<T>): Promise<T> {
    const res = await this.tryAcquire(holder);
    if (!res.acquired) {
      throw new FleetLockHeldError(
        res.reason ?? "fleet lock unavailable",
        res.holder
      );
    }
    try {
      return await fn();
    } finally {
      await this.release(holder.jobId);
    }
  }
}
