// SPDX-License-Identifier: AGPL-3.0-only
import { logger } from "@/ui/logger";
import { accountStore } from "@/accounts/accountStore";
import { fetchOauthProfile } from "@/accounts/oauthProfile";
import { isTenantVm } from "@/accounts/tenantMode";
import type { ResolvedIdentity } from "@/accounts/credentialsWatcher";
import {
  StoredAccountSchema,
  type StoredAccount,
  type ValidateAccountResult,
} from "@hapi/protocol/accounts";

/**
 * Account-store seeding for env-token auth (issue #2268, Sub-B of epic #2267).
 *
 * On a user VM the Claude credential is installed as the service-env
 * `CLAUDE_CODE_OAUTH_TOKEN` (the #1004 onboarding paste path), and sessions
 * authenticate fine — but Hapimatic's account store stays empty, so the create
 * page shows "No accounts available" and sessions carry no `metadata.claudeAccount`.
 * This module seeds a first-class `authKind: "env-token"` account record from that
 * raw token (composing {@link fetchOauthProfile} for identity + `AccountStore.put`
 * for the write), so account-aware features light up.
 *
 * Contract (KD3):
 *  - **Idempotent (R5)** — skips when ANY record for the resolved uuid already
 *    exists (valid OR present-but-invalid); never duplicates and never clobbers a
 *    richer operator-migrated record.
 *  - **Fail-soft (R2, Fallback Preservation Rule)** — NEVER throws. Every failure
 *    path (no token, unresolved identity, no email, invalid record, any error)
 *    returns a `{seeded:false, reason}` and leaves session spawning byte-for-byte
 *    unaffected (a store-less VM still spawns working sessions via the env token).
 *  - **Security** — the token value NEVER reaches a logger call (mirrors
 *    `oauthProfile.ts` R10 / `accountStore.ts` R9).
 */

/**
 * Minimal structural seam over `AccountStore` (test injection). Both the real
 * `AccountStore` singleton and an in-memory / temp-dir fake satisfy it.
 */
interface SeedAccountStore {
  get(accountUuid: string): Promise<ValidateAccountResult | null>;
  put(account: StoredAccount): Promise<void>;
}

/**
 * Identity the gateway DELIVERS to the VM at onboarding time (issue #2554),
 * decoded from the base64-JSON `HAPI_ONBOARDING_ACCOUNT_IDENTITY` env var. This is
 * the PRIMARY identity source for the env-token seed.
 *
 * Why a delivered source at all: a `claude setup-token` credential (`sk-ant-oat01…`)
 * is `user:inference`-scoped and 403s on `/api/oauth/profile` with
 * `"does not meet scope requirement any_of(user:profile, user:office)"` (verified
 * live against ms1's own token, 2026-08-03). So {@link fetchOauthProfile} can NEVER
 * resolve identity or tier for such a token — the identity must be delivered out of
 * band. A superset of {@link ResolvedIdentity} that additionally carries
 * `subscriptionType` (the whole gap behind the missing `opus[1m]` pin — #1506 / R3)
 * and `rateLimitTier`, which `/api/oauth/profile` DOES carry (in
 * `organization.organization_type` / `organization.rate_limit_tier`) but the
 * scope-limited token cannot reach.
 */
