// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { FileLockTimeoutError, withFileLock } from "@/utils/fileLock";
import { isTenantVm } from "@hapi/protocol/tenantMode";
import {
  TEST_STORE_BOOKKEEPING_FILES,
  TEST_STORE_MARKER,
} from "@hapi/protocol/instanceKind";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import {
  HOST_CHAIN_SHARED_REASON,
  isEnvTokenAccount,
  validateAccountIndex,
  validateStoredAccount,
  validateAnyStoredAccount,
  type AccountIndex,
  type AccountIndexEntry,
  type StoredAccount,
  type ValidateAccountResult,
  type ValidateAnyAccountResult,
} from "@hapi/protocol/accounts";
import { deserializeAccount, serializeAccount } from "@/accounts/storedAccount";
import {
  readSignInMarkerIn,
  signInMarkerNamesToken,
} from "@/accounts/signInMarker";
import type { UtilizationSnapshot } from "@/accounts/selectHealthyAccount";

/**
 * Canonical UUID format (8-4-4-4-12 hex). `accountUuid` becomes a filesystem
 * path component, so this gate is the path-traversal defense (issue #1447 R11):
 * a value like `../escape` or `index` cannot pass. `isSafeMachinePath` is the
 * WRONG tool here — it blacklists absolute system locations; what is needed is
 * a strict positive UUID-format check before any `join`.
 */
export const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Thrown when an `accountUuid` fails {@link UUID_REGEX} validation before being
 * used as a filename. Distinct error type so callers can map it to a security-
 * shaped diagnostic rather than a generic IO failure (issue #1447 R11).
 */
export class InvalidAccountUuidError extends Error {
  readonly accountUuid: string;
  constructor(accountUuid: string) {
    super(
      `Invalid accountUuid format: '${accountUuid}'. Expected a canonical ` +
        `UUID; refusing to use it as a filesystem path component.`
    );
    this.name = "InvalidAccountUuidError";
    this.accountUuid = accountUuid;
  }
}

/**
 * Thrown when the per-store index lock at `<accountsDir>/index.json.lock` could
 * not be acquired within the timeout. Re-wraps {@link FileLockTimeoutError} so
 * callers get a domain-specific error without knowing the file-lock internals
 * (mirrors `ConfigLockTimeoutError` in projectMcpConfig.ts).
 */
export class AccountStoreLockTimeoutError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(
      `Failed to acquire account index lock at ${lockPath} within timeout. ` +
        `Another Hapimatic session may be mutating the account store. Retry.`
    );
    this.name = "AccountStoreLockTimeoutError";
    this.lockPath = lockPath;
  }
}

/** Relevant slice of a folder's `.credentials.json` (adoption source — tokens). */
interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    rateLimitTier?: string;
  };
}

/** Relevant slice of a folder's `.claude.json` (adoption source — identity + PK). */
interface ClaudeConfigFile {
  oauthAccount?: {
    accountUuid?: string;
    emailAddress?: string;
    organizationUuid?: string;
    organizationName?: string;
    displayName?: string;
    billingType?: string;
  };
}

/**
 * Override points for the boot-time folder adoption (issue #6800; it replaced
 * the #1447 first-run migration from `~/.claude`). Tests inject temp-dir values
 * so they never touch the real files.
 */
export interface AccountStoreAdoptionSources {
  /** The machine-global account-configs root. Default `configuration.accountConfigsDir`. */
  accountConfigsDir?: string;
  /**
   * The sha256 fingerprint of the `~/.claude` refresh token, or null. A folder
   * holding that token is never adopted. The daemon passes
   * `hostChainQuarantine.readHostRefreshFingerprint` to the method instead,
   * because that module imports this one.
   */
  readHostRefreshFingerprint?: () => Promise<string | null>;
  /**
   * Issue #6837 (R6): the account uuid `~/.claude.json` names, null when it names
   * none, or `"unreadable"`. The folder of that account is adopted quarantined
   * unless a Provider Accounts sign-in marker names its token. The daemon passes
   * `hostChainQuarantine.readHostNamedUuid` to the method instead, because that
   * module imports this one. With no reader, adoption is skipped (adopting
   * unflagged could create an unquarantined copy of the `~/.claude` chain).
   */
  readHostNamedUuid?: () => Promise<string | null | "unreadable">;
}

/** Issue #6837 (R6): reads of `~/.claude.json` before adoption gives up for this boot. */
const HOST_NAMED_READ_ATTEMPTS = 3;
/** Issue #6837 (R6): the wait between those reads, for a file caught mid-write. */
const HOST_NAMED_READ_RETRY_MS = 300;

