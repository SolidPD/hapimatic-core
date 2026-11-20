// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared-chain detector (issue #6800, R6).
 *
 * Before #6800 the account `~/.claude.json` names (the node's terminal `claude`
 * login) was special: Hapimatic never bound it to its own folder and never
 * refreshed it, and three copiers (the credentials watcher's store put and folder
 * seed, and the store's first-run migration) copied its `~/.claude` OAuth chain
 * into Hapimatic. Refresh tokens are single-use, so one chain held in two places
 * with two refreshers is the #1520 race: the slower refresher presents a
 * consumed token and the account dies. #6800 removes the special case and the
 * copiers; this module finds any copy of the `~/.claude` chain that is still
 * held by Hapimatic and quarantines it.
 *
 * Once per daemon boot and once per maintenance tick, on every non-tenant
 * daemon, a pass:
 *  - reads the `~/.claude/.credentials.json` refresh-token FINGERPRINT (sha256).
 *    That is the only read of that file after #6800, and the token itself never
 *    leaves {@link readHostRefreshFingerprint};
 *  - lists the sibling daemons on this machine that are live and run an older
 *    build. While one is live the pass flags only and moves no file, because an
 *    old credentials watcher would re-seed a moved file (one `error_logs` row per
 *    such daemon);
 *  - on each store's first pass (no marker file yet) flags the account
 *    `~/.claude.json` names, unless a Provider Accounts sign-in marker in its
 *    machine-global folder names that folder's current token (issue #6837 R7):
 *    a store copy an old watcher captured is a point-in-time copy of a chain
 *    terminal `claude` keeps rotating, so token equality alone misses it, and
 *    the watcher wrote the same capture to the folder, so a folder token that
 *    merely differs from the host's proves nothing. R7 replaces #6800's
 *    "differs from the host's" exemption (#6800 Requirement 5 decision, amended
 *    by its expert review item 1). Known limit: this flags the account at every
 *    store's first pass unless a sign-in happened within the current token's
 *    lifetime (the marker is written only by a sign-in, while every refresh
 *    replaces the folder's token); one sign-in clears it;
 *  - on every pass compares the fingerprint with each Anthropic account's store
 *    record and folder files (the machine-global folder and every legacy
 *    `~/.hapimatic-*\/account-configs/<uuid>` folder):
 *    - a store match is flagged `unrefreshable` with reason
 *      {@link HOST_CHAIN_SHARED_REASON} and the fingerprint of the record's own
 *      token, so only a different token (a sign-in) clears it;
 *    - a folder match is moved aside to `.credentials.json.host-chain-shared-<ts>`
 *      (a rename keeps mode 0600) under the documented lock order, after the
 *      flag, and only when no live session is bound to the account;
 *    - a folder-only match (the store token is independent) is moved and NOT
 *      flagged: the next spawn re-seeds the folder from the store head.
 *
 * It never copies, overwrites or deletes a chain, never calls OAuth, never
 * writes `~/.claude` and never throws. Token values never reach the logger or
 * `error_logs`; fingerprints are logged as their first 8 characters.
 */

import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AccountIndexEntry,
  StoredAccount,
  ValidateAccountResult,
} from "@hapi/protocol/accounts";
import {
  HOST_CHAIN_SHARED_REASON,
  isEnvTokenAccount,
} from "@hapi/protocol/accounts";
import { isOlderSiblingVersion } from "@hapi/protocol";
import { configuration } from "@/configuration";
import {
  isolatedCredentialPathsAnywhere,
  listInstanceHomes,
} from "@/accounts/accountConfigDir";
import { UUID_REGEX } from "@/accounts/accountStore";
import {
  RECOVERY_LOCK_NAME,
  refreshTokenFingerprint,
  withAccountCredentialLock,
  type CredentialLockBudgets,
} from "@/accounts/machineRotator";
import {
  withNativeRefreshLock,
  withNativeStorageWriteLock,
  type NativeLockBudgetSet,
} from "@/accounts/nativeCredentialLock";
import {
  readSignInMarkerIn,
  signInMarkerNamesToken,
} from "@/accounts/signInMarker";
import { logger } from "@/ui/logger";
import { isProcessAlive } from "@/utils/process";
import { CLI_VERSION } from "@/version";

/** Re-exported so callers of this module need one import. */
export { HOST_CHAIN_SHARED_REASON };

/** The terminal `claude` login's credentials file. */
export function hostCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

/** The terminal `claude` login's identity file. */
export function hostConfigPath(): string {
  return join(homedir(), ".claude.json");
}

/** File name of the per-store identity-pass marker, in the store dir. */
export const IDENTITY_PASS_MARKER_NAME = "host-chain-identity-pass.json";

/** Suffix of a moved-aside credentials file (before its timestamp). */
export const MOVED_ASIDE_SUFFIX = ".host-chain-shared-";

/**
 * A sibling daemon whose heartbeat is older than this is not live: three
 * missed 60 s heartbeats (`healthScheduler.ts`, `HAPI_DAEMON_HEARTBEAT_INTERVAL`).
 */
export const SIBLING_HEARTBEAT_STALE_MS = 180_000;

/**
 * Lock budgets for a move-aside. Short waits, so a busy lock skips the account
 * for this pass instead of stalling the maintenance tick; the next pass tries
 * again.
 */
export const MOVE_ASIDE_LOCK_BUDGETS: CredentialLockBudgets = {
  heartbeatMs: 5_000,
  staleTimeoutMs: 30_000,
  waitMs: 2_000,
  retryIntervalMs: 100,
};

export const MOVE_ASIDE_NATIVE_LOCK_BUDGETS: NativeLockBudgetSet = {
  refresh: {
    staleMs: 60_000,
    heartbeatMs: 5_000,
    waitMs: 2_000,
    minRetryMs: 100,
    maxRetryMs: 300,
  },
  storageWrite: {
    staleMs: 15_000,
    heartbeatMs: 5_000,
    waitMs: 2_000,
    minRetryMs: 100,
    maxRetryMs: 300,
  },
};

/** The `claudeAiOauth.refreshToken` of a credentials file, or null. Never throws. */
async function readRefreshTokenAt(path: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as {
      claudeAiOauth?: { refreshToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.refreshToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** A host file that exists but cannot be read is warned about once per window. */
export const HOST_UNREADABLE_WARN_WINDOW_MS = 15 * 60_000;
const hostUnreadableWarnedAt = new Map<string, number>();

function warnHostUnreadable(path: string, reason: string): void {
  const key = `${path}|${reason}`;
  const now = Date.now();
  const last = hostUnreadableWarnedAt.get(key);
  if (last !== undefined && now - last < HOST_UNREADABLE_WARN_WINDOW_MS) return;
  hostUnreadableWarnedAt.set(key, now);
  // The reason is an errno code or fixed text, never parser output: a JSON
  // parse error quotes part of the file, which holds the token.
  logger.warn(
    `[ACCOUNTS] ${path} exists but cannot be read (${reason}); the shared-chain checks treat it as no ~/.claude login until it reads again`
  );
}

/**
 * The sha256-hex fingerprint of the `~/.claude/.credentials.json`
 * `claudeAiOauth.refreshToken`, or null when the file is missing, unreadable or
 * holds no refresh token. Returns the fingerprint, never the token. This is the
 * only reader of that file after #6800 (R5). A file that exists but cannot be
 * read or parsed is logged (deduped), so "no login" and "cannot read" can be
 * told apart in the log.
 */
export async function readHostRefreshFingerprint(
  path: string = hostCredentialsPath()
): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") warnHostUnreadable(path, code ?? "read error");
    return null;
  }
  let token: unknown;
  try {
    token = (JSON.parse(raw) as { claudeAiOauth?: { refreshToken?: unknown } })
      .claudeAiOauth?.refreshToken;
  } catch {
    warnHostUnreadable(path, "not valid JSON");
    return null;
  }
  return typeof token === "string" && token.length > 0
    ? refreshTokenFingerprint(token)
    : null;
}

/**
 * True when `refreshToken` is the current `~/.claude` refresh token (by
 * fingerprint, read fresh on every call). False when either side is empty.
 * Every point that uses a token calls this first (#6800 invariant I1), so a
 * chain an older daemon re-copied between two detector passes is still refused.
 */
export async function sharesHostChain(
  refreshToken: string | null | undefined,
  readHostFp: () => Promise<string | null> = readHostRefreshFingerprint
): Promise<boolean> {
  if (!refreshToken) return false;
  const hostFp = await readHostFp().catch(() => null);
  if (!hostFp) return false;
  return refreshTokenFingerprint(refreshToken) === hostFp;
}

/**
 * The account uuid `~/.claude.json` names (`oauthAccount.accountUuid`, identity
 * only): the uuid, `null` when the file is missing or names no valid account,
 * or `"unreadable"` when it exists but cannot be read or parsed.
 */
export async function readHostNamedUuid(
  path: string = hostConfigPath()
): Promise<string | null | "unreadable"> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : "unreadable";
  }
  try {
    const uuid = (
      JSON.parse(raw) as { oauthAccount?: { accountUuid?: unknown } }
    ).oauthAccount?.accountUuid;
    return typeof uuid === "string" && UUID_REGEX.test(uuid) ? uuid : null;
  } catch {
    return "unreadable";
  }
}

