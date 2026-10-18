// SPDX-License-Identifier: AGPL-3.0-only
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  StoredAccountSchema,
  ProviderIdSchema,
  validateAnyStoredAccount,
  accountProviderOf,
  isNativeAnthropicAccount,
  type StoredAccount,
  type AnyStoredAccount,
  type OpenAiStoredAccount,
  type ProviderId,
} from "@hapi/protocol";
import {
  importProviderAccounts,
  type GeminiVaultEntry,
} from "./providerAccountImport";

/**
 * Server-side read/write access to the Hapimatic account store (issue #1451,
 * Sub-Issue E of epic #1446 — multi-account OAuth switcher).
 *
 * The `server` package cannot import the cli-side `AccountStore`
 * (`cli/src/accounts/`) — the only workspace dependency is `@hapi/protocol`.
 * So this service reads/writes `<dataDir>/accounts/` directly, validating with
 * A's `StoredAccountSchema`. `<dataDir>/accounts` resolves to the SAME physical
 * directory the cli store writes (both rooted at `HAPI_HOME`), so the server
 * sees exactly what the cli wrote.
 *
 * Reads enumerate the per-account `<uuid>.json` files (source of truth, robust
 * to `index.json` staleness, and the lightweight index only carries 3 of the
 * 12 redacted fields). Writes are atomic (tmp + rename, mode 0600). The cli
 * store serializes its index mutations under a cross-process file lock; this
 * service cannot share that lock (cli-only), so the best-effort `index.json`
 * update on delete carries a small lockless-write race — the directive's
 * A/F/B hardening item. E's per-account writes are always atomic.
 */