/** Empty index used when no index file exists yet or the on-disk one is corrupt. */
function emptyIndex(): AccountIndex {
  return { schema_version: 1, accounts: [] };
}

/**
 * On-disk store for Hapimatic-managed Anthropic OAuth accounts (issue #1447,
 * foundation sub-issue of epic #1446).
 *
 * Layout (per-instance, under `configuration.accountsDir`):
 * - `<accountsDir>/<accountUuid>.json` — full record, mode 0600, atomic tmp+rename
 * - `<accountsDir>/index.json` — `{schema_version, accounts:[{accountUuid,emailAddress,lastUsedAt}]}`
 *   for fast enumeration without loading token-bearing records; mutated under a
 *   cross-process file lock so concurrent writers don't lose updates (R5).
 *
 * Contract notes for downstream sub-issues B–K:
 * - `get()` returns `{ok:true,account}` for a valid record, `{ok:false,error}`
 *   for a malformed one (skip-or-surface, R6), and `null` for an unknown UUID
 *   (R3). The discriminated union distinguishes "absent" from "corrupt".
 * - Issue #6800: there is no first-run migration from `~/.claude` any more.
 *   The daemon calls {@link AccountStore.adoptIndependentAccountFolders} once at
 *   boot; `list()`, `get()`, `put()` and `delete()` never adopt or migrate.
 * - Token VALUES never reach the logger at any level — only `accountUuid` /
 *   `emailAddress` / counts (R9).
 */
export class AccountStore {
  /**
   * In-memory utilization snapshot cache (issue #3023). The daemon's per-tick sampler
   * (`utilizationSampler.ts`) writes each account's `{score, fetchedAt}` here; the
   * un-pinned spawn veto (`sessionSpawner`) reads it via `getUtilizationSnapshot`. This
   * is transient runtime state — deliberately NOT persisted (a snapshot is only valid
   * for one freshness window and is re-fetched every tick), so it never touches the
   * on-disk `index.json` / per-account records. Keyed by `accountUuid`.
   */
  private readonly utilizationSnapshots = new Map<
    string,
    UtilizationSnapshot
  >();

  /**
   * @param tenantVm Issue #4349 (R3): the tenant predicate (test seam). On a TENANT VM the
   * boot adoption is a no-op. Defaults to `@hapi/protocol/tenantMode`'s `isTenantVm` (imported
   * directly, not through the cli's tenantMode module, so this foundation module has no cycle).
   */
  constructor(
    private readonly accountsDir: string,
    private readonly adoptionSources: AccountStoreAdoptionSources = {},
    private readonly tenantVm: () => boolean = isTenantVm
  ) {}

  private get indexPath(): string {
    return join(this.accountsDir, "index.json");
  }

  /** Per-node active-account pointer file (`{activeAccountUuid}`). Same shape
   * the server-side `AccountService` writes (issue #1451). */
  private get activePath(): string {
    return join(this.accountsDir, "active.json");
  }

  private assertValidUuid(accountUuid: string): void {
    if (!UUID_REGEX.test(accountUuid)) {
      throw new InvalidAccountUuidError(accountUuid);
    }
  }

