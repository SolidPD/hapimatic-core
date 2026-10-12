// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

import type { ClaudeAccountInfo } from "./schemas";
import { ProviderIdSchema, type ProviderId } from "./providerAuthState";

/**
 * Account credential storage contract — Zod schemas for Hapimatic-managed
 * Anthropic OAuth accounts (issue #1447, foundation sub-issue of epic #1446).
 *
 * Single source of truth for the on-disk shape of a stored account and the
 * fast-enumeration index. Defined here in `@hapi/protocol` (shared) so the CLI
 * store (`cli/src/accounts/`) and every downstream sub-issue (B–K) consume ONE
 * schema — no per-package duplication.
 *
 * `schema_version` + `.passthrough()` give forward-compatibility for schema
 * evolution once downstream data accumulates. Mirrors the `worktreeMeta.ts`
 * pattern: schema + `z.infer` type + never-throws `validateX()` helper.
 *
 * Security note: per-account files are written at mode 0600 and token VALUES
 * (`accessToken`/`refreshToken`) never appear in logs — those are enforcement
 * concerns of the CLI `AccountStore`, not the schema. The schema validates
 * shape only.
 */

export const StoredAccountSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    // Issue #2268: auth-kind discriminator.
    //  - "oauth" (default): the refreshable OAuth account migrated/captured from
    //    ~/.claude — carries a refresh token, Hapimatic-refreshed.
    //  - "env-token": a user-VM account SEEDED from a raw `CLAUDE_CODE_OAUTH_TOKEN`
    //    service-env credential (#1004 onboarding). It is long-lived and has NO
    //    refresh token; Hapimatic never refreshes it (the token-refresh service
    //    skips the kind) and the bound-spawn path injects the stored token directly.
    // Left `.optional()` (NOT `.default("oauth")`) so the field is additive on
    // BOTH the input AND the inferred OUTPUT type: every existing on-disk record
    // (no `authKind` key) parses byte-identically — zero migration — and every
    // existing `StoredAccount` object literal in the codebase stays valid without
    // an added field. An absent `authKind` reads as oauth via `isEnvTokenAccount`
    // (undefined ⇒ not env-token). Mirrors `unrefreshable`'s additive-optional
    // precedent below.
    authKind: z.enum(["oauth", "env-token"]).optional(),
    // Identity — sourced from ~/.claude.json `oauthAccount` during migration.
    // `accountUuid` (NOT email) is the primary key: emails can change, UUIDs don't.
    accountUuid: z.string().min(1),
    emailAddress: z.string().min(1),
    organizationUuid: z.string(),
    organizationName: z.string(),
    displayName: z.string(),
    billingType: z.string().default(""),
    // Tokens + subscription — sourced from ~/.claude/.credentials.json `claudeAiOauth`.
    subscriptionType: z.string(),
    rateLimitTier: z.string(),
    accessToken: z.string().min(1),
    // Issue #2268: optional on the "env-token" branch (a raw env-token credential
    // has no refresh token). The "oauth" branch STILL requires it — enforced by
    // the `.refine` below so legacy/oauth records keep their non-empty invariant.
    refreshToken: z.string().min(1).optional(),
    // #3392: ADVISORY CACHE — non-authoritative for availability. A
    // Hapimatic-synthesized copy of the token expiry that LAGS the live isolated
    // `.credentials.json` by up to ~24h for isolated (non-host) accounts: native
    // Claude Code owns the isolated refresh and Hapimatic's scheduler defers it
    // (#1635), so this copy is only re-written by migration / host-default capture /
    // a Hapimatic-owned refresh — otherwise it freezes and rots. Availability ⟺ the
    // `UsageService.resolveToken` per-tier token source has a non-empty `accessToken`
    // AND `unrefreshable != true` (an expired-but-refreshable token is still
    // available — it refreshes on next use). NEVER gate liveness on this field.
    // (env-token accounts seed the `0` sentinel here, meaning "no known expiry".
    // Consumers must branch on the KIND, never on this value: `UsageService.classify`
    // returns `no_scope` for an env-token account before its expiry check (#4736),
    // and the spawn gate exempts the kind (#2457).)
    expiresAt: z.number(),
    scopes: z.array(z.string()),
    // Hapimatic-synthesized timestamps (Unix epoch ms).
    capturedAt: z.number(),
    lastUsedAt: z.number(),
    // #3392: ADVISORY CACHE (see `expiresAt` above) — lags the live isolated
    // credential by up to ~24h for isolated accounts; non-authoritative for
    // availability/liveness.
    lastRefreshedAt: z.number(),
    // Sub-Issue B (#1448): the token-refresh service sets this true on a
    // PERMANENT refresh failure (revoked/invalid refresh token). Sticky: once
    // set, downstream sub-issues gate the account out of new session binding
    // until the user re-logs-in. Optional so A's existing writes (which never
    // set it) stay valid; passthrough() already tolerates it on read.
    unrefreshable: z.boolean().optional(),
    // Issue #4423: SHA-256 hex digest of the refresh token whose rejection set
    // `unrefreshable` (never the token). The stale-flag clear compares it with
    // the token now on disk: a different token means the flag no longer applies.
    // Read only while the flag is set; never part of a web-facing view model.
    unrefreshableTokenFingerprint: z.string().optional(),
    // Issue #5020: why `unrefreshable` was set when the cause is not a rejected
    // Hapimatic rotation — `native-cleared` (native Claude Code emptied the
    // isolated file after its own refresh failed) or `store-lineage-stale` (the
    // store holds a pair older than the file's lineage). Diagnostic only;
    // dropped with the fingerprint when the flag clears.
    unrefreshableReason: z.string().optional(),
    // Issue #5020: the newest `expiresAt` this instance has observed on the
    // account's isolated `.credentials.json` (mirrored by the daemon each tick
    // and written by every Hapimatic rotation). Spawn-time recovery never seeds
    // a store pair older than this: a pair the file has moved past was consumed.
    isolatedHeadExpiresAt: z.number().optional(),
  })
  .passthrough()
  // Issue #2268: every account EXCEPT the "env-token" kind MUST carry a non-empty
  // refresh token (the pre-#2268 invariant that `refreshToken: z.string().min(1)`
  // enforced). The exemption is keyed off the env-token kind (NOT off "oauth") so
  // a legacy record with an ABSENT `authKind` — which reads as oauth — still has
  // its refresh token required. Only the env-token variant may omit it. (Mirrors
  // the cross-field `.refine` pattern in `fileClaims.ts`.)
  .refine(
    account =>
      account.authKind === "env-token" ||
      (account.refreshToken !== undefined && account.refreshToken.length > 0),
    {
      message: "refreshToken is required for non-env-token accounts",
      path: ["refreshToken"],
    }
  );

