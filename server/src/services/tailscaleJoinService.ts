// SPDX-License-Identifier: AGPL-3.0-only
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { hostname as osHostname, tmpdir } from "node:os";
import { join } from "node:path";
import { gatherTailscale } from "../metrics/aboutInfo";

/**
 * Joins this VM to the user's tailnet from inside the instance (#6211 R23). The
 * server already runs as the `hapimatic` user, which the curated sudoers rule lets
 * call the privileged broker, so this is the same broker verb the gateway's
 * `/setup` uses over SSH, with no broker or sudoers change.
 *
 * The auth key is a live credential. It goes only into a fresh 0600 file, because
 * the broker refuses anything but a regular file owned by the caller; it never
 * reaches argv, the child's env or a log, and the file is removed however the join
 * ends.
 */

export const TAILSCALE_BROKER_PATH = "/usr/local/sbin/hapi-privileged-op.sh";
const JOIN_TIMEOUT_MS = 60_000;
const KEY_DIR_PREFIX = "hapi-tailscale-";
/** A key dir's name after the prefix starts with the pid of the process that made it. */
const KEY_DIR_OWNER = /^(\d+)-/;
/** Older than any running join, which gives up on its file at JOIN_TIMEOUT_MS. */
const STALE_KEY_DIR_MS = 5 * 60_000;
/** The second sweep, once a dir left just before this start is past the age rule. */
const SECOND_SWEEP_MS = STALE_KEY_DIR_MS + 5_000;
/** Not a code the broker can exit with. */
const TIMED_OUT = -1;
/** The broker's own hostname rule. It re-validates; this avoids a pointless sudo. */
const DEVICE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The same rule as the gateway's `validateTailscaleKey`
 * (`gateway/src/routes/setupTailscale.ts`), which is a separate deployment.
 */
export function validateTailscaleKey(value: string): boolean {
  if (/\s/.test(value)) return false;
  if (value.length < 20 || value.length > 255) return false;
  return /^tskey-[A-Za-z0-9-]+$/.test(value);
}

export type TailscaleStatus = {
  state: "joined" | "not-joined" | "unavailable";
  /** The tailnet IPv4 and name, when joined. Never the tailnet owner's identity. */
  ip?: string;
  hostname?: string;
  /** Whether this install can run a join at all. */
  canJoin: boolean;
  /** The name a join would give this device. */
  deviceName: string;
};

export type TailscaleJoinResult =
  | { ok: true; status: TailscaleStatus }
  | {
      ok: false;
      code: "invalid_key" | "unavailable" | "busy" | "join_failed";
      error: string;
    };

export type TailscaleJoinServiceOptions = {
  /** Trusted config: the instance subdomain (`HAPI_GOOGLE_HANDOFF_AUD`), if any. */
  deviceName?: string | null;
  brokerPath?: string;
  sudoPath?: string;
  tailscaleOnPath?: () => boolean;
  readTailscale?: typeof gatherTailscale;
  timeoutMs?: number;
  tempRoot?: string;
  /** When the start-up sweep runs again (#6275 S14). */
  secondSweepMs?: number;
};

/** The device name: the instance subdomain, else this host's first label, lowercased. */
export function resolveDeviceName(configured?: string | null): string {
  const name = configured?.trim() || osHostname().split(".")[0] || "";
  return name.toLowerCase();
}

export class TailscaleJoinService {
  private readonly deviceName: string;
  private readonly brokerPath: string;
  private readonly sudoPath: string;
  private readonly tailscaleOnPath: () => boolean;
  private readonly readTailscale: typeof gatherTailscale;
  private readonly timeoutMs: number;
  private readonly tempRoot: string;
  private joining = false;

  constructor(opts: TailscaleJoinServiceOptions = {}) {
    this.deviceName = resolveDeviceName(opts.deviceName);
    this.brokerPath = opts.brokerPath ?? TAILSCALE_BROKER_PATH;
    this.sudoPath = opts.sudoPath ?? "sudo";
    this.tailscaleOnPath =
      opts.tailscaleOnPath ?? (() => Bun.which("tailscale") !== null);
    this.readTailscale = opts.readTailscale ?? gatherTailscale;
    this.timeoutMs = opts.timeoutMs ?? JOIN_TIMEOUT_MS;
    this.tempRoot = opts.tempRoot ?? tmpdir();
    removeStaleKeyDirs(this.tempRoot);
    // #6275 S14: a dir with no owner in its name (made before this rule) that was
    // left by the restart that started this process is past the age rule by then.
    const root = this.tempRoot;
    setTimeout(
      () => removeStaleKeyDirs(root),
      opts.secondSweepMs ?? SECOND_SWEEP_MS
    ).unref?.();
  }