  /** Per-account file path. Caller MUST have passed `assertValidUuid` first. */
  private accountPath(accountUuid: string): string {
    return join(this.accountsDir, `${accountUuid}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.accountsDir, { recursive: true, mode: 0o700 });
  }

  /**
   * Enumerate accounts from the index file. Returns `[]` on a fresh/empty
   * directory or a malformed index (never crashes — R1). Never adopts or
   * migrates (#6800): a lost store is refilled by the next daemon boot's
   * {@link adoptIndependentAccountFolders}, or by a sign-in.
   */
  async list(): Promise<AccountIndexEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.debug(
        "[ACCOUNT_STORE] index.json is not valid JSON; returning empty list"
      );
      return [];
    }

    const validation = validateAccountIndex(parsed);
    if (!validation.ok) {
      logger.debug(
        `[ACCOUNT_STORE] index.json failed validation (${validation.error}); returning empty list`
      );
      return [];
    }
    return validation.index.accounts;
  }

  /**
   * Load a full account record. Returns `null` for an unknown UUID (R3),
   * `{ok:false,error}` for a malformed record (R6), `{ok:true,account}` for a
   * valid one.
   */
  async get(accountUuid: string): Promise<ValidateAccountResult | null> {
    this.assertValidUuid(accountUuid);

    let raw: string;
    try {
      raw = await readFile(this.accountPath(accountUuid), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    return deserializeAccount(raw);
  }

  /**
   * Load a full record as the PROVIDER-AWARE union (#3808) — returns an
   * Anthropic, OpenAI, or Google record. `null` for an unknown UUID,
   * `{ok:false,error}` for a malformed one. Used by the per-session binding
   * resolver (`resolveProviderBinding`) which needs a bound codex account's
   * `codexHome`. Byte-identical to {@link get} for an Anthropic record.
   */
  async getAny(accountUuid: string): Promise<ValidateAnyAccountResult | null> {
    this.assertValidUuid(accountUuid);
    let raw: string;
    try {
      raw = await readFile(this.accountPath(accountUuid), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return validateAnyStoredAccount(parsed);
  }

  /**
   * Write a full account record (per-account file at mode 0600, atomic
   * tmp+rename) and upsert its index entry under the index lock (R2, R5, R7).
   */
  async put(account: StoredAccount): Promise<void> {
    this.assertValidUuid(account.accountUuid);
    await this.ensureDir();

    // Atomic per-account write at mode 0600. Write to a per-call unique tmp
    // sibling, chmod (umask defense — generators.ts precedent), then rename.
    // An interrupted write leaves a stray tmp but never a partial canonical
    // file (R7). writeFile({mode:0o600}) can only ever produce an owner-only
    // file (umask clears bits, never adds group/other), so the file is secure
    // by construction even if the explicit chmod fails.
    const finalPath = this.accountPath(account.accountUuid);
    const tmpPath = `${finalPath}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(tmpPath, serializeAccount(account), { mode: 0o600 });
    await chmod(tmpPath, 0o600).catch(() => {});
    await rename(tmpPath, finalPath);

    await this.updateIndex(index => {
      const others = index.accounts.filter(
        a => a.accountUuid !== account.accountUuid
      );
      const entry: AccountIndexEntry = {
        accountUuid: account.accountUuid,
        emailAddress: account.emailAddress,
        lastUsedAt: account.lastUsedAt,
      };
      return { ...index, accounts: [...others, entry] };
    });

    logger.debug(
      `[ACCOUNT_STORE] put account ${account.accountUuid} (email: ${account.emailAddress ? "present" : "absent"})`
    );
  }

  /**
   * Read the per-provider node-default account uuid from `active.json`'s
   * `byProvider` map (#3808 Task 4b). `active.json` is
   * `{ activeAccountUuid, byProvider?: { openai?, google? } }` — the top-level
   * `activeAccountUuid` stays the ANTHROPIC pointer (byte-identical for old
   * readers); `byProvider[provider]` is the OpenAI/Google node default. Returns
   * `undefined` when absent/malformed or the value fails the UUID gate. Used by
   * the un-pinned non-Anthropic spawn selection (sessionSpawner Task 4).
   */
  async getActiveProviderDefault(
    provider: string
  ): Promise<string | undefined> {
    try {
      const raw = await readFile(this.activePath, "utf-8");
      const parsed = JSON.parse(raw) as {
        byProvider?: Record<string, unknown>;
      };
      const uuid = parsed?.byProvider?.[provider];
      return typeof uuid === "string" && UUID_REGEX.test(uuid)
        ? uuid
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Issue #6800 (R2): the node's ANTHROPIC default account — `active.json`'s
   * top-level `activeAccountUuid` (written by the server-side `AccountService`).
   * An un-pinned Anthropic spawn binds it explicitly. Mirrors
   * {@link getActiveProviderDefault}: `undefined` when the file is absent or
   * malformed, or the value fails the UUID gate.
   */
  async getActiveAnthropicDefault(): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.activePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // An unreadable default is not "no default": say so, because the
        // spawn then binds a fallback account (#6800 review F7).
        logger.warn(
          `[ACCOUNT_STORE] active.json cannot be read (${code ?? "read error"}); un-pinned spawns use the fallback account`
        );
      }
      return undefined;
    }
    let uuid: unknown;
    try {
      uuid = (JSON.parse(raw) as { activeAccountUuid?: unknown })
        ?.activeAccountUuid;
    } catch {
      logger.warn(
        "[ACCOUNT_STORE] active.json is not valid JSON; un-pinned spawns use the fallback account"
      );
      return undefined;
    }
    return typeof uuid === "string" && UUID_REGEX.test(uuid) ? uuid : undefined;
  }