export type StoredAccount = z.infer<typeof StoredAccountSchema>;

/**
 * True when the account was seeded from a raw `CLAUDE_CODE_OAUTH_TOKEN`
 * service-env credential (issue #2268) — long-lived, no refresh token, never
 * Hapimatic-refreshed. Consumers branch on the KIND (not on sentinel token/expiry
 * values) so env-token accounts are never refresh-attempted, marked
 * `unrefreshable`, or gated out of the picker.
 */
export function isEnvTokenAccount(account: StoredAccount): boolean {
  return account.authKind === "env-token";
}

/**
 * Issue #3731 (F1): what a provisioned VM's daemon did with the onboarding
 * `CLAUDE_CODE_OAUTH_TOKEN` from its service env, recorded as
 * `ambientOnboardingToken` in `<HAPI_HOME>/daemon.state.json`.
 * - `absent` — started without one;
 * - `pending` — started with one, account-store seed still in flight;
 * - `released` — deleted from the daemon env once the store served the primary;
 * - `retained` — kept in the daemon env because the seed failed.
 *
 * Defined here (#4736) so the server that reads it (`GET /api/accounts` →
 * `onboardingRegistration`) validates the same set the daemon writes. The cli's
 * type (`cli/src/persistence.ts`) and its runtime parser (re-exported by
 * `cli/src/daemon/envSeedTokenDisposition.ts`) are these ones (#4153), so the
 * list is defined once.
 */
export const AMBIENT_ONBOARDING_TOKEN_STATES = [
  "absent",
  "pending",
  "released",
  "retained",
] as const;

export type AmbientOnboardingTokenState =
  (typeof AMBIENT_ONBOARDING_TOKEN_STATES)[number];

/**
 * Validate a state value read back from `daemon.state.json`. Anything else —
 * missing (an older daemon), a wrong type, an unknown string — is `null`, which
 * readers must treat as UNKNOWN, never as clean.
 */
export function parseAmbientOnboardingTokenState(
  value: unknown
): AmbientOnboardingTokenState | null {
  return typeof value === "string" &&
    (AMBIENT_ONBOARDING_TOKEN_STATES as readonly string[]).includes(value)
    ? (value as AmbientOnboardingTokenState)
    : null;
}

