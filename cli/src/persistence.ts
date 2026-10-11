// SPDX-License-Identifier: MIT
/**
 * Minimal persistence functions for HAPI CLI
 *
 * Handles settings, encryption key, and daemon state storage in ~/.hapi/ (or HAPI_HOME override)
 */

import { FileHandle } from "node:fs/promises";
import {
  readFile,
  writeFile,
  mkdir,
  open,
  unlink,
  rename,
  stat,
  chmod,
} from "node:fs/promises";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  chmodSync,
  renameSync,
  statSync,
} from "node:fs";
import { configuration } from "@/configuration";
import { isProcessAlive } from "@/utils/process";
import type { AmbientOnboardingTokenState } from "@hapi/protocol/accounts";
import type { ClaudeRemoteLauncherKind } from "@hapi/protocol/launcherResolver";
import type { StoredApiKey } from "@hapi/protocol/schemas";

interface Settings {
  // This ID is used as the actual database ID on the server
  // All machine operations use this ID
  machineId?: string;
  machineIdConfirmedByServer?: boolean;
  daemonAutoStartWhenRunningHappy?: boolean;
  cliApiToken?: string;
  /** Issue #1733: OpenRouter API key for gateway-routed Codex sessions.
   *  Node-local, never transmitted from the web client; redacted in `hapi
   *  doctor` (R10); settings.json is now written 0600 since it holds a
   *  provider secret (R9). */
  openRouterApiKey?: string;
  /** Issue #3458: node-local hardware-toolchain capability override. `add`
   *  advertises a `tool:<name>` tag for an allowlisted tool that is NOT on the
   *  service PATH (e.g. the `kipy` Python venv client, or `freecad`/`renode` under
   *  a restricted systemd unit PATH); `suppress` hides one that IS on PATH. Only
   *  names in @hapi/protocol's TOOL_CAPABILITY_ALLOWLIST take effect — any other
   *  name is ignored (allowlist-only vocabulary). Node-local, never transmitted
   *  from the web client. Cached with the capability set — restart the daemon (and
   *  the server) to re-detect after editing. */
  toolCapabilities?: { add?: string[]; suppress?: string[] };
  /** Issue #1955: node-local provider API keys (the secrets-vault store). The
   *  server's API Keys page (B2) reads/writes this via createApiKeysRoutes; the
   *  daemon reads it node-side at spawn. A `provider:"openrouter"` entry is kept
   *  in sync with `openRouterApiKey` above (write-through) so #1733's Codex
   *  gateway works end-to-end. Round-trips with the server's Settings interface. */
  apiKeys?: StoredApiKey[];
  // Persisted from HAPI_TMUX_PERSISTENCE env var so manual daemon starts inherit the setting
  tmuxPersistenceEnabled?: boolean;
  // Persistent launcher choice — overrides default, overridden by HAPI_CLAUDE_LAUNCHER env var.
  // See claudedocs/pty-launcher-runbook.md for context.
  launcher?: ClaudeRemoteLauncherKind;
  // #1805: user-settable spawn-concurrency cap. The daemon READS this at the
  // spawn gate (clamped to [1, ceiling]); the SERVER is the sole writer
  // (KD-2 — sidesteps the CLI-locked vs server-unlocked settings.json race).
  maxConcurrentSessions?: number;
  /** Issue #3122: absolute path to the HAL canonical-content checkout (the
   *  rp1-home companion epic #1687 tree that owns `.claude/skills/<name>/
   *  envelope.yaml` + the sibling canonical SKILL.md). The skill-projection
   *  compiler reads SHA-pinned envelopes + skill bodies from here at spawn time
   *  (filesystem reads only — NO network on the spawn hot path, KD4). Unset →
   *  projection degrades to an annotated "unavailable" provenance and the spawn
   *  proceeds without projection (never a hard failure, Task 5 failure policy). */
  halCanonicalCheckoutPath?: string;
}

/**
 * Issue #4155: how `hapi doctor` may display each settings key. `public` prints
 * verbatim; `secret` prints "<redacted>". This is an ALLOWLIST: a key in
 * settings.json that this binary does not declare (the server also writes the
 * file — `federation`, `vapidKeys`, `porterAgeKeys`, `accessToken`, …) is hidden
 * by default. `satisfies` makes an unclassified new `Settings` field a type error.
 */
export const SETTINGS_DISPLAY = {
  machineId: "public",
  machineIdConfirmedByServer: "public",
  daemonAutoStartWhenRunningHappy: "public",
  cliApiToken: "secret",
  openRouterApiKey: "secret",
  toolCapabilities: "public",
  apiKeys: "secret",
  tmuxPersistenceEnabled: "public",
  launcher: "public",
  maxConcurrentSessions: "public",
  halCanonicalCheckoutPath: "public",
} as const satisfies Record<keyof Settings, "public" | "secret">;