  /**
   * Set the per-node active-account pointer (`active.json`) to `accountUuid`,
   * but ONLY when no pointer already exists (issue #2314, KD2). This lets the
   * multi-account env-token seed (daemon startup) establish the
   * most-recently-connected account as the node default WITHOUT ever clobbering
   * an explicit operator/user choice — the server-side
   * `AccountService.setActiveAccount` remains the authoritative writer for
   * deliberate switches. Set-if-unset preserves the Fallback Preservation Rule:
   * a single-account VM (or a VM whose default was already chosen) sees no change.
   *
   * Returns true when it wrote the pointer, false when one already existed (or
   * the write raced/failed). Fail-soft — never throws; a failure just leaves the
   * pointer unset (the create-page selector always-binds even with no default).
   * The read-then-write is a benign best-effort (worst case: last-write-wins on a
   * concurrent server write at startup); it is a nice-to-have default, not an
   * invariant.
   */
  async setActiveAccountUuidIfUnset(accountUuid: string): Promise<boolean> {
    this.assertValidUuid(accountUuid);
    await this.ensureDir();
    // Do not clobber an existing pointer (present OR unreadable-but-present).
    try {
      await readFile(this.activePath, "utf-8");
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    // Absent → write atomically (mirror put()'s tmp+rename+chmod, mode 0600).
    const content = JSON.stringify({ activeAccountUuid: accountUuid }, null, 2);
    const tmpPath = `${this.activePath}.tmp.${process.pid}.${randomUUID()}`;
    try {
      await writeFile(tmpPath, content, { mode: 0o600 });
      await chmod(tmpPath, 0o600).catch(() => {});
      await rename(tmpPath, this.activePath);
      logger.debug(
        `[ACCOUNT_STORE] set active account ${accountUuid} (was unset)`
      );
      return true;
    } catch (err) {
      logger.debug(
        `[ACCOUNT_STORE] setActiveAccountUuidIfUnset failed (leaving unset): ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /**
   * Atomic read-merge-write on one account record under a per-account-file
   * cross-process lock (issue #1635, F2). Closes the lost-update window that
   * a bare get-then-put pair leaves open: two concurrent patchers (e.g. an
   * isolated-token rotation mirroring `accessToken` while another path clears
   * `unrefreshable`) could each read the same baseline and the second `put`
   * silently revert the first's fields — worst case re-publishing a
   * server-side-revoked token to the store.
   *
   * Returns true when the merge was applied, false when the record is missing
   * or malformed (mirrors `TokenRefreshService.persistPatch`'s skip semantics
   * — never invents a record). Lock failures surface as
   * {@link AccountStoreLockTimeoutError}, consistent with `updateIndex`.
   */
  async update(
    accountUuid: string,
    mergeFn: (current: StoredAccount) => StoredAccount
  ): Promise<boolean> {
    this.assertValidUuid(accountUuid);
    const lockPath = `${this.accountPath(accountUuid)}.lock`;
    try {
      return await withFileLock({ lockPath }, async () => {
        const current = await this.get(accountUuid);
        if (!current || !current.ok) return false;
        await this.put(mergeFn(current.account));
        return true;
      });
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        throw new AccountStoreLockTimeoutError(lockPath);
      }
      throw err;
    }
  }

  /**
   * Remove an account's per-account file and index entry. Idempotent for an
   * unknown UUID — no throw (R4).
   */
  async delete(accountUuid: string): Promise<void> {
    this.assertValidUuid(accountUuid);

    await unlink(this.accountPath(accountUuid)).catch(err => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });

    await this.updateIndex(index => ({
      ...index,
      accounts: index.accounts.filter(a => a.accountUuid !== accountUuid),
    }));

    logger.debug(`[ACCOUNT_STORE] delete account ${accountUuid}`);
  }

  /**
   * Read→mutate→write the index under a cross-process file lock so concurrent
   * writers serialize and neither loses an update (R5). The index is rebuilt
   * from the freshly-read on-disk copy INSIDE the lock, then written via
   * tmp+rename at mode 0600.
   */
  private async updateIndex(
    mutate: (index: AccountIndex) => AccountIndex
  ): Promise<void> {
    await this.ensureDir();
    const lockPath = `${this.indexPath}.lock`;
    try {
      await withFileLock({ lockPath }, async () => {
        const current = await this.readIndexOrEmpty();
        const next = mutate(current);
        const serialized = JSON.stringify(next, null, 2);
        const tmpPath = `${this.indexPath}.tmp.${process.pid}.${randomUUID()}`;
        await writeFile(tmpPath, serialized, { mode: 0o600 });
        await chmod(tmpPath, 0o600).catch(() => {});
        await rename(tmpPath, this.indexPath);
      });
    } catch (err) {
      if (err instanceof FileLockTimeoutError) {
        throw new AccountStoreLockTimeoutError(lockPath);
      }
      throw err;
    }
  }

  /** Read the index, or an empty index if it's absent/unparseable/malformed. */
  private async readIndexOrEmpty(): Promise<AccountIndex> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyIndex();
      throw err;
    }
    try {
      const validation = validateAccountIndex(JSON.parse(raw));
      if (validation.ok) return validation.index;
    } catch {
      // Unparseable JSON — fall through to empty so a corrupt index can't wedge
      // every future mutation.
    }
    return emptyIndex();
  }

  /**
   * True when this store holds a usable Anthropic OAuth record: provider absent
   * or `anthropic`, not an env-token account, and not quarantined with reason
   * `host-chain-shared` (#6800). A record flagged for any other reason counts.
   */
  private async hasUsableAnthropicAccount(): Promise<boolean> {
    for (const entry of await this.list()) {
      if ((entry.provider ?? "anthropic") !== "anthropic") continue;
      const res = await this.get(entry.accountUuid).catch(() => null);
      if (!res || !res.ok) continue;
      const account = res.account;
      if (isEnvTokenAccount(account)) continue;
      if (
        account.unrefreshable === true &&
        account.unrefreshableReason === HOST_CHAIN_SHARED_REASON
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * Issue #6800 (ruling D3 (ii)): when this store holds no usable Anthropic OAuth
   * record ({@link hasUsableAnthropicAccount}), adopt every independent account
   * folder on the machine. Called ONCE at each daemon boot (after the
   * shared-chain detector's boot pass, before the control server); `list()` and
   * the CLI commands never adopt. It replaces the #1447 first-run migration,
   * which copied the `~/.claude` login chain into the store.
   *
   * A folder is a UUID-named directory directly under the machine-global
   * account-configs root (legacy per-instance folders are not adopted). It is
   * adopted only when:
   *  - its `.claude.json` `oauthAccount.accountUuid` is a UUID equal to the
   *    folder name (`buildIsolatedClaudeJson` writes it; a non-Anthropic
   *    provider folder has none);
   *  - its `.credentials.json` holds both tokens, and the refresh token's
   *    fingerprint differs from the `~/.claude` fingerprint;
   *  - this store has no record for that uuid yet (a quarantined record is
   *    left as it is);
   *  - the uuid is not in this instance's removal tombstone,
   *    `accounts/removed.json` (issue #6837 R5): an Anthropic delete removes only
   *    the store record and leaves the machine-global folder, so without this an
   *    account the operator removed came back at the next daemon boot.
   * The folder of the account `~/.claude.json` names is adopted QUARANTINED
   * (`unrefreshable`, reason `host-chain-shared`, the fingerprint of the folder's
   * own token) unless a Provider Accounts sign-in marker names the folder's
   * current refresh token (issue #6837 R6). A token that merely differs from the
   * current `~/.claude` token is no proof of independence: it may be an older
   * token of the same chain (#6800 round 2, `shared/src/accounts.ts`
   * `SIGN_IN_MARKER_FILE`). Known limit: that quarantine fires on every fresh
   * store unless a Provider Accounts sign-in happened within the current token's
   * lifetime, because the marker is written only by a sign-in while every refresh
   * replaces the folder's token; one sign-in clears it.
   * Fails closed for the boot (adopts nothing, one warn) when there is no reader
   * of the account `~/.claude.json` names, when `~/.claude.json` still cannot be
   * read after {@link HOST_NAMED_READ_ATTEMPTS} reads, or when the tombstone
   * exists but cannot be read.
   * The tokens come from the FOLDER, never from `~/.claude`. Never on a tenant.
   * Never throws, never writes a folder, never writes `active.json` (I10).
   *
   * @returns the adopted uuids (quarantined ones included).
   */
  async adoptIndependentAccountFolders(
    sources: Pick<
      AccountStoreAdoptionSources,
      "readHostRefreshFingerprint" | "readHostNamedUuid"
    > & {
      /**
       * Issue #6756 (TC1): adopt nothing, silently, on a test instance. The daemon
       * passes it from its one instance-kind reading; the store never reads the kind
       * itself, because its adoption tests run on `/tmp` homes, which the classifier
       * reads as test.
       */
      skipAdoption?: boolean;
    } = {}
  ): Promise<string[]> {
    const adopted: string[] = [];
    try {
      if (this.tenantVm() || sources.skipAdoption === true) return adopted;
      if (await this.hasUsableAnthropicAccount()) return adopted;
      const readHostFp =
        sources.readHostRefreshFingerprint ??
        this.adoptionSources.readHostRefreshFingerprint;
      if (!readHostFp) {
        logger.warn(
          "[ACCOUNT_STORE] folder adoption skipped: no ~/.claude fingerprint reader"
        );
        return adopted;
      }
      const readHostNamed =
        sources.readHostNamedUuid ?? this.adoptionSources.readHostNamedUuid;
      if (!readHostNamed) {
        logger.warn(
          "[ACCOUNT_STORE] folder adoption skipped: no reader of the account ~/.claude.json names"
        );
        return adopted;
      }
      // Fixed reason text in both warns, never parser text, which could quote
      // file content.
      const removed = await this.readRemovedUuids();
      if (removed === "unreadable") {
        logger.warn(
          "[ACCOUNT_STORE] folder adoption skipped this boot: accounts/removed.json cannot be read; fix or delete accounts/removed.json, then restart the daemon"
        );
        return adopted;
      }
      const hostNamed = await this.readHostNamedWithRetry(readHostNamed);
      if (hostNamed === "unreadable") {
        logger.warn(
          "[ACCOUNT_STORE] folder adoption skipped this boot: ~/.claude.json cannot be read; it runs again at the next daemon start"
        );
        return adopted;
      }
      const hostFp = await readHostFp().catch(() => null);
      const root =
        this.adoptionSources.accountConfigsDir ??
        configuration.accountConfigsDir;
      const entries = await readdir(root, { withFileTypes: true }).catch(
        () => []
      );
      for (const entry of entries) {
        const uuid = entry.name;
        if (!entry.isDirectory() || !UUID_REGEX.test(uuid)) continue;
        const skip = (why: string): void => {
          logger.info(`[ACCOUNT_STORE] folder ${uuid} not adopted: ${why}`);
        };
        // A record it cannot read is not "no record": adopting would overwrite
        // it and drop its flag (#6800 review F12).
        let existing: Awaited<ReturnType<AccountStore["get"]>>;
        try {
          existing = await this.get(uuid);
        } catch {
          skip("its store record cannot be read");
          continue;
        }
        if (existing !== null) {
          skip("this store already has a record for it");
          continue;
        }
        if (removed.has(uuid)) {
          skip("it was removed on this instance (accounts/removed.json)");
          continue;
        }
        const identity = (
          await this.readJsonSlice<ClaudeConfigFile>(
            join(root, uuid, ".claude.json")
          )
        )?.oauthAccount;
        if (!identity?.accountUuid || identity.accountUuid !== uuid) {
          skip("its .claude.json names no matching account");
          continue;
        }
        const oauth = (
          await this.readJsonSlice<ClaudeCredentialsFile>(
            join(root, uuid, ".credentials.json")
          )
        )?.claudeAiOauth;
        if (!oauth?.accessToken || !oauth.refreshToken) {
          skip("its .credentials.json holds no login");
          continue;
        }
        const fingerprint = createHash("sha256")
          .update(oauth.refreshToken)
          .digest("hex");
        if (hostFp && fingerprint === hostFp) {
          skip("it holds the ~/.claude login chain");
          continue;
        }
        // Issue #6837 (R6): the account ~/.claude.json names is independent of
        // the ~/.claude chain only when a Provider Accounts sign-in produced the
        // folder's current token. All three flag fields go together: without the
        // reason the stale-flag clear takes its legacy probe arm, and without the
        // fingerprint the detector never sees the record as already flagged.
        const quarantine =
          hostNamed === uuid &&
          !signInMarkerNamesToken(
            await readSignInMarkerIn(join(root, uuid)),
            oauth.refreshToken
          );
        const now = Date.now();
        const validation = validateStoredAccount({
          schema_version: 1 as const,
          accountUuid: uuid,
          emailAddress: identity.emailAddress ?? "",
          organizationUuid: identity.organizationUuid ?? "",
          organizationName: identity.organizationName ?? "",
          displayName: identity.displayName ?? "",
          billingType: identity.billingType ?? "",
          subscriptionType: oauth.subscriptionType ?? "",
          rateLimitTier: oauth.rateLimitTier ?? "",
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt ?? 0,
          scopes: oauth.scopes ?? [],
          capturedAt: now,
          lastUsedAt: 0,
          lastRefreshedAt: 0,
          ...(quarantine
            ? {
                unrefreshable: true,
                unrefreshableReason: HOST_CHAIN_SHARED_REASON,
                unrefreshableTokenFingerprint: fingerprint,
              }
            : {}),
        });
        if (!validation.ok) {
          skip(`the record failed validation (${validation.error})`);
          continue;
        }
        await this.put(validation.account);
        adopted.push(uuid);
        const email = validation.account.emailAddress ? "present" : "absent";
        if (quarantine) {
          logger.info(
            `[ACCOUNT_STORE] adopted the account folder ${uuid} quarantined (host-chain-shared): it is the account ~/.claude.json names and no Provider Accounts sign-in marker names its token; sign it in again under Settings → Provider Accounts (email: ${email})`
          );
        } else {
          logger.info(
            `[ACCOUNT_STORE] adopted the independent account folder ${uuid} (email: ${email})`
          );
        }
      }
      if (adopted.length === 0) {
        logger.info(
          "[ACCOUNT_STORE] no independent account folder on this machine; sign an account in through Provider Accounts"
        );
      }
    } catch (err) {
      logger.warn(
        `[ACCOUNT_STORE] folder adoption failed (continuing): ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return adopted;
  }

  /**
   * Issue #6837 (R5): the uuids this instance's removal tombstone lists,
   * `accounts/removed.json`, written by the server's `AccountService` on every
   * account delete. Keep the shape in step with its reader
   * (`server/src/services/accountService.ts` `readTombstones`):
   * `{ schema_version, removed: string[] }`, keeping only UUID strings. A missing
   * file is an empty set. A file that exists but cannot be read, is not JSON, or
   * has no `removed` array is `"unreadable"`: adoption then fails closed, unlike
   * the server, which reads such a file as "nothing removed" because its importer
   * only hides records, while adoption would re-create a removed account. The
   * CLI never writes or deletes the file.
   */
  private async readRemovedUuids(): Promise<Set<string> | "unreadable"> {
    let raw: string;
    try {
      raw = await readFile(join(this.accountsDir, "removed.json"), "utf-8");
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT"
        ? new Set<string>()
        : "unreadable";
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const removed =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { removed?: unknown }).removed
          : undefined;
      if (!Array.isArray(removed)) return "unreadable";
      return new Set(
        removed.filter(
          (uuid): uuid is string =>
            typeof uuid === "string" && UUID_REGEX.test(uuid)
        )
      );
    } catch {
      return "unreadable";
    }
  }

  /**
   * Issue #6837 (R6): read the account `~/.claude.json` names, retrying a few
   * hundred ms apart, because adoption runs only at daemon start and a file
   * caught mid-write would otherwise leave a fresh store empty until the next
   * restart. A throw counts as `"unreadable"`.
   */
  private async readHostNamedWithRetry(
    read: () => Promise<string | null | "unreadable">
  ): Promise<string | null | "unreadable"> {
    for (let attempt = 1; ; attempt++) {
      const named = await read().catch(() => "unreadable" as const);
      if (named !== "unreadable" || attempt >= HOST_NAMED_READ_ATTEMPTS) {
        return named;
      }
      await new Promise<void>(resolve =>
        setTimeout(resolve, HOST_NAMED_READ_RETRY_MS)
      );
    }
  }

  /** Read + JSON.parse a file; undefined on any error (missing/corrupt). */
  private async readJsonSlice<T>(path: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf-8")) as T;
    } catch {
      return undefined;
    }
  }

  // --- Utilization snapshot cache (issue #3023) ---------------------------------

  /**
   * Record an account's latest utilization snapshot for the un-pinned spawn veto.
   * Written by the daemon's per-tick sampler (`utilizationSampler.ts`). In-memory
   * only — never persisted.
   */
  setUtilizationSnapshot(
    accountUuid: string,
    snapshot: UtilizationSnapshot
  ): void {
    this.utilizationSnapshots.set(accountUuid, snapshot);
  }

  /** Read an account's cached utilization snapshot, or `undefined` when none exists. */
  getUtilizationSnapshot(accountUuid: string): UtilizationSnapshot | undefined {
    return this.utilizationSnapshots.get(accountUuid);
  }

  /** Drop all cached utilization snapshots (test seam / shutdown hygiene). */
  clearUtilizationSnapshots(): void {
    this.utilizationSnapshots.clear();
  }
}

/**
 * Issue #6756 (TC1, R7, ER-D1): what a test instance's account store holds, read from
 * a DIRECTORY LISTING of `<HAPI_HOME>/accounts/` — never from `list()`, which returns
 * `[]` for a missing or malformed `index.json`, and never from an Anthropic-only test
 * (the server keeps OpenAI and Gemini records in the same folder).
 *
 *  - `marked`: the store carries {@link TEST_STORE_MARKER}, so a TC1 build created it
 *    empty and every record in it was signed in on this instance;
 *  - `empty`: no `*.json` file at all and no `<HAPI_HOME>/account-configs/`, so the
 *    marker may be written;
 *  - `unmarked-configs`: no evidence file, but `<HAPI_HOME>/account-configs/` exists
 *    (legacy per-instance login folders); never marked, so never deleted by this work;
 *  - `unmarked-bookkeeping`: only a daemon's own bookkeeping file
 *    ({@link TEST_STORE_BOOKKEEPING_FILES}); it blocks the marker (R7) but is no login;
 *  - `inherited`: some `*.json` file other than a bookkeeping file, and no marker. The
 *    store predates this work (a port's data dir outlives its worktree), even when it
 *    holds only `index.json`, `active.json` or `removed.json` (row SR, finding 28).
 *    `records` counts its `<uuid>.json` files only;
 *  - `unreadable`: the listing failed with anything but ENOENT; the caller treats it as
 *    inherited (nothing proves the store empty).
 */
export type TestStoreState =
  | { state: "marked" }
  | { state: "empty" }
  | { state: "unmarked-configs" }
  | { state: "unmarked-bookkeeping" }
  | { state: "inherited"; records: number }
  | { state: "unreadable"; code: string };

/** The legacy per-instance login folder (pre-#1643), `<HAPI_HOME>/account-configs/`. */
export const LEGACY_INSTANCE_ACCOUNT_CONFIGS = "account-configs";

function fsErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "error";
}