// ─────────────────── Non-Anthropic provider records (#3808) ───────────────────
//
// Epic #3345 generalizes the #1446 Anthropic multi-account store into a
// PROVIDER-AWARE store: OpenAI (Codex) and Google (Gemini) records live ALONGSIDE
// Anthropic as a discriminated union on `provider`. The design keeps Anthropic
// BYTE-IDENTICAL — `StoredAccountSchema` above is UNCHANGED and its `provider` is
// ABSENT on disk (⇒ anthropic). The #2268 `authKind` precedent: additive, ZERO
// migration — the credential-bearing `<uuid>.json` files are NEVER rewritten to
// stamp a provider. Only NEW non-Anthropic records carry an explicit `provider`.
//
// Each non-Anthropic record holds a credential REFERENCE, never a secret VALUE:
//  - OpenAI → a per-account `codexHome` dir (`account-configs/<pk>/codex/`, or the
//    host `~/.codex`) that #3807 owns at mode 0700; the token lives in codex's
//    `auth.json`, never in this record.
//  - Google → a `vaultKeyRef` into the #1954 secrets vault keyed by
//    `(provider:"gemini", accountUuid)`; the key never leaves the vault.
// [ER 2026-09-19: 3808-2] [ER 2026-09-19: D4] [ER 2026-09-19: K2]

/**
 * One OpenAI/Codex account record. PK (`accountUuid`, D4): codex's stable account
 * id for a ChatGPT login (a minted `randomUUID()` for an API-key login, which has
 * no identity). `codexHome` is the REFERENCE — the per-account codex dir #3807
 * created; no token is copied here. `authMode` mirrors codex's `auth_mode`
 * (`chatgpt` → subscription, `api-key`). `.passthrough()` for forward-compat,
 * matching `StoredAccountSchema`.
 */
export const OpenAiStoredAccountSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.literal("openai"),
    accountUuid: z.string().min(1),
    label: z.string(),
    emailAddress: z.string().optional(),
    authMode: z.enum(["chatgpt", "api-key"]),
    /** `~/.config/hapimatic/account-configs/<pk>/codex/` (per-account) or the host
     *  `~/.codex` (the imported host login). A REFERENCE, never a secret. */
    codexHome: z.string().min(1),
    capturedAt: z.number(),
    lastUsedAt: z.number(),
  })
  .passthrough();
export type OpenAiStoredAccount = z.infer<typeof OpenAiStoredAccountSchema>;

/** Reference into the #1954 secrets vault for a Google account's Gemini key.
 *  Widened vault invariant: at most ONE entry per (`provider`, `accountUuid`). */
export const GoogleVaultKeyRefSchema = z.object({
  provider: z.literal("gemini"),
  accountUuid: z.string().min(1),
});
export type GoogleVaultKeyRef = z.infer<typeof GoogleVaultKeyRefSchema>;

/**
 * One Google/Gemini account record. PK (`accountUuid`, D4): a minted
 * `randomUUID()` — an API key has no account identity, so the key lives in the
 * vault and this record only REFERENCES it via `vaultKeyRef`. `.passthrough()`
 * for forward-compat.
 */
export const GoogleStoredAccountSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.literal("google"),
    accountUuid: z.string().min(1),
    label: z.string(),
    vaultKeyRef: GoogleVaultKeyRefSchema,
    capturedAt: z.number(),
    lastUsedAt: z.number(),
  })
  .passthrough();
export type GoogleStoredAccount = z.infer<typeof GoogleStoredAccountSchema>;

/**
 * The provider-aware union — the discriminated union on `provider`. `StoredAccount`
 * (Anthropic, `provider` absent ⇒ anthropic) stays the base type used by every
 * Anthropic-only consumer; this superset is used ONLY at the new boundaries (the
 * store read path, the record importer, the redacted mapper, and the Task-1b
 * enumerator filters). Keeping `StoredAccount` = Anthropic is what bounds the
 * change: Anthropic-field access at off-footprint call sites still type-checks.
 */
export type AnyStoredAccount =
  | StoredAccount
  | OpenAiStoredAccount
  | GoogleStoredAccount;

export type ValidateAnyAccountResult =
  | { ok: true; account: AnyStoredAccount }
  | { ok: false; error: string };

/**
 * Validate an unknown input against the provider-aware union. Discriminates
 * MANUALLY on `provider` (rather than via `z.discriminatedUnion`) so an Anthropic
 * record — `provider` absent or `"anthropic"` — routes to the UNCHANGED
 * {@link validateStoredAccount}, preserving its byte-identical parse + error
 * behavior. Only an explicit `"openai"` / `"google"` discriminator selects a
 * non-Anthropic variant. Never throws.
 */