const defaultSettings: Settings = {};

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  /** Daemon control-server bearer token (issue #1738). Local-only — never sent
   * to the server/federation. The same-machine control client reads it here.
   * Secret — redacted in `hapi doctor` (#4155). */
  controlToken: string;
  startTime: string;
  startedWithCliVersion: string;
  startedWithCliMtimeMs?: number;
  lastHeartbeat?: string;
  daemonLogPath?: string;
  /** Issue #3731 (F2): the tmux socket/session name this daemon spawns sessions on
   *  (its `HAPI_TMUX_SESSION_NAME`, set in its unit; `hapimatic` when unset), so
   *  `hapi doctor` probes the daemon's real socket instead of the operator shell's
   *  default. */
  tmuxSessionName?: string;
  /** Issue #3731 (F1): the daemon's LIVE disposition of the onboarding
   *  `CLAUDE_CODE_OAUTH_TOKEN`, written when it changes (the boot write carries the
   *  initial `pending` / `absent` — #4153 A3). `/proc/<pid>/environ` is the launch
   *  snapshot and cannot show a runtime release, so this is the record
   *  `hapi doctor` reads. */
  ambientOnboardingToken?: AmbientOnboardingTokenState;
  /** Issue #4153 (A1): the ABSOLUTE path of this daemon's tmux socket, computed at
   *  boot the way tmux does (`realpath(${TMUX_TMPDIR:-/tmp})/tmux-<uid>/<name>`).
   *  `hapi doctor` probes exactly this path (`tmux -S`): the socket NAME alone
   *  resolves to a different directory under another uid or `TMUX_TMPDIR`. */
  tmuxSocketPath?: string;
  /** Issue #4153 (A2): the daemon's isolated account-configs directory, so
   *  `hapi doctor` counts the daemon's accounts rather than its own. */
  accountConfigsDir?: string;
  /** Issue #4153 (A5): epoch ms the record entered `pending` (set at boot, left in
   *  place by the later `released` / `retained` writes). */
  pendingSince?: number;
  /** Issue #4153 (A5): epoch ms of daemon start (`startTime` is a locale string). */
  startedAt?: number;
  /** Issue #4153 (A5): epoch ms of the last heartbeat (`lastHeartbeat` is a
   *  locale string). */
  lastHeartbeatAt?: number;
}

/**
 * Issue #4155: how `hapi doctor` / `hapi daemon status` may display each daemon
 * state field (same allowlist contract as {@link SETTINGS_DISPLAY}). A key read
 * from disk that is not listed here — e.g. a newer daemon's field — is hidden.
 * `ambientOnboardingToken` is `public`: its VALUE is the disposition enum below,
 * not a token.
 */
export const DAEMON_STATE_DISPLAY = {
  pid: "public",
  httpPort: "public",
  controlToken: "secret",
  startTime: "public",
  startedWithCliVersion: "public",
  startedWithCliMtimeMs: "public",
  lastHeartbeat: "public",
  daemonLogPath: "public",
  tmuxSessionName: "public",
  ambientOnboardingToken: "public",
  // #4153: a socket path, a directory and three epoch timestamps — no secret.
  tmuxSocketPath: "public",
  accountConfigsDir: "public",
  pendingSince: "public",
  startedAt: "public",
  lastHeartbeatAt: "public",
} as const satisfies Record<
  keyof DaemonLocallyPersistedState,
  "public" | "secret"
>;

/**
 * Issue #3731 (F1): what the daemon did with the onboarding
 * `CLAUDE_CODE_OAUTH_TOKEN` from its service env (`absent` / `pending` /
 * `released` / `retained`). Defined in `@hapi/protocol/accounts` since #4736 so the
 * server's reader validates the same set; re-exported here for existing imports.
 */
export type { AmbientOnboardingTokenState };

export async function readSettings(): Promise<Settings> {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings };
  }

  try {
    const content = await readFile(configuration.settingsFile, "utf8");
    return JSON.parse(content);
  } catch {
    return { ...defaultSettings };
  }
}

/**
 * Synchronous settings read (issue #1733). The capability detector
 * (agentCapabilities.ts) runs synchronously + cached, so it cannot await the
 * async readSettings(). Mirrors its fall-back-to-defaults-on-error semantics.
 */
