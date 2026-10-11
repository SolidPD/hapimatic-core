// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Machine-level coordination for an account's machine-global isolated
 * credentials (issue #4423).
 *
 * Every Hapimatic instance on a machine (prod, dev, every worktree) and every
 * session wrapper they spawn shares ONE credentials file per account:
 * `<accountConfigsDir>/<uuid>/.credentials.json` (#1643). Refresh tokens are
 * single-use, so two writers that each rotate the token they last read race
 * each other: the loser presents a consumed token, gets `invalid_grant`, and the
 * account is flagged `unrefreshable` until a manual re-login. That is the
 * mechanism behind #4423's RP1 deaths.
 *
 * This module holds the pieces that keep those writers from destroying each
 * other's work:
 *  - {@link withAccountCredentialLock} — a per-account cross-process lock whose
 *    mtime is refreshed while held, so a slow holder is never reaped as stale.
 *  - {@link rotateIsolatedCredentials} — compare-and-swap rotation under that
 *    lock: adopt a fresher on-disk token instead of calling OAuth, and flag an
 *    account only when the rejected token is still the one on disk.
 *  - {@link refreshTokenFingerprint} — the record of WHICH token failed, so a
 *    stale flag clears only when a different token is on disk.
 *
 * It must not import `tokenRefreshService.ts` or `isolatedSnapshotRecovery.ts`
 * (both import it): `refreshFn`, the store merge and the clock arrive as
 * arguments. Token values never reach the logger.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { WORKTREE_PORT_MAX, WORKTREE_PORT_MIN } from "@hapi/protocol";
import type { StoredAccount } from "@hapi/protocol/accounts";
import {
  accountConfigDirFor,
  readIsolatedCredentials,
  writeIsolatedCredentials,
  type IsolatedClaudeAiOauth,
} from "@/accounts/accountConfigDir";
import { UUID_REGEX } from "@/accounts/accountStore";
import { normalizeHapiHome } from "@/daemon/orphanMcpReaper";
import { withFileLock } from "@/utils/fileLock";
import { logger } from "@/ui/logger";

// --- Per-account credential lock ------------------------------------------------

/** Lock taken around every rotation of the shared credentials file. */
export const ROTATE_LOCK_NAME = ".rotate.lock";
/**
 * Lock taken around spawn-time recovery. A DISTINCT file from
 * {@link ROTATE_LOCK_NAME}: recovery holds it while it calls the rotation path,
 * and `withFileLock` is not re-entrant. Lock order is always
 * `.recovery.lock` → `.rotate.lock` → the account store's own file lock.
 */
export const RECOVERY_LOCK_NAME = ".recovery.lock";

export type CredentialLockName =
  | typeof ROTATE_LOCK_NAME
  | typeof RECOVERY_LOCK_NAME;

/** Timing budgets for {@link withAccountCredentialLock}. All values in ms. */
export interface CredentialLockBudgets {
  /** How often the holder refreshes the lock file's mtime. */
  heartbeatMs: number;
  /** A lock whose mtime is older than this is presumed abandoned and reaped. */
  staleTimeoutMs: number;
  /** How long a waiter tries to acquire before giving up. */
  waitMs: number;
  /** Interval between acquisition attempts. */
  retryIntervalMs: number;
}

/**
 * Production budgets. `withFileLock`'s defaults (5 s wait, 10 s stale reap,
 * mtime written once at creation) are unsafe here: the refresh request alone
 * may take 15 s (`REQUEST_TIMEOUT_MS`), so a waiter could reap a LIVE lock,
 * re-read an unchanged file and present the same refresh token a second time —
 * and the first holder's release (by path) would then delete the second
 * holder's lock.
 *
 * The hold has no hard ceiling: 15 s to response headers, an untimed body read,
 * the credentials write, then a store-lock wait of up to ~5 s — about 20 s for
 * the bounded part. So: the holder refreshes its mtime every 5 s, which makes
 * "stale" mean "the holder died" however long the hold lasts; the stale timeout
 * is 30 s (six missed heartbeats); a waiter waits up to 30 s, above the ~20 s
 * bounded hold. Cost: after a holder is killed mid-rotation the account is
 * locked for up to 30 s instead of 10 s.
 */
export const CREDENTIAL_LOCK_BUDGETS: CredentialLockBudgets = {
  heartbeatMs: 5_000,
  staleTimeoutMs: 30_000,
  waitMs: 30_000,
  retryIntervalMs: 100,
};

/**
 * Run `fn` under the per-account credential lock `lockName` in the account's
 * machine-global config dir. Throws `FileLockTimeoutError` when the lock cannot
 * be acquired within `budgets.waitMs` — callers map that to a transient outcome.
 */
export async function withAccountCredentialLock<T>(
  accountUuid: string,
  lockName: CredentialLockName,
  fn: () => Promise<T>,
  budgets: CredentialLockBudgets = CREDENTIAL_LOCK_BUDGETS
): Promise<T> {
  const dir = accountConfigDirFor(accountUuid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, lockName);
  return withFileLock(
    {
      lockPath,
      staleTimeoutMs: budgets.staleTimeoutMs,
      retryIntervalMs: budgets.retryIntervalMs,
      maxAttempts: Math.max(
        1,
        Math.ceil(budgets.waitMs / budgets.retryIntervalMs)
      ),
    },
    async () => {
      const heartbeat = setInterval(() => {
        const t = new Date();
        utimes(lockPath, t, t).catch(() => {});
      }, budgets.heartbeatMs);
      heartbeat.unref?.();
      try {
        return await fn();
      } finally {
        clearInterval(heartbeat);
      }
    }
  );
}

// --- Machine rotator role (R1, R2) ----------------------------------------------

export interface MachineRotatorRoleInputs {
  /** This daemon runs as a `hapimatic-wt-<port>-daemon.service` unit. */
  selfIsWorktreeDaemonUnit: boolean;
  /** `configuration.serverUrl` — the daemon's own server. */
  serverUrl: string;
  /** `configuration.idleRefreshEnabled` (HAPI_IDLE_REFRESH). */
  idleRefreshEnabled: boolean;
}

export interface MachineRotatorRole {
  /** This daemon's idle backstop may proactively rotate the shared credentials. */
  rotator: boolean;
  /** This daemon belongs to a worktree instance (by unit or by server port). */
  worktreeInstance: boolean;
}

/** True when `serverUrl`'s explicit port lies in the worktree port range. */
function isWorktreeServerUrl(serverUrl: string): boolean {
  try {
    const port = Number(new URL(serverUrl).port);
    return port >= WORKTREE_PORT_MIN && port <= WORKTREE_PORT_MAX;
  } catch {
    return false;
  }
}

/**
 * The machine-rotator role (ER-D1, ER-D2): a daemon proactively rotates a
 * machine's shared credentials if and only if it is NOT a worktree-instance
 * daemon AND `HAPI_IDLE_REFRESH` is on. No owner lock, no lock file, no new
 * environment variable: worktree daemons are excluded in code, a dev daemon opts
 * out with its permanent `HAPI_IDLE_REFRESH=off` drop-in, and the node's primary
 * daemon rotates. A worktree daemon is recognized by EITHER signal: its systemd
 * unit name, or its server port (which catches one started outside its unit by
 * `hapi` / `hapi daemon start`). Pure: every input arrives as an argument.
 *
 * Accepted consequence: a second NON-worktree instance without the opt-out is a
 * second proactive rotator, bounded only by the compare-and-swap rotation and
 * the sibling-liveness scan. Spawn-time recovery is NOT gated by this role.
 */
export function resolveMachineRotatorRole(
  inputs: MachineRotatorRoleInputs
): MachineRotatorRole {
  const worktreeInstance =
    inputs.selfIsWorktreeDaemonUnit || isWorktreeServerUrl(inputs.serverUrl);
  return {
    rotator: !worktreeInstance && inputs.idleRefreshEnabled,
    worktreeInstance,
  };
}

/** The start-up role line (soak criterion S1 reads it). */
export function machineRotatorRoleLine(
  role: MachineRotatorRole,
  idleRefreshEnabled: boolean
): string {
  return `[IDLE_REFRESH] machine rotator: ${role.rotator ? "yes" : "no"} (worktree-instance daemon: ${role.worktreeInstance ? "yes" : "no"}; HAPI_IDLE_REFRESH: ${idleRefreshEnabled ? "on" : "off"})`;
}

// --- Sibling-instance liveness (R5) ---------------------------------------------

/** Accounts bound by a live session of ANOTHER Hapimatic instance on this machine. */
export interface SiblingBindingScan {
  uuids: Set<string>;
  /** `/proc` could not be listed: liveness is unknown, so the caller fails safe. */
  degraded: boolean;
}

export interface SiblingScanOptions {
  /** This daemon's `configuration.happyHomeDir`. */
  ownHapiHome: string;
  /** `configuration.accountConfigsDir` (the machine-global isolated base). */
  accountConfigsDir: string;
  /** Test seams; production reads the real `/proc`. */
  platform?: NodeJS.Platform;
  procRoot?: string;
  listDir?: (path: string) => string[];
  readFile?: (path: string) => string;
  selfPid?: number;
}

/** The env keys the scan reads — nothing else is parsed out of an environ. */
const SCAN_ENV_KEYS = ["HAPI_ACCOUNT_UUID", "CLAUDE_CONFIG_DIR", "HAPI_HOME"];

function parseScanEnv(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0 && SCAN_ENV_KEYS.includes(entry.slice(0, eq))) {
      out.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
  }
  return out;
}

/**
 * A Hapimatic SESSION WRAPPER (the process that owns a session and carries
 * `HAPI_ACCOUNT_UUID`). The daemon launches it as
 * `<binary> --hapi-starting-mode remote --started-by daemon …` — observed on RP1
 * (2026-10-05): `claude` is the default command and is NOT passed, so the key is
 * the `--started-by` flag (an explicit `claude` subcommand also counts). The
 * binary's name differs per instance, so argv[0] is not consulted. A
 * `<binary> mcp` child also carries the variable but is not a wrapper.
 */
function isSessionWrapperArgv(argv: readonly string[]): boolean {
  return argv.includes("--started-by") || argv[1] === "claude";
}

/**
 * A native Claude Code process (carries `CLAUDE_CONFIG_DIR`). Observed on RP1:
 * argv[0] is `claude` or `…/bin/claude`. Keyed on argv[0]'s basename, NOT on
 * `comm`: the `ugrep` shim execs the Claude binary with comm `claude.exe` and
 * argv[0] `ugrep`, and a tool must never pin an account.
 */
function isNativeClaudeArgv(argv: readonly string[]): boolean {
  return argv.length > 0 && basename(argv[0]) === "claude";
}

/** `<accountConfigsDir>/<uuid>` → uuid; anything else → null. */
function uuidFromConfigDir(
  configDir: string | undefined,
  accountConfigsDir: string
): string | null {
  if (!configDir) return null;
  const dir = resolve(configDir);
  const uuid = basename(dir);
  return dirname(dir) === resolve(accountConfigsDir) && UUID_REGEX.test(uuid)
    ? uuid
    : null;
}

/**
 * Issue #4423 (R5): the accounts bound by a live session of a SIBLING instance
 * on this machine. A daemon's own server reports only its own sessions, so a dev
 * or worktree daemon used to see every prod session as idle. Two process kinds
 * bind an account — a session wrapper carrying `HAPI_ACCOUNT_UUID=<uuid>`, and a
 * native `claude` carrying `CLAUDE_CONFIG_DIR=<accountConfigsDir>/<uuid>` (an
 * env-token session's `claude` carries neither, so only its wrapper shows the
 * account). Shells, tools and MCP servers inside a session inherit the variables
 * and are NOT counted, or one leftover background job would pin an account.
 *
 * Own versus sibling: ancestry cannot decide it (under tmux persistence the
 * daemon is never an ancestor of its sessions), so the matched process's
 * `HAPI_HOME` is compared with this daemon's. Equal → own instance → NOT
 * reported (the daemon's own server already reports it, under the #3541 rules).
 * Different, or absent → sibling.
 *
 * Failure handling: an unreadable environ (another user's process) or a pid
 * that exits mid-scan is ignored; a matched process whose argv cannot be read is
 * counted; an unlistable `/proc` on Linux is DEGRADED, not empty. On a
 * non-Linux platform the scan is unavailable: empty, not degraded. Never throws.
 */
export function scanSiblingBoundAccounts(
  opts: SiblingScanOptions
): SiblingBindingScan {
  const none = (degraded: boolean): SiblingBindingScan => ({
    uuids: new Set(),
    degraded,
  });
  if ((opts.platform ?? process.platform) !== "linux") return none(false);
  const root = opts.procRoot ?? "/proc";
  const listDir = opts.listDir ?? (path => readdirSync(path));
  const readFile = opts.readFile ?? (path => readFileSync(path, "utf8"));
  const selfPid = opts.selfPid ?? process.pid;
  const ownHome = normalizeHapiHome(opts.ownHapiHome);
  const read = (pid: string, name: string): string | null => {
    try {
      return readFile(join(root, pid, name));
    } catch {
      return null;
    }
  };

  let pids: string[];
  try {
    pids = listDir(root).filter(p => /^\d+$/.test(p));
  } catch {
    return none(true);
  }
  const uuids = new Set<string>();
  for (const pid of pids) {
    if (Number(pid) === selfPid) continue;
    const envRaw = read(pid, "environ");
    if (!envRaw) continue;
    const env = parseScanEnv(envRaw);
    const wrapperRaw = env.get("HAPI_ACCOUNT_UUID");
    const wrapperUuid =
      wrapperRaw && UUID_REGEX.test(wrapperRaw) ? wrapperRaw : null;
    const nativeUuid = uuidFromConfigDir(
      env.get("CLAUDE_CONFIG_DIR"),
      opts.accountConfigsDir
    );
    if (!wrapperUuid && !nativeUuid) continue;
    const argvRaw = read(pid, "cmdline");
    const argv = argvRaw ? argvRaw.split("\0").filter(Boolean) : [];
    let uuid: string | null;
    if (argv.length === 0) {
      uuid = wrapperUuid ?? nativeUuid; // kind unknown → count it
    } else if (isSessionWrapperArgv(argv)) {
      uuid = wrapperUuid;
    } else if (isNativeClaudeArgv(argv)) {
      uuid = nativeUuid;
    } else {
      continue; // a shell or tool started inside a session
    }
    if (!uuid) continue;
    const home = normalizeHapiHome(env.get("HAPI_HOME"));
    if (home !== null && home === ownHome) continue;
    uuids.add(uuid);
  }
  return { uuids, degraded: false };
}

// --- Failed-token fingerprint ---------------------------------------------------

/**
 * SHA-256 hex digest of a refresh token — persisted beside the `unrefreshable`
 * flag to record WHICH token was rejected. Never the token itself, and never
 * logged beyond its first 8 characters.
 */
export function refreshTokenFingerprint(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

/** A copy of `account` without the failed-token fingerprint. */
export function withoutFailedTokenFingerprint(
  account: StoredAccount
): StoredAccount {
  const { unrefreshableTokenFingerprint: _dropped, ...rest } = account;
  return rest as StoredAccount;
}

/**
 * Task 6's clear rule for a flag that carries a fingerprint: true when the
 * credentials now on disk hold a refresh token OTHER than the one recorded as
 * failed (a re-login, a sibling's successful rotation, or a last-resort seed).
 * False for an unflagged record, a legacy flag with no fingerprint (the caller
 * keeps its probe arm for that case), or the same token.
 */
export function fingerprintedFlagIsStale(
  account: StoredAccount,
  onDiskRefreshToken: string
): boolean {
  const failed = account.unrefreshableTokenFingerprint;
  return (
    account.unrefreshable === true &&
    typeof failed === "string" &&
    failed.length > 0 &&
    failed !== refreshTokenFingerprint(onDiskRefreshToken)
  );
}

// --- Compare-and-swap decisions (pure) -----------------------------------------

/** True when `expiresAt` lies beyond the expiry buffer. */
function isFresh(expiresAt: number, now: number, bufferMs: number): boolean {
  return expiresAt - now > bufferMs;
}

export type RotationDecision =
  | { action: "not-found" }
  | { action: "rotate"; refreshToken: string }
  | { action: "adopt" };

/**
 * What to do once the lock is held, given the refresh token the caller read
 * before waiting (`presented`) and the credentials now on disk:
 *  1. unreadable → `not-found`;
 *  2. the same token → rotate it;
 *  3. a different, fresh token → someone already rotated or re-logged in:
 *     adopt it, no OAuth call;
 *  4. a different token that is NOT fresh (e.g. a pre-fix binary seeded an
 *     expired head) → rotate the ON-DISK token.
 */
export function decideRotation(
  presented: string,
  onDisk: IsolatedClaudeAiOauth | null,
  now: number,
  expiryBufferMs: number
): RotationDecision {
  if (!onDisk) return { action: "not-found" };
  if (onDisk.refreshToken === presented) {
    return { action: "rotate", refreshToken: presented };
  }
  if (isFresh(onDisk.expiresAt, now, expiryBufferMs)) {
    return { action: "adopt" };
  }
  return { action: "rotate", refreshToken: onDisk.refreshToken };
}

/**
 * After a successful OAuth call: true when a late writer replaced the presented
 * token with a fresh head while the call was in flight, so the rotated pair
 * must NOT overwrite it.
 */
export function lateWriterWins(
  presented: string,
  onDiskNow: IsolatedClaudeAiOauth | null,
  now: number,
  expiryBufferMs: number
): boolean {
  return (
    onDiskNow !== null &&
    onDiskNow.refreshToken !== presented &&
    isFresh(onDiskNow.expiresAt, now, expiryBufferMs)
  );
}

/**
 * After a permanent rejection: flag the account only when the rejected token
 * is still the one on disk. If the file changed during the call (a login
 * write-through or a peer rotation landed), the rejected token is no longer the
 * account's token.
 */
export function rejectedTokenStillOnDisk(
  presented: string,
  onDiskNow: IsolatedClaudeAiOauth | null
): boolean {
  return onDiskNow !== null && onDiskNow.refreshToken === presented;
}

// --- Compare-and-swap rotation --------------------------------------------------

export interface RotatedPair {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch ms. */
  expiresAt: number;
}

export type IsolatedRotationOutcome =
  | { status: "success"; accessToken: string }
  | { status: "permanent"; detail: string; rejectedTokenFingerprint: string }
  | { status: "transient"; detail: string }
  | { status: "not-found" };

export interface IsolatedRotationDeps {
  accountUuid: string;
  /** The refresh token the caller read BEFORE taking the lock. */
  presentedRefreshToken: string;
  refreshFn: (refreshToken: string) => Promise<RotatedPair>;
  /** Classifies a `refreshFn` rejection as a permanent (`invalid_grant`-class) failure. */
  isPermanentError: (err: unknown) => boolean;
  /** Read-merge-write onto THIS instance's store record for the account. */
  mergeStore: (
    mergeFn: (current: StoredAccount) => StoredAccount
  ) => Promise<void>;
  now: () => number;
  expiryBufferMs: number;
  /** Test seam; production uses {@link CREDENTIAL_LOCK_BUDGETS}. */
  budgets?: CredentialLockBudgets;
  /** Test seams; production uses the real file helpers. */
  readCredentials?: (
    accountUuid: string
  ) => Promise<IsolatedClaudeAiOauth | null>;
  writeCredentials?: (
    accountUuid: string,
    oauth: IsolatedClaudeAiOauth
  ) => Promise<void>;
}

/**
 * One rotation of an account's shared credentials file, compare-and-swap under
 * {@link ROTATE_LOCK_NAME} (R4). Never throws: a lock timeout, a credentials
 * write failure or a store-mirror failure maps to `transient` (the last two are
 * pre-existing hazards, unchanged here).
 */
export async function rotateIsolatedCredentials(
  deps: IsolatedRotationDeps
): Promise<IsolatedRotationOutcome> {
  const uuid = deps.accountUuid;
  try {
    return await withAccountCredentialLock(
      uuid,
      ROTATE_LOCK_NAME,
      () => rotateLocked(deps),
      deps.budgets
    );
  } catch (err) {
    return {
      status: "transient",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The locked body of {@link rotateIsolatedCredentials}. */
async function rotateLocked(
  deps: IsolatedRotationDeps
): Promise<IsolatedRotationOutcome> {
  const uuid = deps.accountUuid;
  const read = deps.readCredentials ?? readIsolatedCredentials;
  const write = deps.writeCredentials ?? writeIsolatedCredentials;

  const onDisk = await read(uuid);
  const decision = decideRotation(
    deps.presentedRefreshToken,
    onDisk,
    deps.now(),
    deps.expiryBufferMs
  );
  if (decision.action === "not-found" || !onDisk) {
    logger.warn(
      `[TOKEN_REFRESH] forceRefreshIsolated: no readable isolated credentials for ${uuid}`
    );
    return { status: "not-found" };
  }
  if (decision.action === "adopt") {
    return await adoptOnDisk(deps, onDisk);
  }

  const presented = decision.refreshToken;
  let rotated: RotatedPair;
  try {
    rotated = await deps.refreshFn(presented);
  } catch (err) {
    if (!deps.isPermanentError(err)) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    const onDiskNow = await read(uuid);
    if (!rejectedTokenStillOnDisk(presented, onDiskNow)) {
      logger.warn(
        `[TOKEN_REFRESH] isolated rotation for ${uuid} was rejected (${detail}), but the credentials file changed during the call; not flagged`
      );
      return {
        status: "transient",
        detail: `rejected token superseded on disk (${detail})`,
      };
    }
    const fingerprint = refreshTokenFingerprint(presented);
    await deps.mergeStore(current => ({
      ...current,
      unrefreshable: true,
      unrefreshableTokenFingerprint: fingerprint,
    }));
    logger.warn(
      `[TOKEN_REFRESH] isolated rotation for ${uuid} permanently rejected (${detail}); marked unrefreshable (failed token ${fingerprint.slice(0, 8)})`
    );
    return {
      status: "permanent",
      detail,
      rejectedTokenFingerprint: fingerprint,
    };
  }

  // Re-read before writing: a late writer's fresh head must not be lost.
  const onDiskNow = await read(uuid);
  if (
    onDiskNow &&
    lateWriterWins(presented, onDiskNow, deps.now(), deps.expiryBufferMs)
  ) {
    return await adoptOnDisk(deps, onDiskNow);
  }
  // Write the rotated pair back FIRST (the source of truth native re-reads);
  // preserve subscriptionType / rateLimitTier / scopes.
  await write(uuid, {
    ...(onDiskNow ?? onDisk),
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt,
  });
  // Mirror into the store and clear the flag (this token demonstrably works).
  await deps.mergeStore(current => ({
    ...withoutFailedTokenFingerprint(current),
    accessToken: rotated.accessToken,
    refreshToken: rotated.refreshToken,
    expiresAt: rotated.expiresAt,
    lastRefreshedAt: deps.now(),
    unrefreshable: false,
  }));
  // Byte-stable: this line means a real OAuth rotation — the #4423 soak
  // attributes every one of them.
  logger.info(
    `[TOKEN_REFRESH] forceRefreshIsolated: rotated isolated token for ${uuid}`
  );
  return { status: "success", accessToken: rotated.accessToken };
}

/**
 * Case 3 of {@link decideRotation} (and a late writer after a rotation): mirror
 * the on-disk triple into this instance's store without an OAuth call. The
 * `unrefreshable` flag follows Task 6's rule — it clears only when it records a
 * different failed token — rather than being cleared outright.
 */
async function adoptOnDisk(
  deps: IsolatedRotationDeps,
  onDisk: IsolatedClaudeAiOauth
): Promise<IsolatedRotationOutcome> {
  await deps.mergeStore(current => {
    const base = fingerprintedFlagIsStale(current, onDisk.refreshToken)
      ? { ...withoutFailedTokenFingerprint(current), unrefreshable: false }
      : current;
    return {
      ...base,
      accessToken: onDisk.accessToken,
      refreshToken: onDisk.refreshToken,
      expiresAt: onDisk.expiresAt,
    };
  });
  logger.info(
    `[TOKEN_REFRESH] forceRefreshIsolated: adopted the on-disk credentials for ${deps.accountUuid} — another writer already rotated (no OAuth call)`
  );
  return { status: "success", accessToken: onDisk.accessToken };
}
