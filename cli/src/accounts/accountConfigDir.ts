// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { StoredAccount } from "@hapi/protocol/accounts";
import {
  REPAIRABLE_FILE_DIMS,
  USER_SCOPE_CONFIG_DIMS,
} from "@hapi/protocol/accountConfigDims";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import { InvalidAccountUuidError, UUID_REGEX } from "@/accounts/accountStore";
import {
  NATIVE_LOCK_BUDGETS,
  withNativeRefreshLock,
  withNativeStorageWriteLock,
  type NativeLockBudgetSet,
} from "@/accounts/nativeCredentialLock";

/**
 * Per-account isolated config dirs (issue #1551 — the #1546 Path A true-fix).
 *
 * Hapimatic binds one Anthropic account per session. The original mechanism
 * (#1446) injected `CLAUDE_CODE_OAUTH_TOKEN` into the native `claude` child,
 * which BYPASSES Claude Code's own auto-refresh — so Hapimatic had to own
 * refresh, and a non-host account's stored refresh token froze and got revoked
 * server-side once it lost host-default status (#1546 Tier-1: rotating refresh
 * tokens with per-account revocation), producing `HTTP 400 invalid_grant`.
 *
 * This module gives each NON-host account its own config dir at
 * `<accountConfigsDir>/<uuid>/` holding `.credentials.json` (tokens) and
 * `.claude.json` (identity). A native `claude` spawned with
 * `CLAUDE_CONFIG_DIR=<that-dir>` reads AND rotates the account's token there
 * (native `utils/secureStorage/plainTextStorage.ts` → `getClaudeConfigHomeDir()`
 * on Linux), making native Claude Code the SOLE owner/rotator per account —
 * generalizing #1520's host-default deferral to every account. Because
 * revocation is per-account, isolated accounts never cross-kill.
 *
 * Security: `accountUuid` becomes a path component, so every public function
 * gates it through {@link UUID_REGEX} before any `join` (path-traversal
 * defense, reused from `accountStore.ts`). Token VALUES never reach the logger.
 */

/**
 * The `claudeAiOauth` slice native Claude Code reads from `.credentials.json`.
 * Field set mirrors the host's `~/.claude/.credentials.json` `claudeAiOauth`
 * exactly (accessToken, refreshToken, expiresAt, scopes, subscriptionType,
 * rateLimitTier). `mcpOAuth` is intentionally NEVER written (parity with
 * `CredentialsWatcher` R8).
 */
export interface IsolatedClaudeAiOauth {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
  rateLimitTier: string;
}

/** Shape of the isolated `.credentials.json` file native reads on Linux. */
interface IsolatedCredentialsFile {
  claudeAiOauth?: IsolatedClaudeAiOauth;
}

/**
 * Absolute path to an account's isolated config dir. Gates `accountUuid`
 * through {@link UUID_REGEX} first (it becomes a directory name).
 */
export function accountConfigDirFor(accountUuid: string): string {
  if (!UUID_REGEX.test(accountUuid)) {
    throw new InvalidAccountUuidError(accountUuid);
  }
  return join(configuration.accountConfigsDir, accountUuid);
}

/** Path to the isolated `.credentials.json` for an account. */
function isolatedCredentialsPath(accountUuid: string): string {
  return join(accountConfigDirFor(accountUuid), ".credentials.json");
}

/**
 * Path to the isolated `.claude.json` (identity) for an account.
 *
 * Exported (issue #2364) so the spawn-time HAPI scrub
 * ({@link scrubHapiFromDisabledMcps}) can target the SAME file Claude Code reads
 * under `CLAUDE_CONFIG_DIR` account binding — reuse this single-source helper
 * rather than re-joining the path. Gates `accountUuid` through {@link UUID_REGEX}
 * via {@link accountConfigDirFor}.
 */
export function isolatedConfigPath(accountUuid: string): string {
  return join(accountConfigDirFor(accountUuid), ".claude.json");
}