export async function readTestStoreState(
  accountsDir: string,
  dataDir: string
): Promise<TestStoreState> {
  let names: string[];
  try {
    names = await readdir(accountsDir);
  } catch (error) {
    const code = fsErrorCode(error);
    if (code !== "ENOENT") return { state: "unreadable", code };
    names = [];
  }
  if (names.includes(TEST_STORE_MARKER)) return { state: "marked" };
  const jsonFiles = names.filter(name => name.endsWith(".json"));
  // A daemon's own bookkeeping file is never evidence of an older store.
  const evidence = jsonFiles.filter(
    name => !TEST_STORE_BOOKKEEPING_FILES.includes(name)
  );
  if (evidence.length > 0) {
    const records = evidence.filter(name =>
      UUID_REGEX.test(name.slice(0, -".json".length))
    ).length;
    return { state: "inherited", records };
  }
  try {
    await stat(join(dataDir, LEGACY_INSTANCE_ACCOUNT_CONFIGS));
    return { state: "unmarked-configs" };
  } catch (error) {
    // Only a clean ENOENT proves the folder absent; any other error fails closed
    // (no marker), so a store this work cannot prove it created is never marked.
    if (fsErrorCode(error) !== "ENOENT") return { state: "unmarked-configs" };
    // R7: a bookkeeping file still blocks the marker (no `*.json` file at all).
    return jsonFiles.length > 0
      ? { state: "unmarked-bookkeeping" }
      : { state: "empty" };
  }
}

/**
 * Write {@link TEST_STORE_MARKER} into `accountsDir` (temp file + rename, mode 0600,
 * the dir 0700 as the store creates it). The marker holds the kind, the build and the
 * time; no account data. Never throws: on failure it returns the error code, and the
 * store simply stays unmarked (so nothing will ever delete it).
 */
export async function writeTestStoreMarker(
  accountsDir: string,
  build: string,
  now: Date = new Date()
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    await mkdir(accountsDir, { recursive: true, mode: 0o700 });
    const target = join(accountsDir, TEST_STORE_MARKER);
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const body = JSON.stringify(
      { kind: "test", build, writtenAt: now.toISOString(), issue: 6756 },
      null,
      2
    );
    await writeFile(tmp, body + "\n", { mode: 0o600, flag: "wx" });
    try {
      await rename(tmp, target);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: fsErrorCode(error) };
  }
}

/**
 * Module-level singleton (mirrors `export const configuration`). Downstream
 * sub-issues `import { accountStore } from "@/accounts/accountStore"`. The
 * constructor does no I/O, so instantiating at import time is safe; the
 * accounts dir is created lazily on first write/migration.
 */
export const accountStore = new AccountStore(configuration.accountsDir);
