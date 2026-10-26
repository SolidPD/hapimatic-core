// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type AnyStoredAccount,
  type OpenAiStoredAccount,
  type GoogleStoredAccount,
} from "@hapi/protocol";

/**
 * Provider-account record importer (issue #3808, epic #3345 — non-Anthropic
 * parity). Turns #3807's on-disk artifacts into #3808 store records WITHOUT a
 * stamping migration:
 *  - each per-account codex dir `<accountConfigsDir>/<pk>/codex/` (+ its
 *    non-secret `provider-account.json` sidecar) → an OpenAI record;
 *  - the host `~/.codex` login → an OpenAI record whose `codexHome` REFERENCES
 *    the host dir (no credential copied);
 *  - the pre-#3808 single Gemini vault key (no `accountUuid`) → Google account
 *    #1 with a minted PK, stamped back onto the vault entry so the reference
 *    resolves.
 *
 * IDEMPOTENT by construction — a PK whose `<pk>.json` record already exists is
 * skipped, so re-running (on `AccountService` first `list()` and after each
 * #3807 login success) creates each record exactly once. The `records` this
 * writes carry only a REFERENCE (a `codexHome` path / a `vaultKeyRef`); the
 * importer NEVER opens, prints, or copies a live token or key value — it reads
 * only codex `auth.json`'s `auth_mode` + `tokens.account_id` (a non-secret id)
 * and the account-configs sidecars. [ER 2026-09-19: 3808-2] [ER 2026-09-19: 3808-8]
 * [ER 2026-09-19: D4] [ER 2026-09-19: K-CODEX-HOME]
 */