export function readSettingsSync(): Settings {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings };
  }
  try {
    return JSON.parse(
      readFileSync(configuration.settingsFile, "utf8")
    ) as Settings;
  } catch {
    return { ...defaultSettings };
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true });
  }

  // Issue #1733 (R9): settings.json holds secrets (cliApiToken,
  // openRouterApiKey) — write owner-only. chmod after write is umask-defense
  // (accountStore.ts precedent).
  await writeFile(
    configuration.settingsFile,
    JSON.stringify(settings, null, 2),
    { mode: 0o600 }
  );
  await chmod(configuration.settingsFile, 0o600).catch(() => {});
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100; // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50; // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true });
  }

  const lockFile = configuration.settingsFile + ".lock";
  const tmpFile = configuration.settingsFile + ".tmp";
  let fileHandle;
  let attempts = 0;

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // 'wx' = create exclusively, fail if exists (cross-platform compatible)
      fileHandle = await open(lockFile, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve =>
          setTimeout(resolve, LOCK_RETRY_INTERVAL_MS)
        );

        // Check for stale lock
        try {
          const stats = await stat(lockFile);
          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => {});
          }
        } catch {}
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(
      `Failed to acquire settings lock after ${(MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS) / 1000} seconds`
    );
  }

  try {
    // Read current settings with defaults
    const current = (await readSettings()) || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Write atomically using rename. Issue #1733 (R9): 0600 — settings.json
    // holds secrets; chmod after write is umask-defense.
    await writeFile(tmpFile, JSON.stringify(updated, null, 2), {
      mode: 0o600,
    });
    await chmod(tmpFile, 0o600).catch(() => {});
    await rename(tmpFile, configuration.settingsFile); // Atomic on POSIX

    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => {}); // Remove lock file
  }
}

//
// Authentication
//

export async function writeCredentialsDataKey(credentials: {
  publicKey: Uint8Array;
  machineKey: Uint8Array;
  token: string;
}): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true });
  }
  // Issue #1833: access.key holds the encryption key + auth token — write
  // owner-only, mirroring settings.json (#1733). chmod after write is
  // umask-defense (accountStore.ts precedent).
  await writeFile(
    configuration.privateKeyFile,
    JSON.stringify(
      {
        encryption: {
          publicKey: Buffer.from(credentials.publicKey).toString("base64"),
          machineKey: Buffer.from(credentials.machineKey).toString("base64"),
        },
        token: credentials.token,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  await chmod(configuration.privateKeyFile, 0o600).catch(() => {});
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile);
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined,
  }));
}

/**
 * Read daemon state from local file
 */
export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  try {
    if (!existsSync(configuration.daemonStateFile)) {
      return null;
    }
    const content = await readFile(configuration.daemonStateFile, "utf-8");
    return JSON.parse(content) as DaemonLocallyPersistedState;
  } catch (error) {
    // Issue #4155 (R10): print the path and the error code/class ONLY. A
    // JSON.parse message can quote the file — Bun echoes an unquoted identifier
    // in full (`Unexpected identifier "<token>"`), V8 ~10 chars around the error —
    // and this file holds the controlToken.
    console.error(
      `[PERSISTENCE] Daemon state file unreadable or not valid JSON: ${configuration.daemonStateFile} (${describeErrorKind(error)})`
    );
    return null;
  }
}

/**
 * Issue #4155 (R10): an error's code (`ENOENT`, `EACCES`, …) or class name —
 * never its message, which may quote file content.
 */