/** The build-order rule, shared with the server's sign-in warning. */
export { isOlderSiblingVersion };

/**
 * Whether a move-aside must wait because a live session on this machine may be
 * using the account's folder: a session of this instance or of a sibling
 * instance is bound to it, or either view is degraded (unknown counts as
 * bound). `federationDegraded` never counts: the folder is local to the
 * machine, so a remote session cannot be using it.
 */
export function boundOnMachine(
  uuid: string,
  live: { uuids: Set<string>; localDegraded?: boolean },
  sibling: { uuids: Set<string>; degraded: boolean }
): boolean {
  return (
    live.localDegraded === true ||
    sibling.degraded ||
    live.uuids.has(uuid) ||
    sibling.uuids.has(uuid)
  );
}

/** The three fields of a sibling `daemon.state.json` the pass reads. */
export interface SiblingDaemonState {
  /** The sibling's instance home (`~/.hapimatic-<name>`). */
  instanceHome: string;
  pid: number;
  lastHeartbeatAt: number | null;
  startedWithCliVersion: string | null;
}

/**
 * For each instance home other than `ownHapiHome`, the `pid`,
 * `lastHeartbeatAt` and `startedWithCliVersion` of its `daemon.state.json`.
 * Only those fields are parsed out: the file also holds the daemon's control
 * token, which never leaves this function. A home with no state file, or one
 * that does not parse, is skipped. Never throws.
 */
