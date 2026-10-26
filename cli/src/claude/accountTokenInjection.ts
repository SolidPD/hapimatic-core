// SPDX-License-Identifier: AGPL-3.0-only
import type { Session } from "@/claude/session";
import type { SessionModelMode } from "@/api/types";
import type { ClaudeAccountInfo } from "@hapi/protocol/schemas";
import type {
  StoredAccount,
  ValidateAccountResult,
} from "@hapi/protocol/accounts";
import { isEnvTokenAccount } from "@hapi/protocol/accounts";
import { isQualifiedApiKeyRef } from "@hapi/protocol/apiKeyRef";
import { accountStore } from "@/accounts/accountStore";
import { TokenRefreshService } from "@/accounts/tokenRefreshService";
import {
  computePlanLabel,
  readHostDefaultAccountUuid,
} from "@/utils/claudeCredentials";
import {
  accountConfigDirFor,
  hasIsolatedConfigDir,
  provisionUserScopeConfigDir,
  type ProvisionResult,
  readIsolatedCredentials,
  seedAccountConfigDir,
} from "@/accounts/accountConfigDir";
import { validateAndRecoverIsolatedSnapshot } from "@/accounts/isolatedSnapshotRecovery";
import { readSettings } from "@/persistence";
import { resolveSharedApiKey } from "@/apiKeys/sharedKeyClient";
import {
  readVaultApiKey,
  type VaultKeyEntry,
} from "@/daemon/sessionSpawnerHelpers";
import { rotationLeaseManager } from "@/accounts/rotationLeaseManager";
import {
  migrateLegacyIsolatedDir,
  type LegacyMigrationOutcome,
} from "@/accounts/legacyConfigDirMigration";
import { logger } from "@/ui/logger";
import { isTenantVm, tenantSignInRequiredMessage } from "@/accounts/tenantMode";

/**
 * Multi-account OAuth (epic #1446, Sub-Issue D): per-session account-token
 * resolution + injection for all launcher modes.
 *
 * One Hapimatic session = one CLI process = one bound account. The binding is
 * communicated via `process.env.HAPI_ACCOUNT_UUID` (per-process; same channel as
 * `HAPI_ORIGINATING_NODE_ID` — KD-3). When set, each launcher injects the bound
 * account's `CLAUDE_CODE_OAUTH_TOKEN` into the spawned `claude` process; when
 * absent, the existing host-credential path is preserved verbatim (R2).
 *
 * Security: the resolved token value is NEVER logged at any verbosity. Error
 * messages reference `accountUuid` / `emailAddress` only (OR-3).
 */

/**
 * Refresh-before-expiry window. Mirrors B's `DEFAULT_EXPIRY_BUFFER_MS`
 * (`tokenRefreshService.ts`). The daemon's `TokenRefreshService` scheduler is the
 * PRIMARY proactive refresh; this buffer drives D's near-expiry safety-net
 * refresh for edge cases where the scheduler hasn't run (account just bound, or a
 * session with no daemon scheduler) — KD-6.
 */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * The account UUID this CLI process is bound to, or `null` for the
 * host-credential fallback (R2). The node-default → `HAPI_ACCOUNT_UUID`
 * resolution is the spawner's job (KD-7); D reads only the env var.
 */
export function readBoundAccountUuid(): string | null {
  return process.env.HAPI_ACCOUNT_UUID || null;
}

/**
 * Map a `StoredAccount` (AccountStore record) to the `ClaudeAccountInfo` shape
 * used for the UI plan badge. Used by `sessionFactory` to stamp the BOUND
 * account's identity instead of the host's on-disk default (R4, KD-5).
 */
export function accountInfoFromStored(
  account: StoredAccount
): ClaudeAccountInfo {
  return {
    subscriptionType: account.subscriptionType,
    rateLimitTier: account.rateLimitTier,
    planLabel: computePlanLabel(
      account.subscriptionType,
      account.rateLimitTier
    ),
    email: account.emailAddress,
  };
}

/**
 * Issue #1506: the `--model` value Hapimatic should pin at spawn for a bound
 * account, or `null` when the account's tier does not warrant a pin.
 *
 * Returns the `"opus[1m]"` ALIAS (a raw model string, NOT a `ModelMode`):
 * Claude Code resolves `opus[1m]` to `getDefaultOpusModel() + "[1m]"` — the
 * CURRENT default Opus WITH the 1M-context beta (`utils/model/model.ts`;
 * `utils/model/aliases.ts` lists `opus[1m]` as a first-class alias). Two reasons
 * this is NOT a `ModelMode` and NOT a bare `"opus"`:
 *   1. Bare `"opus"` yields Opus/200k, because Claude Code gates the AUTOMATIC
 *      `[1m]` behind `isMaxSubscriber()` — which the env-token path reports as
 *      `null` (the very bug). The EXPLICIT `[1m]` suffix is honored regardless.
 *   2. The `[1m]` beta cannot be expressed by Hapimatic's `ModelMode` enum
 *      (`default|sonnet|opus`), so the value must travel as a raw `--model`
 *      string. The `opus[1m]` alias (vs a hardcoded `claude-opus-4-8[1m]`) lets
 *      Claude Code track the current Opus id itself — no stale version baked in.
 *
 * Why the pin is needed at all: account binding injects ONLY
 * `CLAUDE_CODE_OAUTH_TOKEN` (see `withAccountToken`); Claude Code's env-token
 * auth reports `subscriptionType: null`, so its Max-default never fires and
 * bound sessions silently fall back to Sonnet 4.6 / 200k.
 */
export function resolveEntitledModel(account: StoredAccount): string | null {
  return account.subscriptionType.toLowerCase() === "max"
    ? ENTITLED_PIN_MODEL
    : null;
}

/**
 * The exact `--model` alias the #1506 entitled pin uses. Exported as the
 * single source of truth for the entitled-pin DISCRIMINATOR (issue #1633):
 * `buildEntitledModelArgs` recognizes an entitled pin by exact match against
 * this value — a `[1m]`-substring check is no longer safe because explicit
 * user selections can now carry the suffix too (`fable[1m]`). If
 * `resolveEntitledModel` ever pins a different alias, this constant moves
 * with it and the discriminator stays correct.
 */
export const ENTITLED_PIN_MODEL = "opus[1m]";