/** RFC 4122 v5 namespace (the DNS namespace) for a deterministic OpenAI PK. */
const UUID_V5_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Canonical UUID (8-4-4-4-12 hex) — the store's path-traversal gate. */
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Deterministic UUID-v5 over a name (D4: "if a non-UUID id is ever seen, uuid-v5
 * over `openai:<id>`"). Returns a canonical, path-safe UUID that is STABLE for a
 * given id, so the same host login imports to the same PK across runs/instances.
 * Exported for #4463, which mints a Gemini key's Google account as
 * `uuidV5("google:<vault entry id>")` at add time.
 */
export function uuidV5(name: string): string {
  const nsHex = UUID_V5_NAMESPACE.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");
  const hash = createHash("sha1");
  hash.update(nsBytes);
  hash.update(Buffer.from(name, "utf8"));
  const bytes = hash.digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.subarray(0, 16).toString("hex");
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

/** OpenAI PK (D4): codex's account id when UUID-shaped, else uuid-v5(`openai:<id>`).
 *  Exported for the #3806 auth-state reader, which keys the host login row by this
 *  same PK (#3982) so the Accounts page can join it to its store record. */
export function openAiPk(accountId: string): string {
  return UUID_REGEX.test(accountId) ? accountId : uuidV5(`openai:${accountId}`);
}

/** The narrow codex `auth.json` slice we DERIVE from — tokens never escape here. */
interface CodexAuthDotJson {
  auth_mode?: string;
  tokens?: { account_id?: string } | null;
}

/** Map codex `auth_mode` to the stored `authMode` literal, or null if indeterminate. */
function toStoredAuthMode(
  raw: string | undefined
): OpenAiStoredAccount["authMode"] | null {
  if (raw === "chatgpt") return "chatgpt";
  if (raw === "apikey") return "api-key";
  return null;
}

/** Read + narrowly parse a codex `auth.json`; null on absent/corrupt. */
function readCodexAuth(codexHome: string): CodexAuthDotJson | null {
  const authPath = join(codexHome, "auth.json");
  if (!existsSync(authPath)) return null;
  try {
    return JSON.parse(readFileSync(authPath, "utf8")) as CodexAuthDotJson;
  } catch {
    return null;
  }
}

/** The non-secret `provider-account.json` sidecar #3807 writes beside `<pk>/codex/`. */
interface ProviderAccountSidecar {
  provider?: string;
  authMode?: string;
  label?: string;
}

function readSidecar(
  accountConfigsDir: string,
  pk: string
): ProviderAccountSidecar | null {
  const path = join(accountConfigsDir, pk, "provider-account.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProviderAccountSidecar;
  } catch {
    return null;
  }
}

/** One Gemini vault entry, provider-agnostic view (only the non-secret fields). */
export interface GeminiVaultEntry {
  id: string;
  label?: string;
  /** Present ⇒ already bound to an account (skip). Absent ⇒ the pre-#3808 key. */
  accountUuid?: string;
}

export interface ProviderAccountImportDeps {
  /** Machine-global account-configs dir (parent of `<pk>/codex/`). */
  accountConfigsDir: string;
  /** Host codex home (`$CODEX_HOME` || `~/.codex`). */
  hostCodexHome: string;
  /** True when a stored record already exists for this PK (idempotency gate). */
  hasRecord: (pk: string) => boolean;
  /** Persist one new record (writes the per-account file + index). */
  addAccount: (account: AnyStoredAccount) => void;
  /** The node's `gemini`/`google` vault entries (non-secret view). */
  readGeminiVaultEntries: () => GeminiVaultEntry[];
  /** Stamp a minted `accountUuid` onto a vault entry (persists settings.json). */
  stampGeminiVaultAccountUuid: (entryId: string, accountUuid: string) => void;
  /** Clock injection for deterministic tests. Default: `Date.now`. */
  now?: () => number;
  /** UUID minting injection for deterministic tests. Default: `randomUUID`. */
  mintUuid?: () => string;
}

export interface ProviderAccountImportResult {
  imported: { openai: number; google: number };
  skipped: number;
}

/**
 * Import #3807's provider artifacts into #3808 store records. Never throws — a
 * malformed dir/sidecar/vault entry is skipped, not surfaced.
 */
export function importProviderAccounts(
  deps: ProviderAccountImportDeps
): ProviderAccountImportResult {
  const now = deps.now ?? (() => Date.now());
  const mintUuid = deps.mintUuid ?? randomUUID;
  const result: ProviderAccountImportResult = {
    imported: { openai: 0, google: 0 },
    skipped: 0,
  };

  // ── OpenAI: per-account codex dirs (source:"account") ──────────────────────
  if (existsSync(deps.accountConfigsDir)) {
    let pks: string[] = [];
    try {
      pks = readdirSync(deps.accountConfigsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      pks = [];
    }
    for (const pk of pks) {
      // PK is the dir name #3807 created — must be a canonical UUID (path gate).
      if (!UUID_REGEX.test(pk)) continue;
      const codexHome = join(deps.accountConfigsDir, pk, "codex");
      if (!existsSync(codexHome)) continue;
      if (deps.hasRecord(pk)) {
        result.skipped++;
        continue;
      }
      const sidecar = readSidecar(deps.accountConfigsDir, pk);
      // authMode: sidecar first (#3807's authoritative record), else codex auth.json.
      const auth = readCodexAuth(codexHome);
      const authMode =
        toStoredAuthMode(sidecar?.authMode) ??
        toStoredAuthMode(auth?.auth_mode);
      if (!authMode) {
        // Keyring-stored / indeterminate login — cannot classify; leave it as a
        // synthetic reader-only row rather than write a mis-typed record.
        result.skipped++;
        continue;
      }
      const record: OpenAiStoredAccount = {
        schema_version: 1,
        provider: "openai",
        accountUuid: pk,
        label: sidecar?.label ?? pk,
        authMode,
        codexHome,
        capturedAt: now(),
        lastUsedAt: 0,
      };
      deps.addAccount(record);
      result.imported.openai++;
    }
  }

  // ── OpenAI: the host ~/.codex login (source:"host") ────────────────────────
  // A REFERENCE to the host dir — no credential copied. Skipped when auth.json is
  // absent (keyring storage → a synthetic non-store row) or carries no account id.
  const hostAuth = readCodexAuth(deps.hostCodexHome);
  const hostAuthMode = toStoredAuthMode(hostAuth?.auth_mode);
  const hostAccountId = hostAuth?.tokens?.account_id;
  if (hostAuth && hostAuthMode && hostAccountId) {
    const pk = openAiPk(hostAccountId);
    if (!deps.hasRecord(pk)) {
      const record: OpenAiStoredAccount = {
        schema_version: 1,
        provider: "openai",
        accountUuid: pk,
        label: "Host ChatGPT login",
        authMode: hostAuthMode,
        codexHome: deps.hostCodexHome,
        capturedAt: now(),
        lastUsedAt: 0,
      };
      deps.addAccount(record);
      result.imported.openai++;
    } else {
      result.skipped++;
    }
  }

  // ── Google: the pre-#3808 unbound Gemini vault key → account #1 ─────────────
  // The single legacy key (no accountUuid) becomes Google account #1: mint a PK,
  // write a record that REFERENCES the vault by (gemini, accountUuid), and stamp
  // that accountUuid back onto the vault entry so the reference resolves. Once
  // stamped, next run finds `accountUuid` present and skips — that IS the
  // idempotency. #3807 writes new Gemini keys already bound (accountUuid set), so
  // only the legacy unbound key is ever imported.
  for (const entry of deps.readGeminiVaultEntries()) {
    if (entry.accountUuid) continue; // already bound — skip
    const accountUuid = mintUuid();
    const record: GoogleStoredAccount = {
      schema_version: 1,
      provider: "google",
      accountUuid,
      label: entry.label ?? "Gemini",
      vaultKeyRef: { provider: "gemini", accountUuid },
      capturedAt: now(),
      lastUsedAt: 0,
    };
    deps.addAccount(record);
    deps.stampGeminiVaultAccountUuid(entry.id, accountUuid);
    result.imported.google++;
  }

  return result;
}