export async function readSiblingDaemonStates(
  instanceHomes: string[],
  ownHapiHome: string
): Promise<SiblingDaemonState[]> {
  const own = resolve(ownHapiHome);
  const out: SiblingDaemonState[] = [];
  for (const home of instanceHomes) {
    if (resolve(home) === own) continue;
    try {
      const parsed = JSON.parse(
        await readFile(join(home, "daemon.state.json"), "utf-8")
      ) as Record<string, unknown>;
      if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid)) {
        continue;
      }
      out.push({
        instanceHome: home,
        pid: parsed.pid,
        lastHeartbeatAt:
          typeof parsed.lastHeartbeatAt === "number"
            ? parsed.lastHeartbeatAt
            : null,
        startedWithCliVersion:
          typeof parsed.startedWithCliVersion === "string"
            ? parsed.startedWithCliVersion
            : null,
      });
    } catch {
      // no daemon here, or an unreadable record: not counted
    }
  }
  return out;
}

/** One `error_logs` entry (the daemon's `logger.reportError`). */
export interface QuarantineReport {
  message: string;
  category: string;
  severity: "warn" | "error";
  context: string;
}

/** The identity-pass marker. It holds no token and no fingerprint. */
export interface IdentityPassMarker {
  version: 1;
  completedAt: string;
  hostNamedUuid: string | null;
}

export type MoveAsideResult = "moved" | "changed" | "gone";