/**
 * Merge `CLAUDE_CODE_OAUTH_TOKEN` into a launcher's `claudeEnvVars`. Pure — returns
 * a new object (or the original `base` when `token` is null), never mutating
 * `base`. Each launcher passes the result as its `claudeEnvVars` spawn argument
 * because `session.claudeEnvVars` is `readonly` (KD-2).
 */
export function withAccountToken(
  base: Record<string, string> | undefined,
  token: string | null
): Record<string, string> | undefined {
  if (!token) return base;
  return { ...(base ?? {}), CLAUDE_CODE_OAUTH_TOKEN: token };
}

/**
 * Issue #1551: merge `CLAUDE_CONFIG_DIR` into a launcher's `claudeEnvVars`. Pure
 * — returns a new object (or the original `base` when `configDir` is null), never
 * mutating `base`. Mirrors {@link withAccountToken}; `CLAUDE_CONFIG_DIR` is the
 * Path-A binding for non-host accounts (native Claude Code reads + rotates the
 * isolated `.credentials.json`). `CLAUDE_CONFIG_DIR` is NOT in
 * `SDK_SIGNAL_ENV_VARS`, so it passes the launcher billing scrub and preserves
 * subscription billing.
 */
export function withAccountConfigDir(
  base: Record<string, string> | undefined,
  configDir: string | null
): Record<string, string> | undefined {
  if (!configDir) return base;
  return { ...(base ?? {}), CLAUDE_CONFIG_DIR: configDir };
}

/**
 * Issue #4568: the node-vault id of the Anthropic API key this CLI process bills
 * to, or `null` for a subscription / host-credential session. Set by the daemon
 * (`HAPI_API_KEY_ID`) for an API-key spawn — the ONE read of the binding, used by
 * every launcher, `sessionFactory` and the account-refresh loop.
 */
export function readBoundApiKeyId(): string | null {
  return process.env.HAPI_API_KEY_ID || null;
}

/**
 * Issue #4568 (D-4568-2 A): the refusal every non-SDK launcher raises for an
 * API-key session — API billing runs on the SDK launcher only.
 */
export const API_KEY_SDK_ONLY_MESSAGE =
  "API-key sessions run on the SDK launcher only — this launcher does not support API billing. Start the session with the SDK launcher.";

/**
 * Issue #4568: the vault REFERENCE an API-key session carries — never key
 * material. The SDK child obtains the key itself, through the `apiKeyHelper` in
 * the per-session `--settings` file (`hapi api-key-helper`), so the key is in no
 * process environment: a hook, the Bash tool or an MCP server cannot inherit it.
 */
export interface ApiKeySessionBinding {
  apiKeyId: string;
  /** The mask recorded at spawn (`HAPI_API_KEY_MASKED`). */
  masked?: string;
  /**
   * Issue #5127: the session tag (`HAPI_SESSION_ID`, set by both spawn arms)
   * the helper fetches a key homed on another node for. Only a qualified ref
   * carries it, so a bare id's binding is unchanged.
   */
  sessionId?: string;
}

/** Issue #4568: this process's API-key binding, or `null` for any other session. */
export function readBoundApiKeyBinding(): ApiKeySessionBinding | null {
  const apiKeyId = readBoundApiKeyId();
  if (!apiKeyId) return null;
  const masked = process.env.HAPI_API_KEY_MASKED || undefined;
  const binding: ApiKeySessionBinding = masked
    ? { apiKeyId, masked }
    : { apiKeyId };
  const sessionId = process.env.HAPI_SESSION_ID || undefined;
  if (sessionId && isQualifiedApiKeyRef(apiKeyId))
    binding.sessionId = sessionId;
  return binding;
}

/** Test seam for {@link verifyApiKeyForSession}. */
export interface ResolveApiKeyDeps {
  /** Defaults to the node vault (`readSettings().apiKeys`). */
  readApiKeys?: () => Promise<VaultKeyEntry[] | undefined>;
  /** Issue #5127: defaults to `resolveSharedApiKey` (a key on another node). */
  resolveShared?: typeof resolveSharedApiKey;
}

/**
 * Issue #4568 (R4): check this session's API-key binding against the node vault
 * at each (re)launch, and return the binding — NEVER the key. `null` when the
 * session is not key-bound. The launcher only needs to know the binding is good;
 * the key itself reaches Claude Code through `apiKeyHelper` (F1: a key in the
 * child's environment is inherited by every hook, the Bash tool and every stdio
 * MCP server, so any `env` print would write it into the transcript).
 *
 * Fails CLOSED with a message that names the key (label / mask, never the key):
 * the id is gone, it no longer names an Anthropic key, or the entry's mask no
 * longer matches the one recorded at spawn (`HAPI_API_KEY_MASKED`). Never falls
 * back to an account or the host login: a client's per-token charges cannot be
 * reversed.
 *
 * Issue #5127: a key homed on another node (a qualified ref) is checked with
 * its home, through this host's server, on every (re)launch. A refusal (the
 * home is offline, the key is no longer shared, its mask changed …) throws the
 * message that names the home, and the launch fails the same way.
 */
export async function verifyApiKeyForSession(
  deps: ResolveApiKeyDeps = {}
): Promise<ApiKeySessionBinding | null> {
  const binding = readBoundApiKeyBinding();
  if (!binding) return null;
  if (isQualifiedApiKeyRef(binding.apiKeyId)) {
    if (!binding.sessionId) {
      logger.warn(
        `[API_KEY] launch refused (no session id) for shared key ref ${binding.apiKeyId}`
      );
      throw new Error(
        "This session has no session id, so its API key from another node cannot be fetched"
      );
    }
    const resolved = await (deps.resolveShared ?? resolveSharedApiKey)({
      ref: binding.apiKeyId,
      ...(binding.masked !== undefined
        ? { expectedMasked: binding.masked }
        : {}),
      sessionId: binding.sessionId,
    });
    if (!resolved.ok) {
      logger.warn(
        `[API_KEY] launch refused (${resolved.code}) for shared key ref ${binding.apiKeyId}`
      );
      throw new Error(resolved.message);
    }
    return binding;
  }
  const apiKeys = await (
    deps.readApiKeys ?? (async () => (await readSettings()).apiKeys)
  )();
  const result = readVaultApiKey({
    apiKeyId: binding.apiKeyId,
    expectedMasked: binding.masked,
    apiKeys,
  });
  if (!result.ok) {
    logger.warn(
      `[API_KEY] launch refused (${result.code}) for vault key id ${binding.apiKeyId}`
    );
    throw new Error(result.message);
  }
  return binding;
}