export function describeErrorKind(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Issue #4155 (R11): synchronous read for the daemon's compare-and-write, so no
 * `await` separates the ownership check from the write. `null` when the file is
 * missing or unparseable; never logs (the caller warns on a reclaim).
 */
export function readDaemonStateSync(): unknown {
  try {
    if (!existsSync(configuration.daemonStateFile)) return null;
    return JSON.parse(readFileSync(configuration.daemonStateFile, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  // Issue #1833: daemon.state.json holds the #1738 control-server bearer
  // token — write owner-only. writeDaemonState runs on daemon startup
  // (daemon/run.ts) and every heartbeat (daemon/healthScheduler.ts).
  //
  // Issue #4155 (R9): replace the file ATOMICALLY (temp in the same directory +
  // rename) so no reader — the CLI, the server, or another daemon's heartbeat —
  // ever parses a half-written record. The rename installs the temp's fresh 0600
  // inode, so a pre-existing world-readable file is remediated too (#1833 R2).
  const target = configuration.daemonStateFile;
  const tmp = `${target}.tmp-${process.pid}`;
  // The write sits inside the cleanup `try` too: a write that fails after
  // creating the temp (ENOSPC, EIO) must not leave a partial, token-bearing
  // `.tmp-<pid>` behind — no later daemon ever reuses this pid's name.
  try {
    writeFileSync(tmp, JSON.stringify(state, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    // Ruling D3 (2026-08-23): the chmod covers a stale temp left by a crashed
    // same-pid process (the `mode` option only applies on create), so a failure
    // must be LOGGED — never silently swallowed — but must NOT throw (it must
    // never crash the daemon startup/heartbeat path).
    try {
      chmodSync(tmp, 0o600);
    } catch (err) {
      console.warn(
        `[persistence] chmod 0600 on daemon.state.json failed: ${err}`
      );
    }
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort — the write/rename failure below is the error that matters
    }
    throw err;
  }
}

/**
 * Issue #4155 (R8): true when `pid` is a live process other than this one. Such
 * a process may own daemon.state.json or its lock, so no caller may delete them.
 * `isProcessAlive` is false on EPERM too — a pid this user cannot signal cannot
 * be a daemon on this user-owned HAPI_HOME.
 */
function namesOtherLiveProcess(pid: unknown): boolean {
  return typeof pid === "number" && pid !== process.pid && isProcessAlive(pid);
}

/** The `pid` recorded in daemon.state.json, or `undefined` if unreadable. */
function readStateFilePid(): unknown {
  const parsed = readDaemonStateSync();
  return parsed !== null && typeof parsed === "object"
    ? (parsed as { pid?: unknown }).pid
    : undefined;
}

/** Issue #4155 (R8): an empty/garbage lock is only stale after this long. */
const EMPTY_LOCK_STALE_MS = 10_000;

/**
 * Issue #4155 (R8): may the daemon lock file be deleted by this process? A lock
 * naming another LIVE process is never deleted (it may be a successor daemon).
 * An empty or unparseable lock is deleted only once it is ≥10 s old, because
 * `acquireDaemonLock` creates the file empty and writes the pid afterwards — a
 * fresh empty lock is a daemon mid-acquisition.
 */
function lockMayBeDeleted(): boolean {
  let content: string;
  try {
    content = readFileSync(configuration.daemonLockFile, "utf-8").trim();
  } catch {
    return true;
  }
  const pid = Number(content);
  if (content.length > 0 && Number.isInteger(pid) && pid > 0) {
    return !namesOtherLiveProcess(pid);
  }
  try {
    return (
      Date.now() - statSync(configuration.daemonLockFile).mtimeMs >=
      EMPTY_LOCK_STALE_MS
    );
  } catch {
    return true;
  }
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  // Issue #4155 (R8): never delete a state or lock file that names another LIVE
  // process. Both callers used to delete unconditionally: a replaced daemon's
  // shutdown (run.ts cleanupAndShutdown) deleted its live successor's record and
  // lock, and the CLI stale cleanup (controlClient.ts) deleted a live daemon's
  // lock whenever the state file named a dead pid — letting a second daemon start.
  // Stale (dead / own pid) and garbage files are still cleaned.
  if (
    existsSync(configuration.daemonStateFile) &&
    !namesOtherLiveProcess(readStateFilePid())
  ) {
    await unlink(configuration.daemonStateFile);
  }
  if (existsSync(configuration.daemonLockFile) && lockMayBeDeleted()) {
    try {
      await unlink(configuration.daemonLockFile);
    } catch {
      // Already gone (a concurrent cleanup) — nothing to do.
    }
  }
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // 'wx' ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(configuration.daemonLockFile, "wx");
      // Write PID to lock file for debugging
      await fileHandle.writeFile(String(process.pid));
      return fileHandle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        // Lock file exists, check if process is still running
        try {
          const lockPid = readFileSync(
            configuration.daemonLockFile,
            "utf-8"
          ).trim();
          if (lockPid && !isNaN(Number(lockPid))) {
            if (!isProcessAlive(Number(lockPid))) {
              // Process doesn't exist, remove stale lock
              unlinkSync(configuration.daemonLockFile);
              continue; // Retry acquisition
            }
          }
        } catch {
          // Can't read lock file, might be corrupted
        }
      }

      if (attempt === maxAttempts) {
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Release daemon lock by closing handle and deleting lock file
 */
export async function releaseDaemonLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch {}

  try {
    // Issue #4155 (R8): the handle's inode may already have been unlinked and the
    // path re-created by a successor daemon — never delete a lock naming it.
    if (existsSync(configuration.daemonLockFile) && lockMayBeDeleted()) {
      unlinkSync(configuration.daemonLockFile);
    }
  } catch {}
}