/**
 * True when the account already has an isolated config dir that native Claude
 * Code owns (i.e. its `.credentials.json` exists). The presence of this file is
 * the single-owner signal: once present, native owns rotation and Hapimatic
 * MUST NOT overwrite it (except the deliberate host-capture re-seed in
 * {@link CredentialsWatcher} while the account is host-default).
 */
export async function hasIsolatedConfigDir(
  accountUuid: string
): Promise<boolean> {
  try {
    await readFile(isolatedCredentialsPath(accountUuid), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Cache for the enumerated instance-home list used by
 * {@link isIsolatedAccountAnywhere}. The scheduler calls the predicate once per
 * account per tick; re-scanning the home dir for every account would put a
 * readdir on a hot path (non-trivial on CIFS-hosted homes). 30s TTL — instance
 * homes appear/disappear on worktree create/delete, which is minutes-scale.
 */
let instanceHomesCache: { homes: string[]; at: number } | null = null;
const INSTANCE_HOMES_CACHE_TTL_MS = 30_000;

/**
 * True when the account is isolated ANYWHERE this machine's schedulers must
 * respect — so Hapimatic's `TokenRefreshService` defers rotation to native.
 *
 * Issue #1643 (KD-6 Option A — STAGED retirement): this predicate is now
 * SHARED-FIRST. {@link hasIsolatedConfigDir} checks
 * `configuration.accountConfigsDir`, which post-#1643 is the machine-global
 * SHARED base (`~/.config/hapimatic/account-configs`) — so once the account is
 * migrated to the shared dir, the FIRST check returns true and the single shared
 * dir is the one owner. The subsequent `~/.hapimatic-*` instance-home scan is a
 * TRANSITIONAL deprecation-window fallback (R6): during a rolling deployment an
 * un-upgraded sibling instance on the old binary still rotates its OWN
 * per-instance `~/.hapimatic-<instance>/account-configs/<uuid>` dir, so this scan must
 * keep deferring on a legacy-dir-only holder until the migration sweep (#1643
 * Task 9) confirms zero legacy dirs. AFTER the sweep, this whole machine-global
 * scan can be retired and the predicate collapses to {@link hasIsolatedConfigDir}
 * (the single shared dir makes the cross-instance race structurally impossible).
 * Under the `HAPI_ACCOUNT_CONFIG_SHARED=0` kill-switch, `hasIsolatedConfigDir`
 * reverts to checking this instance's `<HAPI_HOME>/account-configs` and the scan
 * stays load-bearing — i.e. exact pre-#1643 (#1635 machine-global) behavior.
 *
 * Issue #1635 (R2) — original machine-global rationale: every instance's isolated
 * dir + store copy shared ONE Anthropic refresh-token family per account. The
 * pre-#1635 LOCAL deferral let a sibling instance's `TokenRefreshService`
 * proactively rotate a family this instance had isolated, superseding (and
 * server-side revoking) the isolated snapshot — the #1635 401-on-spawn. Deferral
 * must therefore cover every holder: if anyone isolates the account, NO scheduler
 * rotates it. #1643 makes "every holder" converge on ONE shared dir.
 *
 * Over-deferral is BENIGN: an orphaned/trashed instance's leftover dir makes
 * every scheduler defer, so the token drifts to natural expiry — which the
 * spawn-time recovery path (`isolatedSnapshotRecovery.ts`, #1635 R1) self-heals
 * at the next spawn. The inverse failure (under-deferral → live revocation
 * race) is the one that must never happen.
 *
 * Cross-MACHINE residual (documented, out of scope): the family is an Anthropic
 * server-side construct; the same account live on two machines (rp1 vs rp2/sl7)
 * cannot be coordinated by any filesystem check. See issue #1635 KD-5.
 *
 * Enumeration is prefix-bound (`.hapimatic-*` directly under the home dir) —
 * never a generic glob. The `opts.homeDir` seam exists for tests; passing it
 * bypasses the cache so fixtures never leak across tests.
 */
export async function isIsolatedAccountAnywhere(
  accountUuid: string,
  opts: { homeDir?: string } = {}
): Promise<boolean> {
  if (!UUID_REGEX.test(accountUuid)) {
    throw new InvalidAccountUuidError(accountUuid);
  }

  // Shared dir first (#1643) — cheap; this is the single machine-global owner
  // once migrated. Under the kill-switch it is this instance's per-instance dir.
  if (await hasIsolatedConfigDir(accountUuid)) return true;

  // Transitional legacy fallback (#1643 R6): scan sibling ~/.hapimatic-*
  // per-instance dirs for an un-migrated holder. Removable post-sweep (Task 9).

  const home = opts.homeDir ?? homedir();
  let homes: string[];
  const cacheable = opts.homeDir === undefined;
  if (
    cacheable &&
    instanceHomesCache &&
    Date.now() - instanceHomesCache.at < INSTANCE_HOMES_CACHE_TTL_MS
  ) {
    homes = instanceHomesCache.homes;
  } else {
    const entries = await readdir(home, { withFileTypes: true }).catch(
      () => []
    );
    homes = entries
      .filter(e => e.isDirectory() && e.name.startsWith(".hapimatic-"))
      .map(e => join(home, e.name));
    if (cacheable) {
      instanceHomesCache = { homes, at: Date.now() };
    }
  }

  for (const instanceHome of homes) {
    try {
      await readFile(
        join(instanceHome, "account-configs", accountUuid, ".credentials.json"),
        "utf-8"
      );
      return true;
    } catch {
      // not isolated in this instance — keep scanning
    }
  }
  return false;
}

/** Atomic 0600 write (tmp + chmod + rename) — mirrors `accountStore.put`. */
async function atomicWrite600(path: string, body: string): Promise<void> {
  const tmpPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  await writeFile(tmpPath, body, { mode: 0o600 });
  await chmod(tmpPath, 0o600).catch(() => {});
  await rename(tmpPath, path);
}

/**
 * Issue #5020 (R7): one line per Hapimatic write of an isolated credentials
 * file, so a soak can attribute every chain change. Carries the writer, the
 * account, the first 8 hex of the refresh token's SHA-256 (the
 * `refreshTokenFingerprint` digest) and the expiry — never a token value.
 */
function logIsolatedWrite(
  writer: string,
  accountUuid: string,
  refreshToken: string,
  expiresAt: number
): void {
  const fp = createHash("sha256")
    .update(refreshToken)
    .digest("hex")
    .slice(0, 8);
  const exp =
    Number.isFinite(expiresAt) && expiresAt > 0
      ? new Date(expiresAt).toISOString()
      : String(expiresAt);
  logger.info(
    `[ISOLATED_WRITE] writer=${writer} uuid=${accountUuid} refresh=${fp} expiresAt=${exp}`
  );
}

/**
 * User-scope config dimensions Claude Code reads off `CLAUDE_CONFIG_DIR`
 * (issue #1562). #1551 isolated a non-host session's config root but only seeded
 * `.claude.json` + `.credentials.json`, orphaning everything else — custom skills,
 * commands, agents, plugins, user `CLAUDE.md` (+ `@`-includes), `rules/`,
 * `settings.json` (hooks + permissions), and session transcripts (`projects/`).
 * {@link provisionUserScopeConfigDir} restores them by symlinking each dim back to
 * the host `~/.claude`.
 *
 * `.claude.json` and `.credentials.json` are deliberately ABSENT from this list:
 * native writes the bound account's identity + rotated token to them, so they stay
 * real per-account files (symlinking `.claude.json` would overwrite the host's
 * `oauthAccount` — catastrophic).
 *
 * The list itself + its per-dimension host-path mapping live in
 * `@hapi/protocol/accountConfigDims` (#3246), so this bridge AND the server-side
 * post-import visibility probe (`server/src/porter/visibilityProbe.ts`) import ONE
 * authority — a divergence would silently misclassify a dimension. Re-exported here
 * for API stability (imported at the top of this file for the loop below).
 */
export { USER_SCOPE_CONFIG_DIMS };

/** Per-dimension outcome of {@link provisionUserScopeConfigDir}. */
export interface ProvisionResult {
  /** Dims now correctly symlinked (created, re-pointed, or already correct). */
  linked: string[];
  /** Dims skipped because the host source does not exist (legitimate absence). */
  skipped: string[];
  /**
   * Dims left untouched because `$CONFIG/<dim>` is a real file/dir (or a
   * wrong-target symlink), not the host symlink. Caller should fall back to the
   * env-token path — native would otherwise read stale/wrong data for that
   * dimension (e.g. a stale real `projects` orphaning transcripts; #1574).
   */
  conflicts: string[];
  /** Dims that hit a real filesystem error (caller should fall back). */
  failed: string[];
  /**
   * Dims whose real regular file was byte-identical to the host source and was
   * replaced by the managed symlink (#4681). Also counted in `linked`.
   */
  repaired: string[];
}

/**
 * True when `dst` is a regular file at a repairable file dim whose bytes equal the
 * host source `src` (followed through links). Such a file is a stray copy — e.g. the
 * result of `sed -i` on the managed symlink (#4681) — so replacing it loses nothing.
 */
async function isByteIdenticalCopy(
  dim: string,
  src: string,
  dst: string
): Promise<boolean> {
  if (!(REPAIRABLE_FILE_DIMS as readonly string[]).includes(dim)) return false;
  if (!(await stat(src)).isFile()) return false;
  const [copy, host] = await Promise.all([readFile(dst), readFile(src)]);
  return copy.equals(host);
}

/**
 * Symlink the host's user-scope config dimensions into an isolated account config
 * dir (issue #1562 — the durable fix that lets #1551 isolation be safely
 * re-enabled). Idempotent; safe to run on EVERY spawn.
 *
 * Per-dim semantics:
 *  - host source absent → `skipped` (no error, no broken link — R2).
 *  - `$CONFIG/<dim>` absent → create the symlink (`linked`).
 *  - `$CONFIG/<dim>` already a symlink to the host source → no-op (`linked`).
 *  - `$CONFIG/<dim>` a symlink to the WRONG target → re-point (`linked`).
 *  - `$CONFIG/<dim>` a REAL regular file at a repairable file dim (`CLAUDE.md`,
 *    `settings.json`) whose bytes equal the host source → a stray copy (e.g. `sed -i`
 *    renamed a temp file over the link, #4681); replace it with the symlink
 *    (`linked` + `repaired`). Nothing is lost because the bytes are identical.
 *  - `$CONFIG/<dim>` any other REAL file/dir → never clobber user data; log + `conflicts` (R3).
 *  - a real FS error on any dim → `failed` (the caller returns null → env-token
 *    fallback per the Fallback Preservation Rule — R5).
 *
 * Throws ONLY when `configDir` is not under {@link configuration.accountConfigsDir}
 * (a mis-call guard — provisioning must never touch paths outside the isolated root).
 */
export async function provisionUserScopeConfigDir(
  configDir: string,
  opts: { hostClaudeDir?: string } = {}
): Promise<ProvisionResult> {
  const result: ProvisionResult = {
    linked: [],
    skipped: [],
    conflicts: [],
    failed: [],
    repaired: [],
  };

  // Mis-call / traversal guard: only ever provision INSIDE the account-configs root.
  const root = configuration.accountConfigsDir;
  if (configDir !== root && !configDir.startsWith(`${root}/`)) {
    throw new Error(
      `provisionUserScopeConfigDir refusing to operate outside accountConfigsDir: ${configDir}`
    );
  }

  const hostClaudeDir = opts.hostClaudeDir ?? join(homedir(), ".claude");
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  for (const dim of USER_SCOPE_CONFIG_DIMS) {
    const src = join(hostClaudeDir, dim);
    const dst = join(configDir, dim);
    try {
      // Host source must exist; a legitimately-absent dim is skipped cleanly (R2).
      const srcExists = await lstat(src).then(
        () => true,
        () => false
      );
      if (!srcExists) {
        result.skipped.push(dim);
        continue;
      }

      const existing = await lstat(dst).then(
        s => s,
        () => null
      );

      if (existing === null) {
        try {
          await symlink(src, dst);
          result.linked.push(dim);
        } catch (err) {
          // Concurrent-spawn race: another session created the link first.
          if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            const tgt = await readlink(dst).catch(() => null);
            if (tgt === src) result.linked.push(dim);
            else result.conflicts.push(dim);
          } else {
            throw err;
          }
        }
      } else if (existing.isSymbolicLink()) {
        const tgt = await readlink(dst).catch(() => null);
        if (tgt === src) {
          result.linked.push(dim); // already correct — idempotent no-op
        } else {
          await unlink(dst);
          await symlink(src, dst);
          result.linked.push(dim); // re-pointed a stale/wrong symlink
        }
      } else if (
        existing.isFile() &&
        (await isByteIdenticalCopy(dim, src, dst))
      ) {
        // #4681: a regular file byte-identical to the host source is a stray copy
        // of the managed link (an in-place editor renamed a temp file over it).
        // Replace it with the link; the identical bytes mean nothing is lost.
        await unlink(dst);
        try {
          await symlink(src, dst);
        } catch (err) {
          // Concurrent-spawn race: another session restored the link first.
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          const tgt = await readlink(dst).catch(() => null);
          if (tgt !== src) {
            result.conflicts.push(dim);
            continue;
          }
        }
        logger.warn(
          `[ACCOUNT_CONFIG_DIR] repaired ${dim} at ${dst}: a regular file byte-identical to ${src} replaced the managed symlink; restored the symlink`
        );
        result.linked.push(dim);
        result.repaired.push(dim);
      } else {
        // dst exists as a REAL file/dir that is not a byte-identical copy — never
        // clobber user data (R3).
        logger.warn(
          `[ACCOUNT_CONFIG_DIR] refusing to clobber real ${dim} at ${dst} (content differs from ${src}, or not a regular file); replace it with a symlink to ${src} to restore isolation. Do NOT delete the account dir: it holds the account's credentials.`
        );
        result.conflicts.push(dim);
      }
    } catch (err) {
      result.failed.push(dim);
      logger.warn(
        `[ACCOUNT_CONFIG_DIR] provisioning ${dim} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logger.debug(
    `[ACCOUNT_CONFIG_DIR] provisioned ${configDir}: linked=${result.linked.length} skipped=${result.skipped.length} conflicts=${result.conflicts.length} failed=${result.failed.length}`
  );
  return result;
}

/**
 * Build the isolated `.claude.json` for a bound account (#1551 patch).
 *
 * A non-host session's `claude` reads its ENTIRE config — `mcpServers`,
 * `projects`/trust, `numStartups`, onboarding flags — from
 * `$CLAUDE_CONFIG_DIR/.claude.json`. A minimal stub (identity + onboarding flags
 * only) crashes the session on its first message (zero MCP servers, no project
 * entry). So we deep-copy the host `~/.claude.json` (the known-good machine config
 * that runs sessions today) and override only the account identity:
 *
 *  - `oauthAccount` ← the BOUND account (kept consistent with the isolated
 *    `.credentials.json` token — both are this account).
 *  - `userID` is STRIPPED (it is the host account's Anthropic user id; native
 *    re-derives the bound account's from its credentials/profile — never carry a
 *    cross-account identity).
 *  - onboarding-completeness fields are force-set so the session never first-run
 *    prompts: `hasCompletedOnboarding`, `hasTrustDialogAccepted`, `theme`,
 *    `numStartups ≥ 1`.
 *
 * The host config's `mcpServers` carry the USER servers (serena, tavily, …); the
 * Hapimatic `hapi` MCP is injected separately at spawn, so it is fine that the
 * host config does not list it. Token VALUES never live in `.claude.json` (they
 * are in `.credentials.json`), so the deep copy carries no OAuth secret. If the
 * host config is unreadable, fall back to the minimal identity config (degraded —
 * the session may still lack MCP servers, but seeding never fails the spawn).
 */
async function buildIsolatedClaudeJson(
  account: StoredAccount,
  hostClaudeConfigPath: string
): Promise<Record<string, unknown>> {
  const identity = {
    accountUuid: account.accountUuid,
    emailAddress: account.emailAddress,
    organizationUuid: account.organizationUuid,
    organizationName: account.organizationName,
    displayName: account.displayName,
    billingType: account.billingType,
  };

  let base: Record<string, unknown> = {};
  try {
    base = JSON.parse(await readFile(hostClaudeConfigPath, "utf-8")) as Record<
      string,
      unknown
    >;
  } catch (err) {
    logger.warn(
      `[ACCOUNT_CONFIG_DIR] host ~/.claude.json unreadable; seeding minimal config for ${account.accountUuid} (session may lack MCP servers): ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Drop the host account's identity fields before overriding (never carry a
  // cross-account user id into the bound account's dir).
  delete base.userID;
  delete base.oauthAccount;

  const existingStartups =
    typeof base.numStartups === "number" && base.numStartups > 0
      ? (base.numStartups as number)
      : 1;

  return {
    ...base,
    oauthAccount: identity,
    hasCompletedOnboarding: true,
    hasTrustDialogAccepted: true,
    theme: typeof base.theme === "string" ? base.theme : "dark",
    numStartups: existingStartups,
  };
}

/**
 * Seed (or refresh) an account's isolated config dir from a {@link StoredAccount}.
 *
 * Writes `.credentials.json` (tokens native reads + rotates) and a minimal
 * `.claude.json` (identity + onboarding/trust flags so native never first-run
 * prompts — `interactiveHelpers.tsx` gates onboarding on `theme` +
 * `hasCompletedOnboarding`, and `TrustDialog` on `hasTrustDialogAccepted`).
 *
 * `overwrite` is the single-owner safety valve:
 *  - `overwrite: false` — bootstrap only. Seeds ONLY when `.credentials.json` is
 *    absent; a no-op (returns `false`) when native already owns the dir, so a
 *    stale store token can never clobber native's freshly-rotated one. This is
 *    the launcher's just-in-time seed path.
 *  - `overwrite: true` — the deliberate host-capture re-seed (CredentialsWatcher),
 *    valid ONLY while the account is host-default (no isolated session rotates
 *    it, so there is no live owner to race). Keeps the dir warm for the moment
 *    the account later loses host status.
 *
 * Issue #5020: the `.credentials.json` write joins native Claude Code's lock
 * protocol (`nativeCredentialLock.ts`) — always under native's storage-write
 * lock, and an `overwrite: true` seed also under native's refresh lock, so it
 * can never replace a pair a native refresh is about to save (or present). The
 * `overwrite: false` check is repeated under the lock: native may have written
 * the file since the first check. `skipIfOnDiskNewer` (the host-capture
 * re-seed) leaves a file whose `expiresAt` is newer than the seed's pair alone —
 * native already rotated past it.
 *
 * Returns `true` when it wrote, `false` when it skipped (already seeded with
 * `overwrite:false`, or a newer pair on disk under `skipIfOnDiskNewer`). Throws
 * on a missing token (a record cannot be seeded without an access+refresh
 * token) and on a native-lock timeout (`FileLockTimeoutError`).
 */
export async function seedAccountConfigDir(
  account: StoredAccount,
  opts: {
    overwrite: boolean;
    hostClaudeConfigPath?: string;
    hostClaudeDir?: string;
    /** Writer tag for the #5020 R7 write log. */
    writer?: string;
    /** Skip when the file on disk holds a newer pair than `account` (#5020). */
    skipIfOnDiskNewer?: boolean;
    /** Test seam; production uses {@link NATIVE_LOCK_BUDGETS}. */
    nativeLockBudgets?: NativeLockBudgetSet;
  }
): Promise<boolean> {
  if (!account.accessToken || !account.refreshToken) {
    throw new Error(
      `Cannot seed isolated config dir for ${account.accountUuid}: missing token(s)`
    );
  }

  if (!opts.overwrite && (await hasIsolatedConfigDir(account.accountUuid))) {
    logger.debug(
      `[ACCOUNT_CONFIG_DIR] seed skipped for ${account.accountUuid} (already owned by native; overwrite=false)`
    );
    return false;
  }

  const dir = accountConfigDirFor(account.accountUuid);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const credentials: IsolatedCredentialsFile = {
    claudeAiOauth: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      scopes: account.scopes,
      subscriptionType: account.subscriptionType,
      rateLimitTier: account.rateLimitTier,
    },
  };

  // A COMPLETE config the isolated session's `claude` can actually launch and run
  // against — deep-copied from the host `~/.claude.json` (so it carries the full
  // `mcpServers`, `projects`/trust, and `numStartups`), with the account identity
  // overridden to the bound account. (#1551 patch: the prior minimal config lacked
  // mcpServers/projects and crashed non-host sessions on first message.)
  const config = await buildIsolatedClaudeJson(
    account,
    opts.hostClaudeConfigPath ?? join(homedir(), ".claude.json")
  );

  const uuid = account.accountUuid;
  const refreshToken = account.refreshToken;
  const budgets = opts.nativeLockBudgets ?? NATIVE_LOCK_BUDGETS;
  const writer =
    opts.writer ?? (opts.overwrite ? "seed-overwrite" : "seed-bootstrap");
  const writeCredentials = () =>
    withNativeStorageWriteLock(
      dir,
      async (): Promise<"written" | "owned" | "newer"> => {
        if (!opts.overwrite && (await hasIsolatedConfigDir(uuid))) {
          return "owned";
        }
        if (opts.skipIfOnDiskNewer) {
          const onDisk = await readIsolatedCredentials(uuid);
          if (onDisk && onDisk.expiresAt > account.expiresAt) return "newer";
        }
        await atomicWrite600(
          isolatedCredentialsPath(uuid),
          JSON.stringify(credentials, null, 2)
        );
        logIsolatedWrite(writer, uuid, refreshToken, account.expiresAt);
        return "written";
      },
      budgets.storageWrite
    );
  const written = opts.overwrite
    ? await withNativeRefreshLock(dir, writeCredentials, budgets.refresh)
    : await writeCredentials();
  if (written === "owned") {
    logger.debug(
      `[ACCOUNT_CONFIG_DIR] seed skipped for ${uuid} (native wrote the credentials first; overwrite=false)`
    );
    return false;
  }
  if (written === "newer") {
    logger.info(
      `[ACCOUNT_CONFIG_DIR] seed skipped for ${uuid}: the isolated credentials on disk are newer than the seed's pair (native already rotated past it)`
    );
    return false;
  }
  await atomicWrite600(
    isolatedConfigPath(uuid),
    JSON.stringify(config, null, 2)
  );

  // Issue #1562: provision the host's user-scope config (skills/commands/agents/
  // plugins/rules/projects/CLAUDE.md/settings.json) into the isolated dir so the
  // bound session loads the user's customizations. Best-effort — provisioning
  // problems are logged inside the helper and never fail the seed (the seed's
  // contract is "never fail the spawn"; the resolve-time caller owns the
  // env-token fallback when provisioning fails).
  await provisionUserScopeConfigDir(dir, {
    hostClaudeDir: opts.hostClaudeDir,
  }).catch(err => {
    logger.warn(
      `[ACCOUNT_CONFIG_DIR] provisioning during seed failed for ${account.accountUuid}: ${err instanceof Error ? err.message : String(err)}`
    );
  });

  logger.debug(
    `[ACCOUNT_CONFIG_DIR] seeded ${account.accountUuid} (email: ${account.emailAddress ? "present" : "absent"}, overwrite: ${opts.overwrite})`
  );
  return true;
}

/**
 * Read an account's isolated `claudeAiOauth` (the live source of truth for a
 * non-host account's tokens — KD-2). Returns `null` when the dir is unseeded or
 * the file is unreadable/malformed. Token values are NEVER logged.
 *
 * Used by the force-refresh harness (#1547, issue #1551 Task 9 Option A) to read
 * the refresh token native owns, and by diagnostics.
 */
export async function readIsolatedCredentials(
  accountUuid: string
): Promise<IsolatedClaudeAiOauth | null> {
  try {
    const raw = await readFile(isolatedCredentialsPath(accountUuid), "utf-8");
    const parsed = JSON.parse(raw) as IsolatedCredentialsFile;
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    return oauth;
  } catch {
    return null;
  }
}

/**
 * The state of an account's isolated `.credentials.json`, as the #5020 mirror
 * needs it — {@link readIsolatedCredentials} collapses every failure to `null`.
 *  - `absent` — no file (the account is not isolated here).
 *  - `readable` — both tokens present.
 *  - `cleared` — the file parses but both tokens are empty: native Claude Code
 *    emptied it after its own refresh failed (`invalid_grant` on the head that
 *    was on disk). Observed on ms1, 2026-10-10: a 271-byte file with empty
 *    tokens and `expiresAt: 0`.
 *  - `malformed` — anything else (unparseable, one token missing, unreadable).
 * Never throws; token values never leave the returned object.
 */
export type IsolatedCredentialsState =
  | { kind: "absent" }
  | { kind: "readable"; oauth: IsolatedClaudeAiOauth; mtimeMs: number }
  | { kind: "cleared"; mtimeMs: number }
  | { kind: "malformed"; mtimeMs: number; detail: string };

export async function readIsolatedCredentialsState(
  accountUuid: string
): Promise<IsolatedCredentialsState> {
  const path = isolatedCredentialsPath(accountUuid);
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
    raw = await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    return {
      kind: "malformed",
      mtimeMs: 0,
      detail: `unreadable: ${(err as NodeJS.ErrnoException).code ?? "error"}`,
    };
  }
  let oauth: Partial<IsolatedClaudeAiOauth> | undefined;
  try {
    oauth = (JSON.parse(raw) as IsolatedCredentialsFile).claudeAiOauth;
  } catch {
    return { kind: "malformed", mtimeMs, detail: "not valid JSON" };
  }
  if (!oauth || typeof oauth !== "object") {
    return { kind: "malformed", mtimeMs, detail: "no claudeAiOauth" };
  }
  const access = oauth.accessToken;
  const refresh = oauth.refreshToken;
  if (!access && !refresh) return { kind: "cleared", mtimeMs };
  if (
    typeof access !== "string" ||
    typeof refresh !== "string" ||
    !access ||
    !refresh
  ) {
    return { kind: "malformed", mtimeMs, detail: "one token missing" };
  }
  return { kind: "readable", oauth: oauth as IsolatedClaudeAiOauth, mtimeMs };
}

/**
 * Write back an account's isolated `claudeAiOauth` (atomic 0600). Used by the
 * Hapimatic rotation (force-refresh harness, idle backstop, spawn-time
 * recovery) to persist the rotated token native will pick up on its next read —
 * keeping the isolated dir the single source of truth and preventing the
 * rotation from diverging from native's view.
 *
 * Issue #5020 (R2, R7): the write holds native's storage-write lock, so it never
 * interleaves with native's read-modify-write save, and logs its writer. A
 * caller that rotates must ALSO hold native's refresh lock around its whole
 * read → refresh → write (`rotateIsolatedCredentials` does). Throws
 * `FileLockTimeoutError` when the lock cannot be taken.
 */
export async function writeIsolatedCredentials(
  accountUuid: string,
  oauth: IsolatedClaudeAiOauth,
  opts: { writer?: string; nativeLockBudgets?: NativeLockBudgetSet } = {}
): Promise<void> {
  const dir = accountConfigDirFor(accountUuid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const credentials: IsolatedCredentialsFile = { claudeAiOauth: oauth };
  await withNativeStorageWriteLock(
    dir,
    () =>
      atomicWrite600(
        isolatedCredentialsPath(accountUuid),
        JSON.stringify(credentials, null, 2)
      ),
    (opts.nativeLockBudgets ?? NATIVE_LOCK_BUDGETS).storageWrite
  );
  logIsolatedWrite(
    opts.writer ?? "rotation",
    accountUuid,
    oauth.refreshToken,
    oauth.expiresAt
  );
}