export interface HostChainQuarantineDeps {
  /** sha256-hex of the `~/.claude` refresh token, or null. */
  readHostRefreshFingerprint: () => Promise<string | null>;
  /** The uuid `~/.claude.json` names, null, or "unreadable". */
  readHostNamedUuid: () => Promise<string | null | "unreadable">;
  /** Anthropic account uuids in this instance's store. */
  listAccountUuids: () => Promise<string[]>;
  /** A store record, or null when missing or malformed. */
  getAccount: (uuid: string) => Promise<StoredAccount | null>;
  /** Read-merge-write onto this instance's store record. */
  mergeStore: (
    uuid: string,
    mergeFn: (current: StoredAccount) => StoredAccount
  ) => Promise<void>;
  /**
   * Every credentials path of the account: the machine-global folder file
   * FIRST, then each legacy per-instance file.
   */
  credentialPaths: (uuid: string) => Promise<string[]>;
  /**
   * True when a live session on this machine (this instance or a sibling) is
   * bound to the account, or when that view is degraded. The boot pass sets
   * {@link flagOnly} instead, because no live-session view exists yet.
   */
  isBound: (uuid: string) => Promise<boolean>;
  /** The marker file path (`<accountsDir>/host-chain-identity-pass.json`). */
  identityPassMarkerPath: string;
  /** Sibling daemons on this machine (see {@link readSiblingDaemonStates}). */
  listSiblingDaemonStates: () => Promise<SiblingDaemonState[]>;
  /** This daemon's `startedWithCliVersion`. */
  ownVersion: string;
  isPidAlive: (pid: number) => boolean;
  now: () => number;
  /** Test seam; production writes to the server's `error_logs`. */
  report?: (report: QuarantineReport) => void;
  /** Test seams; production reads and writes the marker file. */
  readMarker?: () => Promise<boolean>;
  writeMarker?: (marker: IdentityPassMarker) => Promise<void>;
  /**
   * Issue #6837 (R7): the refresh fingerprint the Provider Accounts sign-in
   * marker in a folder names, or null. Default {@link readSignInMarkerIn}.
   */
  readSignInMarker?: (folderDir: string) => Promise<string | null>;
  /** Test seam; production reads the file's `claudeAiOauth.refreshToken`. */
  readRefreshToken?: (path: string) => Promise<string | null>;
  /** Test seam; production renames under the lock order. */
  moveAside?: (args: {
    uuid: string;
    path: string;
    machineGlobal: boolean;
    machineGlobalFolderExists: boolean;
    hostFingerprint: string;
    stamp: string;
  }) => Promise<MoveAsideResult>;
  /** Per-key dedupe of warn lines and reports (default: process-wide). */
  reported?: Map<string, string>;
  /**
   * The boot pass: flag only and move no file, because no live-session view
   * exists yet. Its kept files are logged as such, not as "live session".
   */
  flagOnly?: boolean;
}

/** What one pass did, for the caller's log and for tests. */
export interface HostChainQuarantineSummary {
  skipped: null | "no-host-login" | "error";
  flagged: string[];
  moved: string[];
  kept: string[];
  olderSiblingDaemons: number;
  markerWritten: boolean;
}

/** Process-wide dedupe: one warn line and one report per finding and state. */
const reportedFindings = new Map<string, string>();

/** Test hook: forget every reported finding. */
export function clearHostChainReportCache(): void {
  reportedFindings.clear();
}

function defaultReport(r: QuarantineReport): void {
  logger.reportError({
    message: r.message,
    category: r.category,
    severity: r.severity,
    context: r.context,
  });
}

function fp8(fingerprint: string | null): string {
  return fingerprint ? fingerprint.slice(0, 8) : "none";
}

