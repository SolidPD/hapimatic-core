// SPDX-License-Identifier: AGPL-3.0-only
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { FileLockTimeoutError, withFileLock } from "@/utils/fileLock";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";
import {
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

/** Relevant slice of ~/.claude/.credentials.json (migration source — tokens). */
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

/** Relevant slice of ~/.claude.json (migration source — identity + PK). */
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
 * Override points for the initial-population migration sources. Default to the
 * real `~/.claude/.credentials.json` + `~/.claude.json`. Tests inject temp-dir
 * paths so they never touch the real files (issue #1447 R8 test isolation).
 */
export interface AccountStoreMigrationSources {
  credentialsPath?: string;
  claudeConfigPath?: string;
}

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
 * - The initial-population migration (capturing the machine's existing Claude
 *   Code account) runs lazily on the FIRST `list()` call — never in the
 *   constructor, never on `get`/`put`/`delete`. It never deletes the source
 *   files (R8).
 * - Token VALUES never reach the logger at any level — only `accountUuid` /
 *   `emailAddress` / counts (R9).
 */
export class AccountStore {
  private initialized = false;
  /** Set to true after the first successful account write (migration or explicit put).
   * Guards the mid-run recovery path in list() so it only fires when the store was
   * previously seeded — not on every list() call for a fresh/empty store (#1513). */
  private wasSeeded = false;

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

  constructor(
    private readonly accountsDir: string,
    private readonly migrationSources: AccountStoreMigrationSources = {}
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
   * directory or a malformed index (never crashes — R1). Triggers the lazy
   * initial-population migration on first call.
   */
  async list(): Promise<AccountIndexEntry[]> {
    await this.ensureInitialized();

    let raw: string;
    try {
      raw = await readFile(this.indexPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // Accounts directory was lost mid-run (issue #1513). Only attempt recovery
      // when the store was previously seeded (this.wasSeeded === true) — avoids
      // spurious warns on fresh stores where migration found no credentials.
      if (this.initialized && this.wasSeeded) {
        logger.warn(
          "[ACCOUNT_STORE] index file absent after initialization — accounts directory lost mid-run; attempting re-seed"
        );
        // Reset both flags so a second failed recovery doesn't repeatedly warn.
        // put() will re-set wasSeeded to true if migration succeeds.
        this.initialized = false;
        this.wasSeeded = false;
        await this.ensureInitialized();
        try {
          raw = await readFile(this.indexPath, "utf-8");
        } catch {
          return [];
        }
      } else {
        return [];
      }
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

    this.wasSeeded = true;
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
   * Run the initial-population migration once, on the first `list()` in a fresh
   * instance (no index yet). Guarded by an in-memory flag set BEFORE migration
   * runs, so the `put()` it issues never re-enters here. Best-effort: migration
   * failures are logged and swallowed so they never break `list()`.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      if (!(await this.indexExists())) {
        await this.migrateFromClaudeCredentials();
      }
    } catch (err) {
      logger.debug(
        `[ACCOUNT_STORE] initial migration failed (continuing empty): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async indexExists(): Promise<boolean> {
    try {
      await readFile(this.indexPath, "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Capture the machine's existing Claude Code account as the initial store
   * entry (R8). Tokens come from `~/.claude/.credentials.json` `claudeAiOauth`;
   * identity (incl. the primary key `accountUuid`) from `~/.claude.json`
   * `oauthAccount`. Skips gracefully when either source lacks the required
   * pieces — a record cannot exist without its PK or tokens. NEVER reads
   * `mcpOAuth` and NEVER deletes the source files.
   */
  private async migrateFromClaudeCredentials(): Promise<void> {
    const credentialsPath =
      this.migrationSources.credentialsPath ??
      join(homedir(), ".claude", ".credentials.json");
    const claudeConfigPath =
      this.migrationSources.claudeConfigPath ?? join(homedir(), ".claude.json");

    const credFile =
      await this.readJsonSlice<ClaudeCredentialsFile>(credentialsPath);
    const cfgFile =
      await this.readJsonSlice<ClaudeConfigFile>(claudeConfigPath);
    const oauth = credFile?.claudeAiOauth;
    const identity = cfgFile?.oauthAccount;

    if (!oauth?.accessToken || !identity?.accountUuid) {
      logger.debug(
        `[ACCOUNT_STORE] migration skipped (tokens: ${oauth?.accessToken ? "present" : "absent"}, accountUuid: ${identity?.accountUuid ? "present" : "absent"})`
      );
      return;
    }

    const now = Date.now();
    const candidate = {
      schema_version: 1 as const,
      accountUuid: identity.accountUuid,
      emailAddress: identity.emailAddress ?? "",
      organizationUuid: identity.organizationUuid ?? "",
      organizationName: identity.organizationName ?? "",
      displayName: identity.displayName ?? "",
      billingType: identity.billingType ?? "",
      subscriptionType: oauth.subscriptionType ?? "",
      rateLimitTier: oauth.rateLimitTier ?? "",
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken ?? "",
      expiresAt: oauth.expiresAt ?? 0,
      scopes: oauth.scopes ?? [],
      capturedAt: now,
      lastUsedAt: 0,
      lastRefreshedAt: 0,
    };

    const validation = validateStoredAccount(candidate);
    if (!validation.ok) {
      logger.debug(
        `[ACCOUNT_STORE] migration candidate failed validation (${validation.error}); skipping`
      );
      return;
    }

    await this.put(validation.account);
    logger.debug(
      `[ACCOUNT_STORE] migrated initial account ${validation.account.accountUuid} (email: ${validation.account.emailAddress ? "present" : "absent"})`
    );
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
 * Module-level singleton (mirrors `export const configuration`). Downstream
 * sub-issues `import { accountStore } from "@/accounts/accountStore"`. The
 * constructor does no I/O, so instantiating at import time is safe; the
 * accounts dir is created lazily on first write/migration.
 */
export const accountStore = new AccountStore(configuration.accountsDir);