/**
 * Issue #1551 (the #1546 Path-A true-fix): resolve the isolated `CLAUDE_CONFIG_DIR`
 * to spawn this session's bound NON-host account into, or `null` to fall through
 * to the env-token path ({@link resolveAccountTokenForSession}).
 *
 * 🔴 Fallback Preservation Rule (CLAUDE.md): this AUGMENTS the env-token path —
 * it never replaces it. A `null` return is the signal "use the token path", and
 * the caller MUST still call {@link resolveAccountTokenForSession} on null (which
 * carries the precise unknown/malformed/unrefreshable throws — R3/R4). The config
 * dir is the fast path; the token is the preserved fallback.
 *
 * Returns the isolated config dir (after ensuring it is seeded) when ALL hold:
 *  - an account is bound (`HAPI_ACCOUNT_UUID` set),
 *  - the bound account is NOT the host-default (defensive — the daemon's
 *    `shouldSkipBinding` already excludes it; this is belt-and-suspenders for the
 *    single-owner invariant / #1520 double-rotation class, R2),
 *  - the account record loads cleanly, and
 *  - it either already owns an isolated dir (native is the live rotator — return
 *    it WITHOUT re-seeding so a stale store token never clobbers native's
 *    freshly-rotated one, KD-2) OR it is refreshable and seeds cleanly from the
 *    store (`overwrite:false` bootstrap).
 *
 * Returns `null` (→ token fallback) when no account is bound, the account is the
 * host-default, the record is unknown/malformed, the account is `unrefreshable`
 * with no isolated dir (the token path then throws the re-login error — R4), or
 * a transient seed failure occurs (the token path is still a valid spawn).
 * NEVER throws — the env-token fallback owns the loud-failure surface.
 */