  private canJoin(): boolean {
    return existsSync(this.brokerPath) && this.tailscaleOnPath();
  }

  async status(): Promise<TailscaleStatus> {
    const canJoin = this.canJoin();
    const info = await this.readTailscale();
    const base = { canJoin, deviceName: this.deviceName };
    if (info?.ipv4) {
      return {
        ...base,
        state: "joined",
        ip: info.ipv4,
        ...(info.hostname ? { hostname: info.hostname } : {}),
      };
    }
    return { ...base, state: canJoin ? "not-joined" : "unavailable" };
  }

  async join(authKey: string): Promise<TailscaleJoinResult> {
    if (!validateTailscaleKey(authKey)) {
      return {
        ok: false,
        code: "invalid_key",
        error: "That is not a Tailscale auth key (expected tskey-…).",
      };
    }
    if (!this.canJoin()) {
      return {
        ok: false,
        code: "unavailable",
        error: "Tailscale is not available on this install.",
      };
    }
    if (!DEVICE_NAME_PATTERN.test(this.deviceName)) {
      return {
        ok: false,
        code: "unavailable",
        error: `"${this.deviceName}" cannot be used as a Tailscale device name.`,
      };
    }
    if (this.joining) {
      return {
        ok: false,
        code: "busy",
        error: "A join is already running.",
      };
    }
    this.joining = true;
    let dir: string | null = null;
    try {
      // The pid in the name lets the next start remove it if this process dies first.
      dir = mkdtempSync(
        join(this.tempRoot, `${KEY_DIR_PREFIX}${process.pid}-`)
      );
      const keyFile = join(dir, "authkey");
      writeFileSync(keyFile, authKey, { mode: 0o600, flag: "wx" });
      const result = await this.runBroker(keyFile);
      if (result.code === TIMED_OUT) {
        // The kill may not reach a root-owned child, so this is not a clean failure.
        return {
          ok: false,
          code: "join_failed",
          error:
            "The join did not finish in time and may still complete. Reload this page in a minute before trying another key.",
        };
      }
      if (result.code !== 0) {
        return {
          ok: false,
          code: "join_failed",
          error: `Tailscale join failed: ${lastLine(result.stderr, authKey)}`,
        };
      }
      return { ok: true, status: await this.status() };
    } catch {
      // The error of a failed file write or spawn carries no key, but says little
      // a user could act on either.
      return {
        ok: false,
        code: "join_failed",
        error: "Tailscale join failed: could not run the join on this VM.",
      };
    } finally {
      this.joining = false;
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * The wait is this method's own, not the spawn's `timeout`: sudo runs as root, so
   * this user may not be able to signal it, and a helper left holding the stderr
   * pipe would keep the read open past any kill. Either would hold the request (and
   * the key file) for as long as the child lived.
   */
  private async runBroker(
    keyFile: string
  ): Promise<{ code: number; stderr: string }> {
    const proc = Bun.spawn(
      [
        this.sudoPath,
        "-n",
        this.brokerPath,
        "tailscale-up",
        this.deviceName,
        keyFile,
      ],
      {
        env: { PATH: process.env.PATH ?? "" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      }
    );
    const finished = Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stderr, code]) => ({ code, stderr }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ code: number; stderr: string }>(resolve => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Not ours to signal, or already gone.
        }
        resolve({ code: TIMED_OUT, stderr: "" });
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([finished, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A process that died during a join never reached the `finally`, which leaves a key
 * file behind. A dir goes when the process named in it is no longer running, so a
 * restart during a join (a fleet deploy is one) leaves no key past the next start
 * (#6275 S14); another instance on this host may be joining, so a live owner's dir
 * stays. Any dir older than a join can last goes too, which covers a reused pid and
 * a dir with no owner in its name.
 */
function removeStaleKeyDirs(root: string): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(KEY_DIR_PREFIX)) continue;
    const dir = join(root, name);
    try {
      const owner = KEY_DIR_OWNER.exec(name.slice(KEY_DIR_PREFIX.length));
      const ownerGone = owner !== null && !isRunning(Number(owner[1]));
      if (ownerGone || Date.now() - statSync(dir).mtimeMs > STALE_KEY_DIR_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Gone already, or another user's: nothing further to do with it.
    }
  }
}

/** Signal 0 tests for a process without touching it; EPERM is one that exists. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The failure line a user can act on (an invalid, expired or used key). tailscale
 * reads the key from a file, so it does not print it; the replace makes sure.
 */
function lastLine(stderr: string, authKey: string): string {
  const line = stderr.trim().split("\n").pop()?.trim() || "no detail";
  return line
    .split(authKey)
    .join("[key]")
    .replace(/tskey-[\w-]+/g, "[key]");
}