/**
 * Canonical UUID format (8-4-4-4-12 hex). `accountUuid` is used as a filesystem
 * path component, so this is the path-traversal defense: a value like
 * `../escape` or `index` cannot pass. Mirrors `UUID_REGEX` in the cli-side
 * `AccountStore` (issue #1447 R11).
 */
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Redacted account shape returned over the HTTP API (issue #1451 R11).
 *
 * Whitelist-by-construction: this schema lists ONLY display-safe fields. It
 * structurally CANNOT carry `accessToken` / `refreshToken` / `scopes`, so a
 * token value can never reach an HTTP response even if `StoredAccount` (a
 * `.passthrough()` schema) gains new token-bearing fields later.
 */
export const RedactedAccountSchema = z.object({
  // #3808: every row carries its provider (emitted EXPLICITLY — "anthropic" for
  // legacy records whose on-disk `provider` is absent). Non-Anthropic rows leave
  // the Anthropic OAuth fields blank (they have no such fields). [ER 2026-09-19: 3808-2]
  provider: ProviderIdSchema,
  accountUuid: z.string(),
  emailAddress: z.string(),
  organizationUuid: z.string(),
  organizationName: z.string(),
  displayName: z.string(),
  billingType: z.string(),
  subscriptionType: z.string(),
  rateLimitTier: z.string(),
  // #3392: ADVISORY CACHE — the store-cache copy of the token expiry surfaced over
  // `GET /api/accounts`. Non-authoritative for availability: it LAGS the live
  // isolated `.credentials.json` by up to ~24h for isolated accounts (#1635). No
  // availability or session-binding gate may read it (incl. #2457's server-side
  // binding gate — it must NOT read store `expiresAt`). The HARD availability gate
  // is the `unrefreshable` flag below; `AccountUsage.status` (`GET /api/accounts/usage`,
  // derived from the `resolveToken` result) is a live probe usable only as a SOFT
  // signal — `"expired"` → confirm, never a disable (pre-#2281 it also fires for a
  // refreshable token at/past `expiresAt−5min`). Do NOT gate availability on
  // `AccountUsage.status`. Kept as display metadata.
  expiresAt: z.number(),
  capturedAt: z.number(),
  lastUsedAt: z.number(),
  // #3392: ADVISORY CACHE (see `expiresAt` above) — non-authoritative for availability.
  lastRefreshedAt: z.number(),
  // #1658: sticky dead-family flag (re-login required). Display metadata, not
  // a credential — normalized from StoredAccount's optional field at the
  // redaction boundary (absent ⇒ false), so it is always present here.
  unrefreshable: z.boolean(),
  // #4568 (D-4568-3 A): an OpenAI record's login kind ("chatgpt" | "api-key") so
  // the spawn picker can label each Codex credential. Display metadata — it names
  // HOW the record signs in, never a credential. Emitted for openai rows only.
  authMode: z.enum(["chatgpt", "api-key"]).optional(),
});

export type RedactedAccount = z.infer<typeof RedactedAccountSchema>;

/**
 * Map a full `StoredAccount` to its redacted view. Explicit field-by-field
 * construction (never a spread) is the structural guarantee that token values
 * cannot leak (mirrors `toSessionSummary`). Adding a token field to
 * `StoredAccount` cannot accidentally surface it here.
 */
export function toRedactedAccount(account: AnyStoredAccount): RedactedAccount {
  const provider = accountProviderOf(account);
  // #4349: a token-less account signed in inside the VM — identity only; no expiry, no refresh.
  if (isNativeAnthropicAccount(account)) {
    return {
      provider,
      accountUuid: account.accountUuid,
      emailAddress: account.emailAddress,
      organizationUuid: account.organizationUuid,
      organizationName: account.organizationName,
      displayName: account.displayName,
      billingType: account.billingType,
      subscriptionType: "",
      rateLimitTier: "",
      expiresAt: 0,
      capturedAt: account.capturedAt,
      lastUsedAt: account.lastUsedAt,
      lastRefreshedAt: 0,
      unrefreshable: false,
    };
  }
  if (provider === "anthropic") {
    const a = account as StoredAccount;
    return {
      provider,
      accountUuid: a.accountUuid,
      emailAddress: a.emailAddress,
      organizationUuid: a.organizationUuid,
      organizationName: a.organizationName,
      displayName: a.displayName,
      billingType: a.billingType,
      subscriptionType: a.subscriptionType,
      rateLimitTier: a.rateLimitTier,
      expiresAt: a.expiresAt,
      capturedAt: a.capturedAt,
      lastUsedAt: a.lastUsedAt,
      lastRefreshedAt: a.lastRefreshedAt,
      unrefreshable: a.unrefreshable ?? false,
    };
  }
  // #3808: openai | google — no Anthropic OAuth fields exist on the record, so the
  // Anthropic-shaped columns are display-safe blanks. `displayName` surfaces the
  // account's `label`; an OpenAI ChatGPT login may carry an `emailAddress`.
  const p = account as OpenAiStoredAccount | { label: string };
  const emailAddress =
    provider === "openai"
      ? ((account as OpenAiStoredAccount).emailAddress ?? "")
      : "";
  return {
    provider,
    accountUuid: (account as { accountUuid: string }).accountUuid,
    emailAddress,
    organizationUuid: "",
    organizationName: "",
    displayName: (p as { label: string }).label,
    billingType: "",
    subscriptionType: "",
    rateLimitTier: "",
    expiresAt: 0,
    capturedAt: (account as { capturedAt: number }).capturedAt,
    lastUsedAt: (account as { lastUsedAt: number }).lastUsedAt,
    lastRefreshedAt: 0,
    unrefreshable: false,
    // #4568: the Codex login kind, field-by-field (never a spread) — openai only.
    ...(provider === "openai"
      ? { authMode: (account as OpenAiStoredAccount).authMode }
      : {}),
  };
}

export type DeleteAccountResult =
  | { ok: true }
  | { ok: false; code: "last_account" | "not_found" };

export type SetActiveAccountResult =
  | { ok: true }
  | { ok: false; code: "not_found" };

/** Shape of the per-node active-account pointer file (`active.json`).
 *  #3808 Task 4b: `activeAccountUuid` stays the ANTHROPIC pointer (byte-identical
 *  for old readers); the OPTIONAL `byProvider` map holds the OpenAI/Google node
 *  defaults, so setting one never touches the others. */
const ActivePointerSchema = z.object({
  activeAccountUuid: z.string().nullable(),
  byProvider: z
    .object({
      openai: z.string().optional(),
      google: z.string().optional(),
    })
    .passthrough()
    .optional(),
});
type ActivePointer = z.infer<typeof ActivePointerSchema>;

export class AccountService {
  private readonly accountsDir: string;
  /** #3808: guards the once-per-process provider-record import (idempotent, but
   *  a per-`list()` filesystem sweep would be wasteful). */
  private providerImportDone = false;

  constructor(dataDir: string) {
    this.accountsDir = join(dataDir, "accounts");
  }

  /**
   * Import #3807's provider artifacts into #3808 store records — once per process
   * by default (`force` re-runs it after a new #3807 login; the import is
   * idempotent either way). Wires the {@link importProviderAccounts} `hasRecord`
   * / `addAccount` seams to this store and takes the async vault I/O from the
   * caller (the accounts route, where `configuration` + settings are in scope), so
   * this service stays decoupled from `config/settings`. Best-effort — never
   * throws, so a bad artifact / vault read never breaks `GET /api/accounts` (#3808).
   */
  async importProviderAccountsOnce(
    deps: {
      accountConfigsDir: string;
      hostCodexHome: string;
      /** Read the node's `gemini`/`google` vault entries (async — settings I/O). */
      readGeminiVaultEntries: () => Promise<GeminiVaultEntry[]>;
      /** Persist the minted `accountUuid` stamps back onto the vault entries. */
      applyVaultStamps: (
        stamps: Array<{ entryId: string; accountUuid: string }>
      ) => Promise<void>;
    },
    opts?: { force?: boolean }
  ): Promise<void> {
    if (this.providerImportDone && !opts?.force) return;
    this.providerImportDone = true;
    try {
      const geminiEntries = await deps.readGeminiVaultEntries();
      const stamps: Array<{ entryId: string; accountUuid: string }> = [];
      importProviderAccounts({
        accountConfigsDir: deps.accountConfigsDir,
        hostCodexHome: deps.hostCodexHome,
        readGeminiVaultEntries: () => geminiEntries,
        stampGeminiVaultAccountUuid: (entryId, accountUuid) =>
          stamps.push({ entryId, accountUuid }),
        hasRecord: uuid => this.getRawAny(uuid) !== null,
        addAccount: account => this.add(account),
      });
      if (stamps.length > 0) await deps.applyVaultStamps(stamps);
    } catch {
      // Best-effort: a malformed artifact / vault read must never break the read path.
    }
  }

  private accountPath(accountUuid: string): string {
    return join(this.accountsDir, `${accountUuid}.json`);
  }

  private get indexPath(): string {
    return join(this.accountsDir, "index.json");
  }

  private get activePath(): string {
    return join(this.accountsDir, "active.json");
  }

  /**
   * Enumerate the per-account file UUIDs. Filters to canonical-UUID `*.json`
   * names, which excludes `index.json`, `active.json`, and any `.tmp`/`.lock`
   * siblings by construction. Returns `[]` for an absent/empty store.
   */
  private listAccountUuids(): string[] {
    let entries: string[];
    try {
      entries = readdirSync(this.accountsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter(name => name.endsWith(".json"))
      .map(name => name.slice(0, -".json".length))
      .filter(uuid => UUID_REGEX.test(uuid));
  }

  /**
   * Read + validate one full record by UUID, or null if absent/invalid.
   *
   * ANTHROPIC-ONLY by construction (#3808): validates with `StoredAccountSchema`,
   * so a non-Anthropic record on disk fails validation and returns `null`. This
   * is deliberately kept anthropic-shaped — every Anthropic-only caller
   * (`syncEngine`/`accountRestart` account-switch, `claudeModelCatalog`,
   * `autoSwitchOnRateLimit`, `usageService`) reads `accessToken`/`subscriptionType`
   * and MUST skip provider records. That skip is the R7 filter, for free. Callers
   * that need the provider-aware union use {@link getRawAny}.
   */
  getRaw(accountUuid: string): StoredAccount | null {
    if (!UUID_REGEX.test(accountUuid)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.accountPath(accountUuid), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = StoredAccountSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  /**
   * Read + validate one full record by UUID as the PROVIDER-AWARE union (#3808) —
   * returns Anthropic, OpenAI, or Google records. Used by the provider-inclusive
   * read path (`list()`, the redacted `get()`, the per-session binding resolver).
   * Byte-identical to {@link getRaw} for an Anthropic record.
   */
  getRawAny(accountUuid: string): AnyStoredAccount | null {
    if (!UUID_REGEX.test(accountUuid)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.accountPath(accountUuid), "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = validateAnyStoredAccount(parsed);
    return result.ok ? result.account : null;
  }

  /**
   * All accounts on this node, redacted — ACROSS providers (#3808). Each row
   * carries its `provider`; the Task-1b enumerators filter to
   * `provider === "anthropic"` before any Anthropic-shaped processing.
   */
  list(): RedactedAccount[] {
    const out: RedactedAccount[] = [];
    for (const uuid of this.listAccountUuids()) {
      const account = this.getRawAny(uuid);
      if (account) out.push(toRedactedAccount(account));
    }
    return out;
  }

  /** One redacted account by UUID, or null if unknown. Provider-aware (#3808). */
  get(accountUuid: string): RedactedAccount | null {
    const account = this.getRawAny(accountUuid);
    return account ? toRedactedAccount(account) : null;
  }

  /**
   * Remove an account. Refuses to delete the ONLY stored account (R4 — the
   * "I removed my only login" footgun) with code `last_account`. An unknown
   * UUID returns `not_found`.
   *
   * #4463: `allowLastOfProvider` is for `DELETE /api/api-keys/:id`, which removes a
   * Gemini key together with its Google mirror record. It is honoured ONLY for a
   * record carrying a `vaultKeyRef` (the record holds no credential — a key card's
   * "Remove Key" must not be refused because it is the node's only Google
   * account). On that path a per-node default pointer naming the removed uuid is
   * cleared too, so no default points at a deleted account (#3982 Task 1 shape;
   * #3982 extends the cleanup to every delete and adds its tombstone).
   */
  delete(
    accountUuid: string,
    opts?: { allowLastOfProvider?: boolean }
  ): DeleteAccountResult {
    if (!UUID_REGEX.test(accountUuid)) return { ok: false, code: "not_found" };
    const uuids = this.listAccountUuids();
    if (!uuids.includes(accountUuid)) return { ok: false, code: "not_found" };
    const vaultMirror =
      opts?.allowLastOfProvider === true &&
      "vaultKeyRef" in (this.getRawAny(accountUuid) ?? {});

    // #3808: the last-account guard is now PER-PROVIDER. Removing the only OpenAI
    // account must succeed while Anthropic accounts remain, and removing the only
    // Anthropic account must still trip the guard even when a provider account is
    // present. Classify the target and count its same-provider siblings. A record
    // that fails validation (getRawAny → null) is junk and is not counted (and a
    // junk target file is deletable — it is not a real account).
    const target = this.getRawAny(accountUuid);
    if (target) {
      const targetProvider = accountProviderOf(target);
      let sameProviderCount = 0;
      for (const uuid of uuids) {
        const acct = this.getRawAny(uuid);
        if (acct && accountProviderOf(acct) === targetProvider) {
          sameProviderCount++;
        }
      }
      if (sameProviderCount <= 1 && !vaultMirror) {
        return { ok: false, code: "last_account" };
      }
    }

    unlinkSync(this.accountPath(accountUuid));
    // Best-effort: keep the cli store's index.json consistent so its
    // index-based list() does not surface a phantom entry. Non-fatal — the
    // per-account file (source of truth) is already gone.
    this.removeFromIndex(accountUuid);
    if (vaultMirror) this.clearActivePointerTo(accountUuid);
    return { ok: true };
  }

  /** #4463: drop any per-node default (`activeAccountUuid` or a `byProvider`
   *  entry) that names `accountUuid`. Best-effort — the record is already gone. */
  private clearActivePointerTo(accountUuid: string): void {
    try {
      const pointer = this.readActivePointer();
      if (!pointer) return;
      const byProvider = pointer.byProvider
        ? Object.fromEntries(
            Object.entries(pointer.byProvider).filter(
              ([, uuid]) => uuid !== accountUuid
            )
          )
        : undefined;
      const changed =
        pointer.activeAccountUuid === accountUuid ||
        Object.keys(byProvider ?? {}).length !==
          Object.keys(pointer.byProvider ?? {}).length;
      if (!changed) return;
      const next: ActivePointer = {
        activeAccountUuid:
          pointer.activeAccountUuid === accountUuid
            ? null
            : pointer.activeAccountUuid,
        ...(byProvider ? { byProvider } : {}),
      };
      this.atomicWrite(this.activePath, JSON.stringify(next, null, 2));
    } catch {
      // Non-fatal: a dangling pointer already reads as "no active account".
    }
  }

  /**
   * Persist a new (or re-login) account record (issue #1263 — web-initiated
   * OAuth login). Atomic per-account write (tmp + rename, mode 0600) + a
   * best-effort index upsert.
   *
   * Mirrors `delete()`'s lockless-index tradeoff: the per-account file is the
   * source of truth (`AccountService.list()` / `get()` read the files directly,
   * not `index.json`), so a rare write-race on `index.json` only delays the cli
   * `TokenRefreshService`'s PROACTIVE refresh of this account — binding the
   * account (which reads the per-account file directly via `accountStore.get()`)
   * repairs the index through the reactive refresh path. Re-login on an existing
   * `accountUuid` overwrites the prior record (refreshed tokens, cleared
   * `unrefreshable`).
   */
  add(account: AnyStoredAccount): void {
    if (!UUID_REGEX.test(account.accountUuid)) {
      throw new Error(
        `Invalid accountUuid: refusing to write '${account.accountUuid}' as a path component`
      );
    }
    this.atomicWrite(
      this.accountPath(account.accountUuid),
      JSON.stringify(account, null, 2)
    );
    // #3808: index the record's provider (for NEW non-Anthropic records only —
    // absent ⇒ anthropic). `emailAddress` is Anthropic/OpenAI-only; a Google
    // record has none, so it indexes as "".
    const emailAddress =
      "emailAddress" in account && typeof account.emailAddress === "string"
        ? account.emailAddress
        : "";
    this.upsertIndex(
      account.accountUuid,
      emailAddress,
      account.lastUsedAt,
      accountProviderOf(account)
    );
  }

  /** Add/replace an entry in index.json (best-effort, never throws). */
  private upsertIndex(
    accountUuid: string,
    emailAddress: string,
    lastUsedAt: number,
    provider?: ProviderId
  ): void {
    try {
      let parsed: {
        schema_version?: number;
        accounts?: Array<{
          accountUuid: string;
          emailAddress: string;
          lastUsedAt: number;
          provider?: ProviderId;
        }>;
      } = {};
      try {
        parsed = JSON.parse(readFileSync(this.indexPath, "utf-8"));
      } catch {
        // Absent/corrupt index — start fresh.
      }
      const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      const others = accounts.filter(a => a.accountUuid !== accountUuid);
      // #3808: write `provider` ONLY for non-Anthropic records (absent ⇒ anthropic),
      // so no existing Anthropic index entry is rewritten with a provider tag.
      const entry = {
        accountUuid,
        emailAddress,
        lastUsedAt,
        ...(provider && provider !== "anthropic" ? { provider } : {}),
      };
      const next = {
        schema_version: parsed.schema_version ?? 1,
        accounts: [...others, entry],
      };
      this.atomicWrite(this.indexPath, JSON.stringify(next, null, 2));
    } catch {
      // Non-fatal — the per-account file is the source of truth and is already
      // written. The cli `AccountStore` rebuilds index entries on its next
      // locked `put()` for this account (reactive refresh on first bind).
    }
  }

  /** Read + parse the active-account pointer, or null if absent/malformed. */
  private readActivePointer(): ActivePointer | null {
    let raw: string;
    try {
      raw = readFileSync(this.activePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const result = ActivePointerSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }

  /**
   * The current active account for this node (redacted), or null. #3808 Task 4b:
   * an optional `provider` reads the PER-PROVIDER default (`byProvider[provider]`)
   * for OpenAI/Google; absent / "anthropic" reads the top-level `activeAccountUuid`
   * (today's behaviour, byte-identical).
   */
  getActiveAccount(provider?: ProviderId): RedactedAccount | null {
    const pointer = this.readActivePointer();
    if (!pointer) return null;
    const uuid =
      provider && provider !== "anthropic"
        ? pointer.byProvider?.[provider]
        : pointer.activeAccountUuid;
    if (!uuid) return null;
    return this.get(uuid);
  }

  /**
   * Set the active-account pointer. An unknown UUID returns `not_found`. #3808
   * Task 4b: an optional `provider` sets the PER-PROVIDER default (merged into
   * `byProvider`, leaving `activeAccountUuid` and the sibling providers untouched);
   * absent / "anthropic" sets `activeAccountUuid` (today's behaviour, preserving
   * any existing `byProvider`).
   */
  setActiveAccount(
    accountUuid: string,
    provider?: ProviderId
  ): SetActiveAccountResult {
    // Provider-aware existence check so an OpenAI/Google account can be set as its
    // provider's default (getRaw is Anthropic-only).
    if (!this.getRawAny(accountUuid)) return { ok: false, code: "not_found" };
    const existing = this.readActivePointer();
    const next: ActivePointer =
      provider && provider !== "anthropic"
        ? {
            activeAccountUuid: existing?.activeAccountUuid ?? null,
            byProvider: {
              ...(existing?.byProvider ?? {}),
              [provider]: accountUuid,
            },
          }
        : {
            activeAccountUuid: accountUuid,
            ...(existing?.byProvider
              ? { byProvider: existing.byProvider }
              : {}),
          };
    this.atomicWrite(this.activePath, JSON.stringify(next, null, 2));
    return { ok: true };
  }

  /** Atomic write via a per-call unique tmp sibling + rename (mode 0600). */
  private atomicWrite(finalPath: string, content: string): void {
    if (!existsSync(this.accountsDir)) {
      mkdirSync(this.accountsDir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = `${finalPath}.tmp.${process.pid}.${randomUUID()}`;
    writeFileSync(tmpPath, content, { mode: 0o600 });
    renameSync(tmpPath, finalPath);
  }

  /** Remove an entry from index.json if present (best-effort, never throws). */
  private removeFromIndex(accountUuid: string): void {
    try {
      const raw = readFileSync(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        schema_version?: number;
        accounts?: Array<{ accountUuid: string }>;
      };
      if (!Array.isArray(parsed.accounts)) return;
      const next = {
        ...parsed,
        accounts: parsed.accounts.filter(a => a.accountUuid !== accountUuid),
      };
      this.atomicWrite(this.indexPath, JSON.stringify(next, null, 2));
    } catch {
      // Absent/corrupt index, or a write race — non-fatal. The per-account
      // file is the source of truth and has already been removed.
    }
  }
}