/** `YYYYMMDDTHHMMSSZ` for a move-aside file name. */
export function moveAsideStamp(nowMs: number): string {
  return new Date(nowMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultReadMarker(path: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as {
      version?: unknown;
    };
    return parsed.version === 1;
  } catch {
    return false;
  }
}

async function defaultWriteMarker(
  path: string,
  marker: IdentityPassMarker
): Promise<void> {
  // A store with no accounts dir yet (no record written) still records the
  // pass, so a sign-in made after it is never flagged by the identity pass.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, path);
}

/**
 * The production move-aside: under `.recovery.lock` (only when the
 * machine-global folder exists, because taking it creates that folder) →
 * native `.oauth_refresh.lock` → native `.storage-write.lock` on the folder
 * that holds the file, re-read the file and, if it still holds the `~/.claude`
 * token, rename it to `.credentials.json.host-chain-shared-<stamp>`. Never
 * copies or deletes. Throws `FileLockTimeoutError` when a lock is busy.
 */
export async function moveAsideUnderLocks(args: {
  uuid: string;
  path: string;
  machineGlobal: boolean;
  machineGlobalFolderExists: boolean;
  hostFingerprint: string;
  stamp: string;
}): Promise<MoveAsideResult> {
  const dir = dirname(args.path);
  const body = async (): Promise<MoveAsideResult> => {
    let raw: string;
    try {
      raw = await readFile(args.path, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
      throw err;
    }
    let token: unknown;
    try {
      token = (
        JSON.parse(raw) as { claudeAiOauth?: { refreshToken?: unknown } }
      ).claudeAiOauth?.refreshToken;
    } catch {
      return "changed";
    }
    if (
      typeof token !== "string" ||
      !token ||
      refreshTokenFingerprint(token) !== args.hostFingerprint
    ) {
      return "changed";
    }
    let target = `${args.path}${MOVED_ASIDE_SUFFIX}${args.stamp}`;
    for (let n = 2; await exists(target); n++) {
      target = `${args.path}${MOVED_ASIDE_SUFFIX}${args.stamp}-${n}`;
    }
    await rename(args.path, target);
    return "moved";
  };
  const native = (): Promise<MoveAsideResult> =>
    withNativeRefreshLock(
      dir,
      () =>
        withNativeStorageWriteLock(
          dir,
          body,
          MOVE_ASIDE_NATIVE_LOCK_BUDGETS.storageWrite
        ),
      MOVE_ASIDE_NATIVE_LOCK_BUDGETS.refresh
    );
  if (args.machineGlobalFolderExists) {
    return withAccountCredentialLock(
      args.uuid,
      RECOVERY_LOCK_NAME,
      native,
      MOVE_ASIDE_LOCK_BUDGETS
    );
  }
  return native();
}

/** True for a lock that was busy: skip the account for this pass. */
function isLockTimeout(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  return (
    name === "FileLockTimeoutError" || name === "AccountStoreLockTimeoutError"
  );
}

/** A flag write that failed; logged and reported where it failed. */
class FlagWriteFailed extends Error {
  constructor() {
    super("shared-chain quarantine flag not written");
    this.name = "FlagWriteFailed";
  }
}

/**
 * Report each live, older sibling daemon once per (home, pid, version), and
 * return how many there are.
 */
async function findOlderLiveSiblings(
  deps: HostChainQuarantineDeps,
  report: (r: QuarantineReport) => void,
  reported: Map<string, string>
): Promise<number> {
  const states = await deps.listSiblingDaemonStates();
  const now = deps.now();
  let count = 0;
  for (const s of states) {
    // A daemon with no heartbeat field (built before 1.0.1498, or still in its
    // first heartbeat interval) counts as live while its pid is: it may still
    // run the CredentialsWatcher, so the safe side is "flag only".
    const live =
      deps.isPidAlive(s.pid) &&
      (s.lastHeartbeatAt === null ||
        now - s.lastHeartbeatAt <= SIBLING_HEARTBEAT_STALE_MS);
    if (!live) continue;
    if (!isOlderSiblingVersion(s.startedWithCliVersion, deps.ownVersion)) {
      continue;
    }
    count++;
    const version = s.startedWithCliVersion ?? "unknown";
    const key = `sibling:${s.instanceHome}:${s.pid}`;
    if (reported.get(key) === version) continue;
    reported.set(key, version);
    logger.warn(
      `[ACCOUNTS] an older Hapimatic daemon is live on this machine (${s.instanceHome}, pid ${s.pid}, ${version} < ${deps.ownVersion}); the shared-chain detector flags only and moves no file until it is updated or stopped`
    );
    report({
      message: "older Hapimatic daemon live on this machine",
      category: "accounts",
      severity: "warn",
      context: JSON.stringify({
        instanceHome: s.instanceHome,
        pid: s.pid,
        version,
        ownVersion: deps.ownVersion,
      }),
    });
  }
  return count;
}

/**
 * One detector pass (see the module doc). Never throws: a failure on one
 * account is logged, and the pass moves on to the next.
 */
export async function runHostChainQuarantine(
  deps: HostChainQuarantineDeps
): Promise<HostChainQuarantineSummary> {
  const summary: HostChainQuarantineSummary = {
    skipped: null,
    flagged: [],
    moved: [],
    kept: [],
    olderSiblingDaemons: 0,
    markerWritten: false,
  };
  const report = deps.report ?? defaultReport;
  const reported = deps.reported ?? reportedFindings;
  const readToken = deps.readRefreshToken ?? readRefreshTokenAt;
  const moveAside = deps.moveAside ?? moveAsideUnderLocks;
  const readMarker =
    deps.readMarker ?? (() => defaultReadMarker(deps.identityPassMarkerPath));
  const readFolderSignIn = deps.readSignInMarker ?? readSignInMarkerIn;
  const writeMarker =
    deps.writeMarker ??
    ((m: IdentityPassMarker) =>
      defaultWriteMarker(deps.identityPassMarkerPath, m));

  let hostFp: string | null;
  let uuids: string[];
  let olderSiblings: number;
  // The identity pass: null = done (or skipped this pass), else its target.
  let identity: { target: string | null } | null = null;
  try {
    hostFp = await deps.readHostRefreshFingerprint();
    if (!hostFp) {
      // No `~/.claude` login, so no second refresher: nothing to quarantine.
      // The identity pass waits for a pass with a host login (no marker).
      summary.skipped = "no-host-login";
      return summary;
    }
    olderSiblings = await findOlderLiveSiblings(deps, report, reported);
    summary.olderSiblingDaemons = olderSiblings;
    if (!(await readMarker())) {
      const named = await deps.readHostNamedUuid();
      if (named !== "unreadable") identity = { target: named };
    }
    uuids = await deps.listAccountUuids();
    // The identity target is checked even when the list misses it (a corrupt
    // index lists nothing): getAccount reads the record file itself.
    const target = identity?.target;
    if (target && !uuids.includes(target)) uuids = [...uuids, target];
  } catch (err) {
    logger.warn(
      `[ACCOUNTS] shared-chain pass skipped: ${err instanceof Error ? err.message : String(err)}`
    );
    summary.skipped = "error";
    return summary;
  }

  let everyMergeOk = true;
  // The marker is written only once the identity target was read to a definite
  // outcome (its record, or none), never after a throw for it (#6800 review).
  let identityChecked = identity === null || identity.target === null;
  const checkAccount = async (uuid: string): Promise<void> => {
    const account = await deps.getAccount(uuid);
    if (!account || isEnvTokenAccount(account) || !account.refreshToken) {
      return;
    }
    const ownToken = account.refreshToken;
    const storeFp = refreshTokenFingerprint(ownToken);
    const storeMatch = storeFp === hostFp;
    const paths = await deps.credentialPaths(uuid);
    const machineGlobalPath = paths[0];
    const folderMatches: string[] = [];
    let machineGlobalToken: string | null = null;
    for (const [i, path] of paths.entries()) {
      const token = await readToken(path);
      if (i === 0) machineGlobalToken = token;
      if (token && refreshTokenFingerprint(token) === hostFp) {
        folderMatches.push(path);
      }
    }
    // Issue #6837 (R7): the host-named account is exempt only when its folder
    // holds a token that is not the host's AND a Provider Accounts sign-in
    // produced it (the sign-in marker names it). The marker is read only for the
    // identity target, from the folder that holds `machineGlobalToken`.
    const isIdentityTarget = identity !== null && identity.target === uuid;
    const folderSignedIn =
      isIdentityTarget &&
      machineGlobalToken !== null &&
      machineGlobalPath !== undefined &&
      signInMarkerNamesToken(
        await readFolderSignIn(dirname(machineGlobalPath)),
        machineGlobalToken
      );
    const identityFlag =
      isIdentityTarget &&
      !(
        machineGlobalToken !== null &&
        refreshTokenFingerprint(machineGlobalToken) !== hostFp &&
        folderSignedIn
      );
    const shouldFlag = storeMatch || identityFlag;
    const alreadyFlagged =
      account.unrefreshable === true &&
      account.unrefreshableReason === HOST_CHAIN_SHARED_REASON &&
      account.unrefreshableTokenFingerprint === storeFp;

    if (!shouldFlag && folderMatches.length === 0) return;

    // (a) Flag first (invariant I5), only for a store match or the identity
    // pass. Re-checked inside the merge: a sign-in that landed since the read
    // wrote an independent token, which must not be flagged.
    const flag = { now: false };
    if (shouldFlag && !alreadyFlagged) {
      try {
        await deps.mergeStore(uuid, current => {
          const token = current.refreshToken;
          if (!token) return current;
          const stillShared = storeMatch
            ? refreshTokenFingerprint(token) === hostFp
            : token === ownToken;
          if (!stillShared) return current;
          flag.now = true;
          return {
            ...current,
            unrefreshable: true,
            unrefreshableReason: HOST_CHAIN_SHARED_REASON,
            unrefreshableTokenFingerprint: refreshTokenFingerprint(token),
          };
        });
      } catch (err) {
        everyMergeOk = false;
        const message = err instanceof Error ? err.message : String(err);
        const failKey = `flag-failed:${uuid}`;
        if (reported.get(failKey) !== message) {
          reported.set(failKey, message);
          logger.warn(
            `[ACCOUNTS] shared-chain pass: the quarantine flag for ${uuid} was not written (${message}); retried next pass, and every point of use still refuses the current ~/.claude token`
          );
          report({
            message: "shared-chain quarantine flag not written",
            category: "accounts",
            severity: "warn",
            context: JSON.stringify({ accountUuid: uuid, error: message }),
          });
        }
        throw new FlagWriteFailed();
      }
      if (flag.now) summary.flagged.push(uuid);
    }

    // (b)/(c) Move each matching folder file, never nested in the merge.
    const moved: string[] = [];
    let state: string;
    if (folderMatches.length === 0) {
      state = "no folder file";
    } else if (olderSiblings > 0) {
      state = "kept: older daemon live";
    } else if (deps.flagOnly) {
      state = "kept: boot pass flags only";
    } else if (await deps.isBound(uuid)) {
      state = "kept: live session";
    } else {
      const machineGlobalFolderExists =
        machineGlobalPath !== undefined &&
        (await exists(dirname(machineGlobalPath)));
      const stamp = moveAsideStamp(deps.now());
      for (const path of folderMatches) {
        const result = await moveAside({
          uuid,
          path,
          machineGlobal: path === machineGlobalPath,
          machineGlobalFolderExists,
          hostFingerprint: hostFp,
          stamp,
        });
        if (result === "moved") moved.push(path);
      }
      state = moved.length > 0 ? `moved ${moved.join(", ")}` : "unchanged";
    }
    summary.moved.push(...moved);
    if (state.startsWith("kept")) summary.kept.push(uuid);

    // (d) One warn line and one report per account per new finding and state.
    // "Already handled" (flag in place, no matching file) logs nothing.
    if (!flag.now && moved.length === 0 && folderMatches.length === 0) {
      return;
    }
    // A record flagged on an earlier pass is quarantined, not independent,
    // whatever this pass matched (#6800 closer review).
    const quarantined =
      account.unrefreshable === true &&
      account.unrefreshableReason === HOST_CHAIN_SHARED_REASON;
    const finding = storeMatch
      ? "store"
      : identityFlag
        ? "identity"
        : quarantined
          ? "quarantined"
          : "folder";
    const key = `account:${uuid}`;
    const value = `${hostFp}|${finding}|${state}`;
    if (reported.get(key) === value) return;
    reported.set(key, value);
    const who = `${uuid} (${account.emailAddress ?? "no email"})`;
    if (finding === "folder") {
      logger.warn(
        `[ACCOUNTS] the folder of ${who} shares the ~/.claude login chain (host ${fp8(hostFp)}) — ${state}; its store record is independent, so the next spawn re-seeds the folder`
      );
    } else {
      logger.warn(
        `[ACCOUNTS] ${who} shares the ~/.claude login chain — quarantined; re-login required (host ${fp8(hostFp)}, store ${fp8(storeFp)}, ${finding === "identity" ? "the account ~/.claude.json names" : finding === "quarantined" ? "flagged on an earlier pass" : "store token matches"}; ${state})`
      );
    }
    report({
      message:
        finding === "folder"
          ? "account folder shares the ~/.claude login chain"
          : "account shares the ~/.claude login chain — re-login required",
      category: "accounts",
      severity: "warn",
      context: JSON.stringify({
        accountUuid: uuid,
        finding,
        hostFingerprint: fp8(hostFp),
        storeFingerprint: fp8(storeFp),
        state,
      }),
    });
  };

  for (const uuid of uuids) {
    try {
      await checkAccount(uuid);
      if (identity !== null && identity.target === uuid) identityChecked = true;
    } catch (err) {
      // A failed flag write was logged and reported where it failed.
      if (err instanceof FlagWriteFailed) continue;
      if (isLockTimeout(err)) {
        logger.info(
          `[ACCOUNTS] shared-chain pass: ${uuid} skipped, a credentials lock is busy; retried next pass`
        );
      } else {
        logger.warn(
          `[ACCOUNTS] shared-chain pass: ${uuid}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  if (identity !== null && everyMergeOk && identityChecked) {
    try {
      await writeMarker({
        version: 1,
        completedAt: new Date(deps.now()).toISOString(),
        hostNamedUuid: identity.target,
      });
      summary.markerWritten = true;
    } catch (err) {
      logger.warn(
        `[ACCOUNTS] shared-chain identity marker not written (the identity pass runs again next pass): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return summary;
}

/** The store-side seams a caller supplies; the rest come from this machine. */
export type QuarantineStoreSeams = Pick<
  HostChainQuarantineDeps,
  "listAccountUuids" | "getAccount" | "mergeStore" | "isBound" | "now"
> &
  Partial<HostChainQuarantineDeps>;

/**
 * Production deps: the real host readers, this instance's marker
 * (`<accountsDir>/host-chain-identity-pass.json`), every credentials path of
 * the account on this machine, the sibling `~/.hapimatic-*` daemons, and this
 * build's version. The caller supplies the store seams; anything else it
 * passes overrides the default.
 */
export function productionQuarantineDeps(
  seams: QuarantineStoreSeams
): HostChainQuarantineDeps {
  return {
    readHostRefreshFingerprint: () => readHostRefreshFingerprint(),
    readHostNamedUuid: () => readHostNamedUuid(),
    credentialPaths: uuid => isolatedCredentialPathsAnywhere(uuid),
    identityPassMarkerPath: join(
      configuration.accountsDir,
      IDENTITY_PASS_MARKER_NAME
    ),
    listSiblingDaemonStates: async () =>
      readSiblingDaemonStates(
        await listInstanceHomes(),
        configuration.happyHomeDir
      ),
    ownVersion: CLI_VERSION,
    isPidAlive: isProcessAlive,
    ...seams,
  };
}

/** The slice of `AccountStore` the boot pass needs. */
export interface BootQuarantineStore {
  list(): Promise<AccountIndexEntry[]>;
  get(accountUuid: string): Promise<ValidateAccountResult | null>;
  update(
    accountUuid: string,
    mergeFn: (current: StoredAccount) => StoredAccount
  ): Promise<boolean>;
}

/**
 * The daemon's boot pass (#6800 Task 2): run before the control server starts,
 * when no live-session view exists yet, so it sets `flagOnly` and the pass
 * FLAGS ONLY (it also runs the identity pass and writes its marker). The
 * first maintenance tick, with the real live-session view, moves the files.
 * Never throws.
 */
export async function runBootHostChainQuarantine(
  store: BootQuarantineStore,
  now: () => number = Date.now
): Promise<HostChainQuarantineSummary | null> {
  try {
    return await runHostChainQuarantine(
      productionQuarantineDeps({
        listAccountUuids: async () =>
          (await store.list())
            .filter(e => (e.provider ?? "anthropic") === "anthropic")
            .map(e => e.accountUuid),
        getAccount: async uuid => {
          const res = await store.get(uuid);
          return res && res.ok ? res.account : null;
        },
        mergeStore: async (uuid, mergeFn) => {
          await store.update(uuid, mergeFn);
        },
        isBound: async () => true,
        flagOnly: true,
        now,
      })
    );
  } catch (err) {
    logger.warn(
      `[ACCOUNTS] shared-chain boot pass failed (continuing): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}