export function validateAnyStoredAccount(
  input: unknown
): ValidateAnyAccountResult {
  const provider = (input as { provider?: unknown } | null | undefined)
    ?.provider;
  if (provider === "openai") {
    const result = OpenAiStoredAccountSchema.safeParse(input);
    return result.success
      ? { ok: true, account: result.data }
      : { ok: false, error: result.error.message };
  }
  if (provider === "google") {
    const result = GoogleStoredAccountSchema.safeParse(input);
    return result.success
      ? { ok: true, account: result.data }
      : { ok: false, error: result.error.message };
  }
  // Absent or "anthropic" → the existing Anthropic validator (byte-identical).
  return validateStoredAccount(input);
}

/**
 * The provider of any stored account. An Anthropic record carries no `provider`
 * key on disk (absent ⇒ anthropic), so this normalizes to the {@link ProviderId}
 * literal — the value Task-1b enumerators filter on and the redacted row emits.
 */
export function accountProviderOf(account: AnyStoredAccount): ProviderId {
  const provider = (account as { provider?: unknown }).provider;
  return provider === "openai" || provider === "google"
    ? provider
    : "anthropic";
}

/**
 * Lightweight index entry for fast enumeration without loading full records
 * (which contain token values). Persisted in `<accountsDir>/index.json`.
 */
export const AccountIndexEntrySchema = z.object({
  accountUuid: z.string(),
  emailAddress: z.string(),
  lastUsedAt: z.number(),
  // #3808: OPTIONAL provider tag, written for NEW non-Anthropic records only
  // (absent ⇒ anthropic). Lets `AccountStore.list()` consumers filter by provider
  // WITHOUT a per-record `get()`, and no existing Anthropic index entry is
  // rewritten. [ER 2026-09-19: 3808-14]
  provider: ProviderIdSchema.optional(),
});

export type AccountIndexEntry = z.infer<typeof AccountIndexEntrySchema>;

export const AccountIndexSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    accounts: z.array(AccountIndexEntrySchema),
  })
  .passthrough();

export type AccountIndex = z.infer<typeof AccountIndexSchema>;

export type ValidateAccountResult =
  | { ok: true; account: StoredAccount }
  | { ok: false; error: string };

/**
 * Validate an unknown input against the stored-account schema. Never throws —
 * returns `{ok:true,account}` or `{ok:false,error}` so callers can skip-or-
 * surface a malformed record (issue #1447 R6). Mirrors `validateWorktreeMeta`.
 */
export function validateStoredAccount(input: unknown): ValidateAccountResult {
  const result = StoredAccountSchema.safeParse(input);
  if (result.success) return { ok: true, account: result.data };
  return { ok: false, error: result.error.message };
}

export type ValidateAccountIndexResult =
  | { ok: true; index: AccountIndex }
  | { ok: false; error: string };

/**
 * Validate an unknown input against the account-index schema. Never throws.
 */
export function validateAccountIndex(
  input: unknown
): ValidateAccountIndexResult {
  const result = AccountIndexSchema.safeParse(input);
  if (result.success) return { ok: true, index: result.data };
  return { ok: false, error: result.error.message };
}

/**
 * Computes a human-readable plan label from subscription type and rate limit tier.
 *
 * Mapping:
 * - "pro" → "Claude Pro"
 * - "max" + "default_claude_max_5x" → "Max 5X"
 * - "max" + "default_claude_max_20x" → "Max 20X"
 * - "max" (unknown tier) → "Claude Max"
 * - unknown → subscription type as-is, or undefined
 *
 * Lives in `@hapi/protocol` (shared) so BOTH the cli (host-credential read +
 * bound-account stamping) and the server (mid-session account-switch persistence,
 * issue #1517) compute the same label from one source — no per-package drift.
 */
export function computePlanLabel(
  subscriptionType?: string,
  rateLimitTier?: string
): string | undefined {
  if (!subscriptionType) {
    return undefined;
  }

  const normalizedType = subscriptionType.toLowerCase();

  if (normalizedType === "pro") {
    return "Claude Pro";
  }

  if (normalizedType === "max") {
    if (rateLimitTier?.includes("5x")) {
      return "Max 5X";
    }
    if (rateLimitTier?.includes("20x")) {
      return "Max 20X";
    }
    return "Claude Max";
  }

  // For unknown types, return the raw value with capitalization
  return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
}

/**
 * Map a `StoredAccount` to the `ClaudeAccountInfo` shape used for the UI plan
 * badge + per-session account display. Mirrors the cli's
 * `accountInfoFromStored` (`cli/src/claude/accountTokenInjection.ts`) but lives
 * in shared so the SERVER can build `claudeAccount` from the validated target
 * account during a mid-session account switch (issue #1517) without importing
 * from the cli package.
 */
export function claudeAccountInfoFromStored(
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