export async function resolveAccountConfigDirForSession(
  session: Session,
  deps: ResolveAccountTokenDeps = {}
): Promise<string | null> {
  // ── Issue #1562: per-account CLAUDE_CONFIG_DIR isolation is ENABLED BY DEFAULT ──
  // The #1551 regression (isolation orphaned all user-scope config — skills,
  // commands, agents, plugins, rules, global+project CLAUDE.md, settings.json/hooks,
  // and session transcripts) is FIXED by `provisionUserScopeConfigDir` below, which
  // symlinks the host `~/.claude` config dimensions into the isolated dir on every
  // spawn. With config restored, isolation delivers its #1546 benefit (native Claude
  // Code owns token refresh for non-host accounts) with no downside, so it is the
  // default. Verified end-to-end by the #1562 live red-team (skills/hooks/CLAUDE.md/
  // transcript-continuity/refresh-ownership on a real isolated session at runtime 2.1.x).
  //
  // Issue #4349 (R3): a TENANT VM binds only through the account's own config dir.
  if (tenantSpawn(deps)) return resolveTenantConfigDir(deps);

  // KILL-SWITCH: set HAPI_ACCOUNT_CONFIG_ISOLATION to a falsy value (`0`/`false`/`no`/
  // `off`) to revert to the env-token path (inject CLAUDE_CODE_OAUTH_TOKEN, use the
  // real ~/.claude) WITHOUT a code change — the #1551-era behavior, retained as the
  // runtime escape hatch.
  //
  // ACTIVATION (#1575): this gate runs in the spawn WORKER. Under tmux persistence
  // the worker inherits the persistent `tmux -L hapimatic-*` server's env (alive
  // across daemon restarts via KillMode=process), NOT the daemon's — so a systemd
  // `Environment=HAPI_ACCOUNT_CONFIG_ISOLATION=0` drop-in on the daemon reaches the
  // daemon MainPID but the worker only sees it because the daemon forwards it into
  // the worker spawn env (`tmuxSpawnAdapter.ts` → `buildAccountConfigIsolationEnv`).
  // Working activation: set Environment= on the daemon unit → `systemctl --user
  // daemon-reload` → restart the daemon. Existing sessions pick it up on their next
  // switch/respawn; fresh spawns get it immediately. A full tmux-server restart is
  // NOT required.
  const isolationFlag = (
    process.env.HAPI_ACCOUNT_CONFIG_ISOLATION ?? ""
  ).toLowerCase();
  if (
    isolationFlag === "0" ||
    isolationFlag === "false" ||
    isolationFlag === "no" ||
    isolationFlag === "off"
  ) {
    return null;
  }

  const accountUuid = readBoundAccountUuid();
  if (!accountUuid) return null; // no binding — host-credential path (R2)

  try {
    // Defensive single-owner guard (R2): never isolate the host-default account —
    // native already owns it via the host dir, and a second isolated rotator
    // would reproduce the #1520 double-rotation invalid_grant. The daemon's
    // shouldSkipBinding normally prevents HAPI_ACCOUNT_UUID being set for it.
    const hostDefaultUuid = await readHostDefaultAccountUuid().catch(
      () => null
    );
    if (hostDefaultUuid && accountUuid === hostDefaultUuid) return null;

    const store = deps.accountStore ?? accountStore;
    const res = await store.get(accountUuid);
    // Unknown/malformed → defer to the token path, which throws the precise
    // account-specific error (R4 — no silent fallback to a different account).
    if (!res || !res.ok) return null;
    const account = res.account;

    // Issue #2268: an env-token account has NO refresh token to seed into an
    // isolated CLAUDE_CONFIG_DIR (`seedAccountConfigDir` throws "missing
    // token(s)" without one). Route it to the env-token injection path instead —
    // return null so the caller falls through to `resolveAccountTokenForSession`,
    // which injects the stored `CLAUDE_CODE_OAUTH_TOKEN` directly.
    if (isEnvTokenAccount(account)) return null;

    const dir = accountConfigDirFor(accountUuid);

    // Issue #1562: provision the host's user-scope config (skills, commands,
    // agents, plugins, rules, projects/transcripts, CLAUDE.md, settings.json) into
    // the isolated dir on EVERY spawn — idempotent, and run in BOTH the
    // already-owned and bootstrap branches below (the already-owned branch never
    // calls seedAccountConfigDir, so provisioning must be its own call here).
    // #1551 isolated only the credential files; without this, an isolated session
    // loads NONE of the user's customizations. Fall back to the env-token path
    // (real ~/.claude — all config works) rather than spawn an isolated session
    // with stale/missing config when provisioning either (a) hits a real FS error
    // (`failed`) OR (b) leaves a required dimension unlinked because a real
    // file/dir (or wrong-target symlink) occupies the symlink path (`conflicts` —
    // e.g. a stale real `projects` from older isolation code). Both leave that
    // dimension reading stale/wrong data, so both MUST trigger the fallback (R5,
    // 🔴 Fallback Preservation Rule; #1574). A healthy concurrent spawn yields
    // `linked` (matching symlink target), NOT `conflicts`, so this never
    // spuriously falls back under normal parallelism.
    const provision = await (
      deps.provisionConfigDir ?? provisionUserScopeConfigDir
    )(dir);
    const reportProvision = deps.reportProvision ?? reportProvisionOutcome;
    if (provision.failed.length > 0 || provision.conflicts.length > 0) {
      logger.warn(
        `[ACCOUNT_CONFIG_DIR] provisioning incomplete for ${accountUuid} (failed=[${provision.failed.join(", ")}], conflicts=[${provision.conflicts.join(", ")}]); falling back to env-token path`
      );
      // Issue #4681: surface the fallback where an operator looks, not only here.
      reportProvision({
        kind: "degraded",
        accountUuid,
        configDir: dir,
        result: provision,
        session,
      });
      return null;
    }
    if (provision.repaired.length > 0) {
      reportProvision({
        kind: "repaired",
        accountUuid,
        configDir: dir,
        result: provision,
        session,
      });
    }

    // Issue #1643 (R2): the isolated dir is now a machine-global SHARED dir. If
    // this account has no shared dir yet but legacy per-instance dirs exist
    // (prod/dev/worktree copies from before #1643), migrate the LIVE family head
    // into the shared dir BEFORE the bootstrap-seed-from-store path below — so the
    // account never re-logins solely because of the relocation (a stale store head
    // would 401 → recovery → possibly invalid_grant). Lazy, best-effort, and
    // NON-destructive (no rotation); NEVER throws. A "none"/"skipped" result simply
    // falls through to the existing seed paths (the bootstrap branch handles the
    // no-legacy case). Self-gates to no-op under the HAPI_ACCOUNT_CONFIG_SHARED
    // kill-switch.
    if (!(await hasIsolatedConfigDir(accountUuid))) {
      await (deps.migrateLegacy ?? migrateLegacyIsolatedDir)(accountUuid);
    }

    // Isolated dir already owned by native — the dir is the source of truth
    // (KD-2). Do NOT blind-trust it, though (issue #1635, R1): the snapshot
    // can be server-side REVOKED with a future `expiresAt` (refresh-token
    // family rotation by a sibling holder). Validate it — probe the access
    // token and, when dead, recover (re-seed from a fresher store head, else
    // one deduplicated rotation). On unrecoverable, fall through to the
    // env-token path, which owns the loud "re-login" failure (R3/R4 +
    // Fallback Preservation Rule). The validator NEVER throws. (Post-#1643 this
    // branch also catches a just-migrated shared dir.)
    if (await hasIsolatedConfigDir(accountUuid)) {
      const validate =
        deps.validateSnapshot ??
        (acct =>
          validateAndRecoverIsolatedSnapshot(acct, {
            // #1644: gate the destructive tier-b rotation on the cross-machine
            // family lease. NOTE (#4423): this runs in the session WRAPPER
            // process, so the lease lands in the wrapper's own manager singleton
            // and is NOT heartbeated by the daemon — it lapses at the hub TTL.
            acquireRotationLease: uuid => rotationLeaseManager.acquire(uuid),
          }));
      const verdict = await validate(account);
      if (verdict === "ok") {
        return dir;
      }
      logger.warn(
        `[ACCOUNT_CONFIG_DIR] isolated snapshot for ${accountUuid} failed validation and recovery (#1635); falling back to env-token path`
      );
      return null;
    }

    // No isolated dir yet. A dead store token can't bootstrap one — defer to the
    // token path so its `unrefreshable` throw surfaces the re-login state (R4).
    if (account.unrefreshable) return null;

    // Bootstrap: seed from the store token (overwrite:false is a no-op if a
    // concurrent spawn already seeded). On success, native takes over rotation.
    await seedAccountConfigDir(account, { overwrite: false });
    return dir;
  } catch (err) {
    // Transient (FS error, etc.) — fall back to the env-token path rather than
    // fail the spawn (Fallback Preservation Rule). Never log token values.
    logger.warn(
      `[ACCOUNT_CONFIG_DIR] isolation resolve failed for ${accountUuid}; falling back to env-token path: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

/** Minimal structural seam for the bound-account read (test injection). */
interface AccountReader {
  get(accountUuid: string): Promise<ValidateAccountResult | null>;
}

/** Minimal structural seam for the reactive refresh primitive (test injection). */
interface TokenRefresher {
  handleAuthFailure(
    accountUuid: string
  ): Promise<{ refreshed: boolean; accessToken?: string }>;
}

/** Optional dependency injection for offline unit testing (OR-4). */
export interface ResolveAccountTokenDeps {
  /** Defaults to the real `accountStore` singleton. */
  accountStore?: AccountReader;
  /** Defaults to a fresh `TokenRefreshService` over the real `accountStore`. */
  tokenRefreshService?: TokenRefresher;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Issue #1562: override the user-scope config provisioner (test seam).
   * Defaults to {@link provisionUserScopeConfigDir}.
   */
  provisionConfigDir?: (configDir: string) => Promise<ProvisionResult>;
  /**
   * Issue #1635: override the isolated-snapshot validator (test seam — the
   * real one probes the network). Defaults to
   * {@link validateAndRecoverIsolatedSnapshot}.
   */
  validateSnapshot?: (account: StoredAccount) => Promise<"ok" | "fallback">;
  /**
   * Issue #1643: override the legacy-dir migration (test seam — the real one
   * scans the filesystem and probes the network). Defaults to
   * {@link migrateLegacyIsolatedDir}. Kept OPTIONAL so the other consumers of
   * this interface (e.g. `resolveSpawnContextWindow`, #1556) compile unchanged.
   */
  migrateLegacy?: (accountUuid: string) => Promise<LegacyMigrationOutcome>;
  /**
   * Issue #4681: override how a provisioning outcome is reported (test seam).
   * Defaults to {@link reportProvisionOutcome}.
   */
  reportProvision?: (report: ProvisionReport) => void;
  /**
   * Issue #4349: the tenant predicate (test seam). Defaults to {@link isTenantVm}. On a tenant
   * the resolvers take the in-VM sign-in path ({@link resolveTenantConfigDir}) and never a token.
   */
  tenantVm?: () => boolean;
  /** Issue #4349: whether an account's own dir holds the binary's credential (test seam). */
  hasConfigDir?: (accountUuid: string) => Promise<boolean>;
  /** Issue #4349: the host `~/.claude` login's account uuid (test seam). */
  hostDefaultUuid?: () => Promise<string | null>;
}

/**
 * Issue #4349 (R3, Task 4(c)): the TENANT spawn binding. On a tenant VM a bound account is
 * selected ONLY by its own `CLAUDE_CONFIG_DIR`, the dir the customer signed in to with the
 * unmodified binary's `/login`: never seeded from the store, never probed or re-seeded
 * (`validateAndRecoverIsolatedSnapshot`), never rotated or bootstrapped by Hapimatic, and the
 * `HAPI_ACCOUNT_CONFIG_ISOLATION` kill switch does not apply (its fallback is token injection).
 *
 * Returns the dir, or `null` for: an unbound session and the host-default account (native Claude
 * Code reads `~/.claude`, nothing injected), and a bound account whose dir holds no credential —
 * then {@link resolveAccountTokenForSession} raises "sign in to this account". The user-scope
 * config (skills, CLAUDE.md, settings) is still linked into the dir — symlinks, never a
 * credential; a provisioning gap is logged, not a reason to inject a token.
 */
async function resolveTenantConfigDir(
  deps: ResolveAccountTokenDeps
): Promise<string | null> {
  const accountUuid = readBoundAccountUuid();
  if (!accountUuid) return null;
  const hostDefault = await (
    deps.hostDefaultUuid ?? readHostDefaultAccountUuid
  )().catch(() => null);
  if (hostDefault && hostDefault === accountUuid) return null;
  if (!(await (deps.hasConfigDir ?? hasIsolatedConfigDir)(accountUuid)))
    return null;
  const dir = accountConfigDirFor(accountUuid);
  const provision = await (
    deps.provisionConfigDir ?? provisionUserScopeConfigDir
  )(dir).catch(() => null);
  if (
    provision &&
    (provision.failed.length > 0 || provision.conflicts.length > 0)
  ) {
    logger.warn(
      `[TENANT] user-scope config incomplete for ${accountUuid} (failed=[${provision.failed.join(", ")}], conflicts=[${provision.conflicts.join(", ")}]); spawning with its own config dir anyway (#4349)`
    );
  }
  return dir;
}

/** Issue #4349: true when the tenant path applies to this spawn. */
function tenantSpawn(deps: ResolveAccountTokenDeps): boolean {
  return (deps.tenantVm ?? isTenantVm)();
}

/** What {@link resolveAccountConfigDirForSession} reports about one provisioning run (#4681). */
export interface ProvisionReport {
  kind: "degraded" | "repaired";
  accountUuid: string;
  configDir: string;
  result: ProvisionResult;
  session: Session;
}

/**
 * Issue #4681: make an env-token fallback (and a self-repair) visible beyond a
 * session log line. A fallback goes to the server `error_logs` table (the web
 * `/error-logs` page, category `account-isolation-degraded`) and into the affected
 * session's chat; a repair is recorded once at info. Fire-and-forget and NEVER
 * throws — reporting must not change whether or how the session spawns.
 */
export function reportProvisionOutcome(report: ProvisionReport): void {
  try {
    const { kind, accountUuid, configDir, result, session } = report;
    const accountPrefix = accountUuid.slice(0, 8);
    const sessionId = session?.client?.sessionId ?? null;
    const context = JSON.stringify({
      accountUuidPrefix: accountPrefix,
      configDir,
      conflicts: result.conflicts,
      failed: result.failed,
      repaired: result.repaired,
    });
    if (kind === "repaired") {
      logger.reportError({
        message: `Account ${accountPrefix} isolated config dir self-repaired: restored the managed link(s) [${result.repaired.join(", ")}] over byte-identical copies`,
        category: "account-isolation-repaired",
        severity: "info",
        sessionId,
        context,
      });
      return;
    }
    const dims = [...result.conflicts, ...result.failed].join(", ");
    logger.reportError({
      message: `Account ${accountPrefix} spawned on the env-token path: isolated config dir has conflicts=[${result.conflicts.join(", ")}] failed=[${result.failed.join(", ")}]; the session cannot refresh its own token`,
      category: "account-isolation-degraded",
      severity: "warn",
      sessionId,
      context,
    });
    session?.client?.sendSessionEvent({
      type: "message",
      message:
        result.failed.length === 0
          ? `⚠️ Account isolation degraded: this session runs on an access token only and cannot refresh it itself, because ${configDir} has a real file, folder or foreign link where a managed link belongs (${dims}). Restore the link(s); details are in /error-logs under account-isolation-degraded.`
          : `⚠️ Account isolation degraded: this session runs on an access token only and cannot refresh it itself, because ${configDir} could not be provisioned (conflicts=[${result.conflicts.join(", ")}], failed=[${result.failed.join(", ")}]). Details are in /error-logs under account-isolation-degraded.`,
    });
  } catch (err) {
    // Reporting is best-effort; never affect the spawn.
    logger.debug(
      `[ACCOUNT_CONFIG_DIR] provision report failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Resolve the access token to inject for this session's bound account.
 *
 * - When no account is bound, returns the wrapper's launch-time
 *   `CLAUDE_CODE_OAUTH_TOKEN` — the node's instance credential, delivered
 *   explicitly by the daemon to unbound claude spawns (#3731 R0b/R2b) — or `null`
 *   when there is none, in which case the host-credential path is used unchanged
 *   (R2). Returning it makes the instance credential the session's EXPLICIT binding,
 *   so every launcher's unconditional ambient `BINDING_ENV_VARS` strip
 *   (`buildLauncherEnv` / `buildSdkSpawnEnv`) keeps it instead of dropping it. On
 *   the daemon path this value is exactly what the daemon delivered: on the tmux
 *   arm the per-pane `unset` in `buildTmuxEnvFileCommand` removes any
 *   tmux-inherited copy BEFORE the env file is sourced (#3731 R3); on the direct
 *   arm the daemon builds the child env with `buildSdkSpawnEnv`, which drops any
 *   ambient copy. On a node without an instance token (e.g. RP1) the daemon
 *   delivers none, so the result is `null` as before. A `hapi` started from a
 *   terminal whose shell exports `CLAUDE_CODE_OAUTH_TOKEN` now binds that token
 *   explicitly (the pty/tmux launchers used to strip it) — by design.
 * - Throws a clear error when the bound account is unknown, malformed, or
 *   `unrefreshable` — never a silent fallback to a different account or to host
 *   credentials (R3).
 * - Otherwise returns the account's current access token, force-refreshing via
 *   `TokenRefreshService.handleAuthFailure` when within the expiry buffer so a
 *   long-lived session crossing the expiry boundary respawns fresh (R1, R7, KD-6).
 *
 * The `session` parameter is retained per the issue's contract and is available
 * if a future caller needs `session.metadata`; the binding itself comes from the
 * process env (KD-3).
 */
export async function resolveAccountTokenForSession(
  session: Session,
  deps: ResolveAccountTokenDeps = {}
): Promise<string | null> {
  void session;
  const now = deps.now ?? Date.now;

  // Issue #4349 (R3): a TENANT VM never injects CLAUDE_CODE_OAUTH_TOKEN — not a stored token, not
  // the instance credential, not a refreshed one. An unbound session and the host-default account
  // get nothing (native reads ~/.claude); a bound account reaches here only when its own dir holds
  // no credential (resolveTenantConfigDir), so the customer must sign in to it in the VM.
  if (tenantSpawn(deps)) {
    const bound = readBoundAccountUuid();
    if (!bound || readBoundApiKeyId()) return null;
    const hostDefault = await (
      deps.hostDefaultUuid ?? readHostDefaultAccountUuid
    )().catch(() => null);
    if (hostDefault && hostDefault === bound) return null;
    logger.warn(`[TENANT] ${tenantSignInRequiredMessage(bound)}`);
    throw new Error(tenantSignInRequiredMessage(bound));
  }

  // Issue #4568: an API-key session has NO account token — its only credential is
  // the vault key, which Claude Code reads through `hapi api-key-helper` (the
  // launcher only checks the binding, {@link verifyApiKeyForSession}).
  // Returning null here keeps any caller from handing it the wrapper's OAuth token
  // as a second credential.
  if (readBoundApiKeyId()) return null;

  const accountUuid = readBoundAccountUuid();
  // R2 — host-credential path. #3731 R2b: an unbound session's instance credential
  // (the token this wrapper was launched with) becomes its explicit binding.
  if (!accountUuid) return process.env.CLAUDE_CODE_OAUTH_TOKEN || null;

  const store = deps.accountStore ?? accountStore;
  const res = await store.get(accountUuid);
  if (res === null) {
    throw new Error(
      `Account-bound session references unknown accountUuid ${accountUuid}`
    ); // R3
  }
  if (!res.ok) {
    throw new Error(
      `Account record for ${accountUuid} is malformed: ${res.error}`
    ); // R3
  }
  let account = res.account;
  // #4423: each spawn-failure throw below is preceded by a [TOKEN_REFRESH]-tagged
  // log line with the same wording — the soak filter matches tagged lines only,
  // and these messages are plain Errors. The thrown messages stay byte-identical.
  if (account.unrefreshable) {
    logger.warn(
      `[TOKEN_REFRESH] account ${accountUuid} is unrefreshable — user must re-login (spawn refused)`
    );
    throw new Error(
      `Account ${accountUuid} (${account.emailAddress}) is unrefreshable — user must re-login`
    ); // R3
  }

  // Issue #2268: an env-token account carries a long-lived token with no refresh
  // token — inject it directly and return BEFORE the isolated-dir mirror and the
  // near-expiry safety net below. Env-token records have a synthesized
  // `expiresAt: 0`, so the near-expiry check would (a) treat the token as expired,
  // (b) call `handleAuthFailure` — which skips the kind, so no refresh happens —
  // and (c) throw "token expired and on-demand refresh failed". These accounts
  // are never Hapimatic-refreshed, so short-circuit here with the stored token.
  if (isEnvTokenAccount(account)) return account.accessToken;

  // Issue #1635 (R7/F4): when this instance holds an isolated dir for the
  // account, the dir is the LIVE source of truth — the store copy froze at
  // seed time and diverges on native's first rotation (and under the #1635
  // race the store token is revoked-but-future-dated, so the expiry guard
  // below would happily inject it). Prefer the isolated tokens; mirror them
  // into the store best-effort so the UI badge stays fresh. This path is
  // reached on the isolation kill-switch, provisioning-conflict fallback, and
  // snapshot-recovery fallback. All R3 throws above/below stay byte-identical.
  if (await hasIsolatedConfigDir(accountUuid)) {
    const oauth = await readIsolatedCredentials(accountUuid);
    if (oauth && oauth.accessToken !== account.accessToken) {
      account = {
        ...account,
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken,
        expiresAt: oauth.expiresAt,
      };
      const maybePut = (
        store as AccountReader & {
          put?: (a: StoredAccount) => Promise<void>;
        }
      ).put;
      if (typeof maybePut === "function") {
        await maybePut.call(store, account).catch(() => {
          // best-effort mirror — never fail the spawn over a store write
        });
      }
    }
  }

  // R1/R7 near-expiry safety net. The daemon scheduler keeps tokens fresh in
  // steady state (KD-6); this covers the just-bound / no-scheduler edge cases.
  if (account.expiresAt - now() <= EXPIRY_BUFFER_MS) {
    const refresher =
      deps.tokenRefreshService ?? new TokenRefreshService({ accountStore });
    const { refreshed, accessToken } =
      await refresher.handleAuthFailure(accountUuid);
    if (refreshed && accessToken) return accessToken;

    // Not refreshed (transient failure, or a concurrent refresh already
    // updated the record) — re-read and re-check before deciding.
    const reread = await store.get(accountUuid);
    if (reread?.ok) {
      if (reread.account.unrefreshable) {
        logger.warn(
          `[TOKEN_REFRESH] account ${accountUuid} became unrefreshable during refresh — user must re-login (spawn refused)`
        );
        throw new Error(
          `Account ${accountUuid} became unrefreshable during refresh — user must re-login`
        ); // R3
      }
      account = reread.account;
    }
    if (account.expiresAt <= now()) {
      logger.warn(
        `[TOKEN_REFRESH] account ${accountUuid} token expired and on-demand refresh failed (spawn refused)`
      );
      throw new Error(
        `Account ${accountUuid} token expired and on-demand refresh failed`
      ); // R3
    }
  }

  return account.accessToken; // R1
}

/**
 * Issue #1506: resolve the `--model` value to pin for THIS process's bound
 * account, or `null` when no account is bound or anything goes wrong.
 *
 * Mirrors `resolveAccountTokenForSession`'s binding read (the binding is the
 * `HAPI_ACCOUNT_UUID` env var, NOT the `session`), but is intentionally
 * fail-SAFE rather than fail-LOUD: token resolution must abort the spawn when
 * the bound account is unusable, but a model-resolution miss must NEVER throw —
 * it degrades to `null` so the spawn proceeds with Claude Code's own model
 * selection. The caller (`runClaude`) consults this only when the session has
 * no explicit model, so `null` is always a safe answer.
 */
export async function resolveEntitledModelForBoundAccount(
  deps: ResolveAccountTokenDeps = {}
): Promise<string | null> {
  const accountUuid = readBoundAccountUuid();
  if (!accountUuid) return null; // no binding — host-credential path (R3)
  try {
    const store = deps.accountStore ?? accountStore;
    const res = await store.get(accountUuid);
    if (!res || !res.ok) return null; // unknown/malformed — fail safe (R6)
    return resolveEntitledModel(res.account);
  } catch {
    return null; // never throw into the spawn path
  }
}

/**
 * Issue #1488 (Gap 4): build the launcher spawn-args with the entitled `--model`
 * pin appended for an account-bound session, or return the input `claudeArgs`
 * unchanged.
 *
 * The SDK launcher threads the entitled model via the per-message
 * `EnhancedMode.model` (set by `runClaude.ts`'s #1506 block). The PTY/tmux launchers
 * consume the queue as raw text and spawn `claude` ONCE with fixed args, so they
 * never observe `mode.model`. This helper restores the #1506 pin at spawn time,
 * symmetric to the `resolveAccountTokenForSession` call those launchers already make
 * at entry.
 *
 * Invariants (preserve #1506 semantics):
 *   - Apply when no EXPLICIT user model is selected. The discriminator is the
 *     `resolvedSpawnModel` `[1m]` alias, NOT `modelMode` (issue #1608): for a
 *     bound-Max default-mode session, `syncSessionModes` overloads
 *     `modelMode = "opus"` for DISPLAY (via `setModelMode`), so `modelMode` alone
 *     can no longer distinguish an entitled pin from a real user "opus" choice by
 *     the time the PTY/tmux launcher reads `session.getModelMode()`. The
 *     `resolvedSpawnModel` (`session.getModel()`) still carries the `"opus[1m]"`
 *     alias the #1506 block set, which the UI never offers — so `[1m]` present
 *     ⇒ entitled pin (bypass the R3 guard); `[1m]` absent + `modelMode` explicit
 *     ⇒ user selection (honor R3).
 *   - If `claudeArgs` already carries a `--model` flag, leave it untouched (defensive).
 *   - Fail-safe: `resolveEntitledModelForBoundAccount` returns null on any miss, so a
 *     non-bound / non-Max / errored session spawns with its original args unchanged.
 *     The pin VALUE is re-derived (not copied from `resolvedSpawnModel`) so a stale
 *     `[1m]` alias on a now-unentitled account still no-ops.
 */
export async function buildEntitledModelArgs(
  modelMode: SessionModelMode | undefined,
  claudeArgs: string[] | undefined,
  deps: ResolveAccountTokenDeps = {},
  resolvedSpawnModel?: string
): Promise<string[]> {
  const base = claudeArgs ?? [];
  // Issue #1608: the runClaude-resolved spawn model carries the entitled
  // "opus[1m]" alias ONLY when the #1506 block fired for a bound-Max
  // default-mode session. In that case modelMode has been overloaded to "opus"
  // for DISPLAY (syncSessionModes -> setModelMode), which is NOT a user
  // selection -- so the R3 guard below must NOT treat it as one.
  // Issue #1633: the discriminator is an EXACT match against the entitled pin
  // alias, NOT a "[1m]"-substring check — explicit user selections can now
  // carry the suffix too ("fable[1m]"), and a substring check would
  // false-positive on them, bypass R3, and clobber Fable with opus[1m].
  const isEntitledPin = resolvedSpawnModel === ENTITLED_PIN_MODEL;
  // R3: never override an EXPLICIT user model selection. An entitled "[1m]" pin
  // is not a user selection (see above), so it bypasses this guard.
  if (!isEntitledPin && modelMode !== undefined && modelMode !== "default") {
    return base;
  }
  // Defensive: respect a model already present in claudeArgs.
  if (base.includes("--model")) return base;
  const model = await resolveEntitledModelForBoundAccount(deps);
  if (!model) return base;
  return [...base, "--model", model];
}

/**
 * Issue #1608: resolve the final spawn args for the PTY/tmux launchers. Both
 * launchers previously inlined the identical `accountConfigDir ? raw :
 * buildEntitledModelArgs(...)` branch — this DRYs it and creates the test seam
 * the regression test drives.
 *
 *   - Explicit user selection (issue #1633 — checked FIRST, on BOTH paths):
 *     modelMode ∈ {sonnet, opus, fable} with a raw model that is not the
 *     entitled pin alias appends `--model <raw>` so the selection survives
 *     respawn/recovery. Native honors an explicit argv model over its own
 *     resolution; the #1551 oscillation was specific to the entitled AUTO-pin
 *     disagreeing with native's default resolution, which cannot occur for a
 *     stable explicit selection.
 *   - Isolated path (`accountConfigDir` set, #1551/#1562 default-on): native
 *     self-resolves the entitled model from the isolated credentials, so pass
 *     `claudeArgs` through untouched (R4). Pinning here would collide with
 *     native's resolution and oscillate modelMode → respawn → SIGTERM 143.
 *   - Env-token path (`accountConfigDir === null`): append the entitled
 *     `--model` pin, keying the entitled-vs-explicit decision off the
 *     runClaude-resolved spawn model (`session.getModel()` — carries the
 *     `[1m]` alias), NOT the #1506-overloaded `session.getModelMode()` (the
 *     #1608 root cause: `syncSessionModes` clobbers modelMode to "opus" before
 *     the launcher reads it).
 *
 * The `Pick<…>` structural type keeps the helper unit-testable.
 */
export async function resolveSpawnClaudeArgs(
  session: Pick<Session, "getModelMode" | "getModel" | "getEffort">,
  accountConfigDir: string | null,
  claudeArgs: string[] | undefined,
  deps: ResolveAccountTokenDeps = {}
): Promise<string[]> {
  const base = claudeArgs ?? [];
  const mode = session.getModelMode();
  const raw = session.getModel();
  // Issue #2456: reasoning-effort is orthogonal to model resolution — append it
  // to EVERY return path (the binary accepts --effort alongside any --model).
  // Idempotent: skip if a --effort already rode in via the claudeArgs passthrough.
  const effort = session.getEffort();
  const withEffort = (args: string[]): string[] =>
    effort && !args.includes("--effort") ? [...args, "--effort", effort] : args;

  // Issue #1633: an EXPLICIT user model selection must reach the child's argv
  // on BOTH paths — before this, nothing ever appended it: the isolated path
  // passed args through (native resolved its own default, dropping the
  // selection) and buildEntitledModelArgs' R3 guard only avoided OVERRIDING.
  // "Explicit" = modelMode set to a non-default value AND the raw model is NOT
  // the entitled pin alias (an entitled-default session has modelMode
  // display-overloaded to "opus" with raw "opus[1m]" — that is #1506's pin,
  // not a user selection, and on the isolated path appending it would
  // reintroduce the #1551 native-resolution collision). An explicit selection
  // is a single stable source of truth, so no oscillation risk applies.
  if (
    mode !== undefined &&
    mode !== "default" &&
    raw !== undefined &&
    raw !== ENTITLED_PIN_MODEL &&
    !base.includes("--model")
  ) {
    return withEffort([...base, "--model", raw]);
  }

  // Issue #2456: a specific pinned raw Claude model id ("More models") displays
  // modelMode "default" (a concrete version id is not a bare alias, so
  // deriveModelModeFromRaw returns "default"), which the #1633 guard above skips.
  // A concrete, non-entitled raw model with a "default" display mode can ONLY be
  // a deliberate rawModel pin — an entitled default carries ENTITLED_PIN_MODEL and
  // a host default carries no raw — so it is a single stable source of truth with
  // no oscillation risk; append it to the child argv on the PTY/tmux path too.
  if (
    mode === "default" &&
    raw !== undefined &&
    raw !== ENTITLED_PIN_MODEL &&
    !base.includes("--model")
  ) {
    return withEffort([...base, "--model", raw]);
  }

  if (accountConfigDir) return withEffort(base);
  return withEffort(await buildEntitledModelArgs(mode, claudeArgs, deps, raw));
}

/**
 * Issue #1488 (Gap 2): resolve the effective context-window size (max tokens) for a
 * spawn `--model` string, or `undefined` when it cannot be determined.
 *
 * The JSONL transcript the PTY/tmux scanner reads carries `message.model` (the bare
 * resolved id) and `message.usage` (token counts), but NOT the effective context
 * window — that lives behind the SDK `get_context_usage` control_request, which is
 * structurally unavailable on the non-SDK launchers (`--input-format stream-json` is a
 * `FORBIDDEN_CLAUDE_ARG`). Hapimatic does, however, know the model string it spawned.
 *
 * Rule: a `[1m]` suffix selects the 1M-context beta (1_000_000); any other concrete
 * model resolves to the standard 200k window; an absent/unknown model returns
 * `undefined` so the display degrades to model-name-only rather than asserting a wrong
 * denominator (the host-credential path with no pinned model).
 */
export function resolveContextWindowForModel(
  modelArg: string | undefined
): number | undefined {
  if (!modelArg) return undefined;
  return modelArg.includes("[1m]") ? 1_000_000 : 200_000;
}

/**
 * Issue #1556: resolve the context window for a NON-SDK launcher (PTY/tmux) spawn,
 * covering BOTH the host/env-token path AND the CLAUDE_CONFIG_DIR-isolated path.
 *
 * Precedence:
 *   1. An explicit `--model` in the spawn args wins: resolve the window from it.
 *      This covers a user selection (incl. the isolated explicit-selection pin
 *      #1633 appends via `resolveSpawnClaudeArgs`) AND the entitled `opus[1m]`
 *      pin the env-token path appends via `buildEntitledModelArgs`. Preserves
 *      the #1488 Gap 2 behavior unchanged.
 *   2. Otherwise, for a CLAUDE_CONFIG_DIR-isolated session (`accountConfigDir`
 *      non-null) carrying no `--model` pin (#1551 suppressed it for the isolated
 *      default-mode path), derive the window from the entitled model native
 *      self-resolves from the isolated credentials — the SAME model the
 *      non-isolated path pins. `opus[1m]`/`fable[1m]` (Max) → 1M; null
 *      (non-Max/unknown) → undefined → detector no-ops (R4 — never assert a
 *      wrong denominator).
 *   3. Otherwise undefined (host-credential path with no pin — detector no-ops,
 *      unchanged from #1488).
 *
 * This NEVER mutates `spawnArgs` — it only reads them — so it cannot re-add a
 * `--model` spawn argument for isolated sessions (#1556 AC #3 / R3).
 */
export async function resolveSpawnContextWindow(
  spawnArgs: string[],
  accountConfigDir: string | null,
  deps: ResolveAccountTokenDeps = {}
): Promise<number | undefined> {
  const modelIdx = spawnArgs.indexOf("--model");
  const explicitModel = modelIdx >= 0 ? spawnArgs[modelIdx + 1] : undefined;
  if (explicitModel) return resolveContextWindowForModel(explicitModel);
  if (accountConfigDir) {
    const entitled = await resolveEntitledModelForBoundAccount(deps);
    return resolveContextWindowForModel(entitled ?? undefined);
  }
  return undefined;
}