export interface DeliveredAccountIdentity extends ResolvedIdentity {
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface SeedFromEnvTokenDeps {
  /** Defaults to the real `accountStore` singleton. */
  store?: SeedAccountStore;
  /** Defaults to {@link fetchOauthProfile}. Injected for offline unit testing. */
  fetchProfile?: typeof fetchOauthProfile;
  /** Clock seam for the synthesized `capturedAt`. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Identity the gateway delivered out of band (issue #2554). When present, it is
   * the PRIMARY identity source and the profile fetch is NOT called — the oat01
   * token cannot reach the profile endpoint anyway. `null`/absent → fall back to
   * {@link fetchOauthProfile} (byte-equivalent to pre-#2554 for tokens with no
   * delivered identity). Carries `subscriptionType`, which unlocks the Max
   * `opus[1m]` pin (R3).
   */
  deliveredIdentity?: DeliveredAccountIdentity | null;
  /**
   * Issue #4349 (R3): the tenant predicate (test seam; defaults to `isTenantVm`). On a TENANT VM
   * the SPD-delivered token is never seeded into the store — the customer signs in inside the VM.
   */
  tenantVm?: () => boolean;
}

/** Outcome of a seeding attempt — `reason` explains a `seeded:false`. */
export type SeedFromEnvTokenResult = {
  seeded: boolean;
  reason?:
    | "no-token"
    | "identity-unresolved"
    | "already-present"
    | "present-invalid"
    | "no-email"
    | "invalid-record"
    | "error"
    // #4349: a tenant VM — the env token is ignored (in-VM sign-in only).
    | "tenant-vm";
  /**
   * The resolved `accountUuid`, set on the paths where a record for it is on
   * disk — `seeded:true` AND the idempotent `already-present` / `present-invalid`
   * skips. Lets the multi-account caller (issue #2314) pick the
   * most-recently-connected STORED account to mark active WITHOUT re-resolving
   * identity. Deliberately ABSENT on `no-email` (identity resolved but NOT
   * stored — a schema-required non-empty email is missing), so the caller can
   * never point `active.json` at an account that isn't in the store. Also absent
   * when identity could not be resolved (`no-token` / `identity-unresolved` /
   * `error`).
   */
  accountUuid?: string;
};

/**
 * Journal log level for a boot-seed SKIP reason (#2670). `already-present` is the
 * benign idempotent skip — the env token persists in `~/.config/hapimatic/env`, so
 * the boot seed re-runs on EVERY restart; routing it to `warn` would emit journal
 * noise on every healthy boot forever, so it routes to `info`. Every failure-class
 * reason (`no-token`, `identity-unresolved`, `no-email`, `invalid-record`, `error`,
 * `present-invalid`) routes to `warn`: journal-visible so a field regression like
 * #2670 — a seed that silently skipped at `debug` — is diagnosable. An absent/unknown
 * reason is treated as failure-class (`warn`): fail loud, never silent.
 */
export function seedSkipLogLevel(
  reason: SeedFromEnvTokenResult["reason"]
): "info" | "warn" {
  return reason === "already-present" || reason === "tenant-vm"
    ? "info"
    : "warn";
}

export async function seedAccountStoreFromEnvToken(
  token: string,
  deps: SeedFromEnvTokenDeps = {}
): Promise<SeedFromEnvTokenResult> {
  const store = deps.store ?? accountStore;
  const fetchProfile = deps.fetchProfile ?? fetchOauthProfile;
  const now = deps.now ?? Date.now;

  try {
    if (!token) return { seeded: false, reason: "no-token" };
    // #4349 (R3): never seed an SPD-delivered token on a tenant VM. NEVER log the token.
    if ((deps.tenantVm ?? isTenantVm)()) {
      logger.info(
        "[ACCOUNT_SEED] tenant VM: CLAUDE_CODE_OAUTH_TOKEN ignored — sign-in happens inside the VM (#4349)"
      );
      return { seeded: false, reason: "tenant-vm" };
    }

    // Identity resolution: the gateway-DELIVERED identity is PRIMARY (issue
    // #2554), with the profile fetch as the fallback for tokens that CAN reach
    // it. An oat01 setup-token 403s on `/api/oauth/profile` (scope-limited), so
    // without a delivered identity `fetchOauthProfile` returns null and the seed
    // skips exactly as pre-#2554 (R2, R5 byte-equivalence). NEVER log the token.
    const identity: DeliveredAccountIdentity | null =
      deps.deliveredIdentity ?? (await fetchProfile(token));
    if (!identity) {
      logger.debug(
        "[ACCOUNT_SEED] identity unresolved from env token; skipping seed"
      );
      return { seeded: false, reason: "identity-unresolved" };
    }

    // R5 idempotency: skip when ANY record exists for the uuid — valid OR
    // present-but-invalid. A present-but-invalid record is skipped and logged,
    // NEVER clobbered (it may be a richer operator-migrated record mid-repair).
    const existing = await store.get(identity.accountUuid);
    if (existing !== null) {
      const reason = existing.ok ? "already-present" : "present-invalid";
      logger.debug(
        `[ACCOUNT_SEED] account ${identity.accountUuid} ${reason}; skipping seed`
      );
      return { seeded: false, reason, accountUuid: identity.accountUuid };
    }

    // R3 needs the email visible in the picker and the schema requires a
    // non-empty `emailAddress` — never seed a blank-email record. (`emailAddress`
    // is optional in the profile response but required by StoredAccountSchema.)
    if (!identity.emailAddress) {
      logger.debug(
        `[ACCOUNT_SEED] account ${identity.accountUuid} has no email in profile; skipping seed`
      );
      return { seeded: false, reason: "no-email" };
    }

    const capturedAt = now();
    // Build the env-token-branch record. Do NOT mirror the migration builder's
    // token source (`~/.claude/.credentials.json`) — that file is absent on an
    // env-token VM. There is no refresh token, and no tier in the profile (OR-1).
    const account = {
      schema_version: 1 as const,
      authKind: "env-token" as const,
      accountUuid: identity.accountUuid,
      emailAddress: identity.emailAddress,
      organizationUuid: identity.organizationUuid ?? "",
      organizationName: identity.organizationName ?? "",
      displayName: identity.displayName ?? "",
      billingType: identity.billingType ?? "",
      // #2554: carry the tier from the gateway-delivered identity. When the
      // gateway delivered no tier (a fallback profile-fetch resolve, or a
      // partial delivered payload), this degrades to "" — the record still
      // seeds email-only (R5 fail-soft on a partial payload), it just won't earn
      // the Max `opus[1m]` pin until a tier is delivered. A delivered
      // `subscriptionType: "max"` unlocks `resolveEntitledModel` → `opus[1m]`
      // (R3, the VM-path #1506 repro).
      subscriptionType: identity.subscriptionType ?? "",
      rateLimitTier: identity.rateLimitTier ?? "",
      accessToken: token,
      // No refreshToken — env-token accounts are never Hapimatic-refreshed.
      // expiresAt 0 = "no known/applicable expiry"; safe because the bound-spawn
      // path early-returns the token for env-token BEFORE any expiry check
      // (accountTokenInjection.ts), the refresh scheduler skips the kind
      // (tokenRefreshService.ts), and the picker's staleness signal is the live
      // usage probe (not `expiresAt`).
      expiresAt: 0,
      scopes: [],
      capturedAt,
      lastUsedAt: 0,
      lastRefreshedAt: 0,
    };

    // `AccountStore.put()` writes as-is (no validation) — assert schema-validity
    // first so a malformed record can never reach disk. Log only the failing
    // field paths, never the record value (which carries the token).
    const parsed = StoredAccountSchema.safeParse(account);
    if (!parsed.success) {
      const paths = parsed.error.issues
        .map(issue => issue.path.join("."))
        .join(", ");
      logger.debug(
        `[ACCOUNT_SEED] built record failed validation (paths: ${paths}); skipping seed`
      );
      return { seeded: false, reason: "invalid-record" };
    }

    await store.put(parsed.data);
    logger.info(
      `[ACCOUNT_SEED] seeded env-token account ${identity.accountUuid} (email present)`
    );
    return { seeded: true, accountUuid: identity.accountUuid };
  } catch (err) {
    // Fallback Preservation Rule (R2): NEVER throw — a seeding failure must not
    // affect session spawning. Log at debug; never log the token.
    logger.debug(
      `[ACCOUNT_SEED] seeding failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { seeded: false, reason: "error" };
  }
}

/**
 * Whether a {@link seedAccountStoreFromEnvToken} result names an account that is
 * eligible to become the active default. TRUE only when a record for the uuid is
 * actually on disk — seeded THIS boot, or the idempotent `already-present` skip
 * (which self-heals a VM whose record was seeded before the active pointer was
 * ever written, issue #2555). Deliberately FALSE for `present-invalid` (a
 * mid-repair record must never become the default), `no-email` (identity resolved
 * but NOT stored), and the unresolved / error paths (no `accountUuid` at all) — in
 * each of those, pointing `active.json` at the uuid would dangle or select a
 * half-written record.
 *
 * Shared by the primary boot seed ({@link seedAccountsAtBoot}) and the additional-
 * accounts seed ({@link seedAdditionalOnboardingAccounts}) so the two active-
 * eligibility rules can never drift — the asymmetry between them was the #2555 bug.
 */
export function isActiveEligible(result: SeedFromEnvTokenResult): boolean {
  return (
    (result.seeded || result.reason === "already-present") &&
    typeof result.accountUuid === "string" &&
    result.accountUuid.length > 0
  );
}

/** Aggregate outcome of {@link seedAdditionalOnboardingAccounts}. */
export interface SeedManyResult {
  /** Per-token results, in input order. */
  results: SeedFromEnvTokenResult[];
  /** Count of tokens that newly seeded a record this call. */
  seededCount: number;
  /** Count of tokens skipped (decode-filtered, unresolved, already-present, error). */
  skippedCount: number;
  /** The account marked active (most-recently-connected), or null if none set. */
  activeAccountUuid: string | null;
}

export interface SeedManyDeps extends SeedFromEnvTokenDeps {
  /**
   * Set the given account active only when no `active.json` exists. Defaults to
   * the real store's {@link AccountStore.setActiveAccountUuidIfUnset}. Returns
   * whether it wrote the pointer.
   */
  setActiveIfUnset?: (accountUuid: string) => Promise<boolean>;
  /**
   * Gateway-delivered identities for accounts 2..N (issue #2554), INDEX-ALIGNED
   * with the decoded `HAPI_ONBOARDING_OAUTH_TOKENS` token array (the gateway
   * builds both from the same ordered account list, so `deliveredIdentities[i]`
   * describes `tokens[i]`). A `null`/absent slot falls back to the profile fetch
   * for that token (byte-equivalent to pre-#2554). Overrides the inherited
   * singular `deliveredIdentity` per token.
   */
  deliveredIdentities?: (DeliveredAccountIdentity | null)[];
}

/**
 * Decode + seed the ADDITIONAL onboarding accounts delivered by the gateway as a
 * base64-encoded JSON string-array in `HAPI_ONBOARDING_OAUTH_TOKENS` (issue
 * #2314, KD1). Account 1 travels separately as `CLAUDE_CODE_OAUTH_TOKEN` (the
 * preserved env fallback, seeded by {@link seedAccountStoreFromEnvToken}); this
 * seeds accounts 2..N, in connection order, then marks the LAST successfully
 * resolved account active-if-unset (the most-recently-connected default, R3).
 *
 * Fail-soft (R2, Fallback Preservation Rule): a decode failure, a bad token, or
 * an active-write failure NEVER throws and NEVER affects the primary env-token
 * fallback — a store-less VM still spawns working sessions. Token values NEVER
 * reach a logger call.
 *
 * MULTI-account path ONLY. When the gateway delivers no extra tokens
 * (single-account onboarding) the daemon never invokes this, so the
 * single-account flow stays byte-equivalent to #2268 — the active pointer is
 * untouched (R5).
 */
export async function seedAdditionalOnboardingAccounts(
  rawBase64Json: string,
  deps: SeedManyDeps = {}
): Promise<SeedManyResult> {
  const setActiveIfUnset =
    deps.setActiveIfUnset ??
    ((uuid: string) => accountStore.setActiveAccountUuidIfUnset(uuid));

  const empty: SeedManyResult = {
    results: [],
    seededCount: 0,
    skippedCount: 0,
    activeAccountUuid: null,
  };
  // #4349 (R3): never seed SPD-delivered extra accounts on a tenant VM. NEVER log a token.
  if ((deps.tenantVm ?? isTenantVm)()) {
    logger.info(
      "[ACCOUNT_SEED] tenant VM: HAPI_ONBOARDING_OAUTH_TOKENS ignored — sign-in happens inside the VM (#4349)"
    );
    return empty;
  }

  // Decode base64 → JSON string[]. Any malformation → skip the whole batch (the
  // primary CLAUDE_CODE_OAUTH_TOKEN account is unaffected). NEVER log a token.
  let tokens: string[];
  try {
    const json = Buffer.from(rawBase64Json, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) {
      logger.debug(
        "[ACCOUNT_SEED] HAPI_ONBOARDING_OAUTH_TOKENS is not a JSON array; skipping extra accounts"
      );
      return empty;
    }
    tokens = parsed.filter(
      (t): t is string => typeof t === "string" && t.length > 0
    );
  } catch {
    logger.debug(
      "[ACCOUNT_SEED] HAPI_ONBOARDING_OAUTH_TOKENS failed base64/JSON decode; skipping extra accounts"
    );
    return empty;
  }

  if (tokens.length === 0) return empty;

  const results: SeedFromEnvTokenResult[] = [];
  let seededCount = 0;
  let skippedCount = 0;
  // The last token whose identity resolved = the most-recently-connected account,
  // which becomes the active default (set-if-unset).
  let lastResolvedUuid: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // #2554: per-token delivered identity (index-aligned with the token array),
    // overriding the inherited singular seam so each account carries its own
    // identity + tier. Absent → null → the profile-fetch fallback for that token.
    const result = await seedAccountStoreFromEnvToken(token, {
      ...deps,
      deliveredIdentity: deps.deliveredIdentities?.[i] ?? null,
    });
    results.push(result);
    if (result.seeded) seededCount++;
    else skippedCount++;
    // Only an account actually in the store is eligible to become the active
    // default — never an unresolved / no-email / present-invalid one, which would
    // leave `active.json` dangling. Shared with the primary seed via
    // {@link isActiveEligible} (issue #2555) so the two rules cannot drift.
    if (isActiveEligible(result)) {
      lastResolvedUuid = result.accountUuid ?? null;
    }
  }

  let activeAccountUuid: string | null = null;
  if (lastResolvedUuid) {
    try {
      const didSet = await setActiveIfUnset(lastResolvedUuid);
      if (didSet) activeAccountUuid = lastResolvedUuid;
    } catch (err) {
      // Fail-soft — a failed active-write leaves the selector at "(no default)".
      logger.debug(
        `[ACCOUNT_SEED] set-active-if-unset failed (leaving default unset): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  logger.info(
    `[ACCOUNT_SEED] additional onboarding accounts: ${seededCount} seeded, ${skippedCount} skipped, active=${activeAccountUuid ? "set" : "unchanged"}`
  );
  return { results, seededCount, skippedCount, activeAccountUuid };
}

/**
 * Decode the gateway-delivered per-account identity payload (issue #2554) from the
 * base64-JSON `HAPI_ONBOARDING_ACCOUNT_IDENTITY` env var into an index-aligned
 * array of {@link DeliveredAccountIdentity} (or `null` for an account the gateway
 * could not resolve an identity for). The array is aligned with the gateway's
 * ordered account list: index 0 describes the `CLAUDE_CODE_OAUTH_TOKEN` account,
 * indices 1..N-1 describe the `HAPI_ONBOARDING_OAUTH_TOKENS` accounts in order — so
 * the daemon threads `identities[0]` into the primary seed and `identities.slice(1)`
 * into the additional seed.
 *
 * Fail-soft (R5, Fallback Preservation Rule): ANY malformation (bad base64, bad
 * JSON, not an array) yields `[]`, degrading every account to the profile-fetch
 * fallback. NEVER throws. The payload carries identity only (uuid / email / tier),
 * never a token.
 */
export function decodeDeliveredIdentities(
  rawBase64Json: string
): (DeliveredAccountIdentity | null)[] {
  try {
    const json = Buffer.from(rawBase64Json, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(entry => {
      // A usable identity needs at least a non-empty accountUuid (the store's
      // primary key). Anything else (null, non-object, missing/blank uuid) → a
      // null slot, which falls back to the profile fetch for that account.
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { accountUuid?: unknown }).accountUuid === "string" &&
        (entry as { accountUuid: string }).accountUuid.length > 0
      ) {
        return entry as DeliveredAccountIdentity;
      }
      return null;
    });
  } catch {
    return [];
  }
}

/**
 * Deps for {@link seedAccountsAtBoot} — the two underlying seed functions plus the
 * set-active seam, all injectable for offline unit testing. Extends
 * {@link SeedManyDeps} so the same `store` / `fetchProfile` / `setActiveIfUnset`
 * seams flow through to both seeds.
 */
export interface SeedBootDeps extends SeedManyDeps {
  /** Defaults to {@link seedAccountStoreFromEnvToken}. Injected for unit testing. */
  seedPrimary?: typeof seedAccountStoreFromEnvToken;
  /** Defaults to {@link seedAdditionalOnboardingAccounts}. Injected for unit testing. */
  seedExtras?: typeof seedAdditionalOnboardingAccounts;
}

/** Aggregate outcome of {@link seedAccountsAtBoot}. */
export interface SeedBootResult {
  /** The primary `CLAUDE_CODE_OAUTH_TOKEN` seed result, or null when no primary token. */
  primaryResult: SeedFromEnvTokenResult | null;
  /** The additional-accounts seed summary, or null when no extras were present. */
  extrasSummary: SeedManyResult | null;
  /** Whether the PRIMARY seed wrote `active.json` (only when it was still unset). */
  primaryMarkedActive: boolean;
}

/**
 * Issue #3731 (R0, ruling D2 variant A′): whether the daemon may delete the AMBIENT
 * onboarding `CLAUDE_CODE_OAUTH_TOKEN` from its own `process.env` after the boot seed.
 *
 * TRUE only when the primary account is actually on disk in the store — seeded this
 * boot, or the idempotent `already-present` skip — i.e. exactly
 * {@link isActiveEligible}, reused so the "is the primary really in the store" rule
 * cannot drift from the #2555 active-pointer rule. Once that holds, the store serves
 * the account explicitly (`HAPI_ACCOUNT_UUID` → `withAccountToken`) and the ambient
 * copy is pure contamination: it overrides the isolated `CLAUDE_CONFIG_DIR`
 * credentials of every other bound account (native Claude Code prefers an env token).
 *
 * FALSE for a store-less / seed-failed VM (`present-invalid`, `no-email`,
 * `identity-unresolved`, `invalid-record`, `error`, or no primary token at all) — a documented field
 * state (#2670) in which the ambient token is still the node's only working
 * credential, so the daemon keeps it and warns instead.
 */
export function shouldReleaseEnvSeedToken(summary: SeedBootResult): boolean {
  return (
    summary.primaryResult !== null && isActiveEligible(summary.primaryResult)
  );
}

/**
 * Boot-time account-store seed orchestrator (issue #2555). Seeds the primary
 * `CLAUDE_CODE_OAUTH_TOKEN` account AND the additional `HAPI_ONBOARDING_OAUTH_TOKENS`
 * accounts, then marks an account active-if-unset with a DETERMINISTIC
 * primary↔extras ordering:
 *
 *  - Both seeds fire CONCURRENTLY, preserving the pre-#2555 fire-and-forget
 *    parallelism (the daemon must not serialize boot readiness on them).
 *  - The extras seed's own set-active (its most-recently-connected default, #2314)
 *    is AWAITED first, THEN the primary's set-active-if-unset runs — so on a
 *    MULTI-account VM the extras' choice deterministically wins, EVEN IF the
 *    primary seed's promise happened to resolve first (the ordering does not
 *    depend on promise-settle timing — the #2555 race fix).
 *  - On a SINGLE-account VM (no extras) the primary fills the unset pointer, so
 *    that first session binds and shows identity — the #2314-asymmetry fix (R1,R2).
 *  - Robust to "extras present but all fail": the primary fills the still-unset
 *    pointer.
 *
 * Fail-soft (R2, R4, Fallback Preservation Rule): NEVER throws; a failed
 * active-write leaves the selector at "(no default)" and never affects spawning.
 * The caller gates on at least one token being present, so operator machines
 * (no `CLAUDE_CODE_OAUTH_TOKEN`) never invoke this — the active pointer is
 * untouched there (R4).
 */
export async function seedAccountsAtBoot(params: {
  primaryToken: string | undefined;
  extrasRaw: string | undefined;
  deliveredIdentities: (DeliveredAccountIdentity | null)[];
  deps?: SeedBootDeps;
}): Promise<SeedBootResult> {
  const { primaryToken, extrasRaw, deliveredIdentities } = params;
  const deps = params.deps ?? {};
  const seedPrimary = deps.seedPrimary ?? seedAccountStoreFromEnvToken;
  const seedExtras = deps.seedExtras ?? seedAdditionalOnboardingAccounts;
  const setActiveIfUnset =
    deps.setActiveIfUnset ??
    ((uuid: string) => accountStore.setActiveAccountUuidIfUnset(uuid));

  // Fire BOTH seeds concurrently. The ordering guarantee below does NOT depend on
  // which promise settles first — only on awaiting the extras seed (which sets
  // active internally) BEFORE running the primary's set-active-if-unset.
  const extrasPromise: Promise<SeedManyResult | null> = extrasRaw
    ? seedExtras(extrasRaw, {
        ...deps,
        deliveredIdentities: deliveredIdentities.slice(1),
      })
    : Promise.resolve(null);
  const primaryPromise: Promise<SeedFromEnvTokenResult | null> = primaryToken
    ? seedPrimary(primaryToken, {
        ...deps,
        deliveredIdentity: deliveredIdentities[0] ?? null,
      })
    : Promise.resolve(null);

  // R3 ordering: await the extras seed FIRST — its most-recently-connected
  // set-active has completed by the time this resolves. ONLY THEN the primary's
  // set-active-if-unset, so the extras' choice wins on a multi-account VM.
  const extrasSummary = await extrasPromise;
  const primaryResult = await primaryPromise;

  let primaryMarkedActive = false;
  if (
    primaryResult &&
    isActiveEligible(primaryResult) &&
    primaryResult.accountUuid
  ) {
    try {
      primaryMarkedActive = await setActiveIfUnset(primaryResult.accountUuid);
    } catch (err) {
      // Fail-soft (R2, Fallback Preservation Rule): a failed active-write leaves
      // the selector at "(no default)" and never affects session spawning.
      logger.debug(
        `[ACCOUNT_SEED] primary set-active-if-unset failed (leaving default unset): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { primaryResult, extrasSummary, primaryMarkedActive };
}
