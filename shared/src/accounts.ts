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

/**
 * Issue #6801 (R13): one past login death, carried across re-logins in
 * {@link StoredAccount.signInDeaths}. `signedInAt` is that login's `capturedAt`,
 * `diedAt` the time Hapimatic first flagged it (a detection time, so the real
 * death lies between `lastAliveAt` — its last refresh — and `diedAt`). Epoch ms.
 */
export const SignInDeathSchema = z.object({
  signedInAt: z.number(),
  diedAt: z.number(),
  lastAliveAt: z.number(),
  // Issue #6161 (R18, Task 3): the deadline {@link resolveSignInDeadline} gave
  // the replaced login just before the sign-in that recorded this death, so each
  // death can be checked against its prediction. The `.catch` matters: a plain
  // `.optional()` would let one element holding `null` fail the element, and
  // `signInDeaths`' own `.catch` would then drop the whole history.
  predictedDeadlineAt: z.number().optional().catch(undefined),
});

export type SignInDeath = z.infer<typeof SignInDeathSchema>;

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
    // #3392: ADVISORY CACHE — non-authoritative for availability. ONLY this
    // field and `lastRefreshedAt` below are advisory: `unrefreshable` on this
    // same store record is AUTHORITATIVE (the spawn gate's input, written only
    // here — never to a live `.credentials.json`; rp1-home#2549, #4461).
    // A Hapimatic-synthesized copy of the token expiry that LAGS the live isolated
    // `.credentials.json` by up to ~24h for isolated (non-host) accounts: native
    // Claude Code owns the isolated refresh and Hapimatic's scheduler defers it
    // (#1635), so this copy is only re-written by a sign-in / the folder mirror /
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
    // store holds a pair older than the file's lineage). Issue #6800 adds
    // `host-chain-shared` ({@link HOST_CHAIN_SHARED_REASON}): the record or its
    // folder held the same refresh-token chain as `~/.claude`, so it is
    // quarantined until a sign-in writes a different token. Diagnostic only;
    // dropped with the fingerprint when the flag clears.
    unrefreshableReason: z.string().optional(),
    // Issue #6801 (R1, R2): epoch ms when `unrefreshable` was first set on THIS
    // store (first flag wins; a re-flag never moves it). Set only through the CLI
    // helper `withUnrefreshableFlag` (`cli/src/accounts/machineRotator.ts`) and
    // dropped with the flag's other detail fields when the flag clears. Read only
    // through {@link trustedUnrefreshableAt}. Optional (never `.default`), so every
    // existing record and every older node parses unchanged; a malformed value
    // (a hand edit setting it to `null`) reads as absent instead of making the
    // whole record invalid, which would hide the account and refuse its spawns.
    unrefreshableAt: z.number().optional().catch(undefined),
    // Issue #6801 (R2): the `unrefreshableTokenFingerprint ?? unrefreshableReason`
    // that `unrefreshableAt` was recorded for. A time is trusted only while this
    // still names the record's current flag, so a stamp an older build kept through
    // its clear and a later re-flag on another token reads as unknown. Set and
    // dropped with `unrefreshableAt`. A malformed value reads as absent.
    unrefreshableAtFor: z.string().optional().catch(undefined),
    // Issue #6801 (R13): past login deaths, newest last, at most
    // {@link SIGN_IN_DEATHS_MAX}. Written only by the server sign-in builder
    // (`accountLoginService.complete`, via {@link carrySignInDeaths}); history,
    // so a flag clear keeps it. A malformed history reads as absent, never as an
    // invalid record.
    signInDeaths: z.array(SignInDeathSchema).optional().catch(undefined),
    // Issue #6161 (R1, R5): this instance's record of the login's sign-in
    // deadline (epoch ms), the value Claude Code calls `refreshTokenExpiresAt`.
    // Set only by the server sign-in (`accountLoginService.complete`, from
    // {@link signInDeadline}) and the rotation merges (from
    // {@link refreshDeadline}, which never moves it later). The folder file's
    // own value is read live by the node reader, never copied here. A malformed
    // value reads as absent and never invalidates the record.
    refreshTokenExpiresAt: z.number().optional().catch(undefined),
    // Issue #6161 (R1): where `refreshTokenExpiresAt` came from — `server` (the
    // token response's `refresh_token_expires_in`) or `default` (the sign-in
    // time plus {@link SIGN_IN_DEFAULT_LIFETIME_MS}). A plain string, so a later
    // value never invalidates an older reader's record.
    refreshTokenExpiresAtSource: z.string().optional().catch(undefined),
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
 * Issue #6800: the `unrefreshableReason` the shared-chain detector writes when an
 * account's store record (or, on the identity pass, the account `~/.claude.json`
 * names) holds the same OAuth refresh-token chain as `~/.claude`. Two refreshers
 * on one chain is the #1520 race, so the account is quarantined until a sign-in
 * through Provider Accounts writes a different token. It is not a login death:
 * the chain may still be alive in `~/.claude` for terminal `claude`. Defined once
 * here, for the CLI and the server.
 */
export const HOST_CHAIN_SHARED_REASON = "host-chain-shared";

/**
 * Issue #6801 (R14): the ONE list of `unrefreshableReason` values that flag a
 * record without its login having died. #6800's `host-chain-shared` quarantine
 * is the only one: the chain may still be alive in `~/.claude`. A record flagged
 * for one of these gets no death time, reads as no death time, and never enters
 * the death list or the death history.
 */
export const NON_DEATH_UNREFRESHABLE_REASONS: ReadonlySet<string> = new Set([
  HOST_CHAIN_SHARED_REASON,
]);

/** True when the record is flagged for a non-death reason (R14). */
export function isNonDeathFlag(account: {
  unrefreshable?: boolean;
  unrefreshableReason?: string | null;
}): boolean {
  return (
    account.unrefreshable === true &&
    typeof account.unrefreshableReason === "string" &&
    NON_DEATH_UNREFRESHABLE_REASONS.has(account.unrefreshableReason)
  );
}

/** Issue #6801 (R13): the most past deaths a record keeps. */
export const SIGN_IN_DEATHS_MAX = 10;

/**
 * Issue #6801 (R2): the record's death time, or null when it has none it can
 * trust. A time is trusted only while the record is flagged for a death (not a
 * {@link isNonDeathFlag} quarantine), the time is a finite positive number, and
 * `unrefreshableAtFor` still names the current flag
 * (`unrefreshableTokenFingerprint ?? unrefreshableReason`). An older build's
 * clear keeps the stamp (its clear spreads the rest of the record) and its later
 * re-flag on a new token writes a new fingerprint, so the stale stamp stops
 * matching and reads as unknown instead of a death age that is too young.
 */
export function trustedUnrefreshableAt(
  account: Pick<
    StoredAccount,
    | "unrefreshable"
    | "unrefreshableAt"
    | "unrefreshableAtFor"
    | "unrefreshableTokenFingerprint"
    | "unrefreshableReason"
  >
): number | null {
  if (account.unrefreshable !== true || isNonDeathFlag(account)) return null;
  const at = account.unrefreshableAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  const key =
    account.unrefreshableTokenFingerprint ?? account.unrefreshableReason;
  if (key === undefined || account.unrefreshableAtFor !== key) return null;
  return at;
}

/**
 * Issue #6801 (R13, Task 15): the death history a sign-in carries into the
 * record it writes over `existing`. Starts from the existing history and, when
 * `existing` died with a trusted time, appends that death (its sign-in, its
 * death, and its last refresh as the last time known alive). Keeps the newest
 * {@link SIGN_IN_DEATHS_MAX}; undefined when there is nothing to carry. A
 * quarantine or a flag with no trusted time appends nothing.
 *
 * Issue #6161 (R18): `predictedDeadlineAt` is the deadline the rule gave the
 * replaced login ({@link resolveSignInDeadline}); the appended death carries it
 * only when it is a finite number, and omits the key otherwise.
 */
export function carrySignInDeaths(
  existing: StoredAccount | null,
  predictedDeadlineAt?: number | null
): StoredAccount["signInDeaths"] {
  if (!existing) return undefined;
  const deaths: SignInDeath[] = [...(existing.signInDeaths ?? [])];
  const diedAt = trustedUnrefreshableAt(existing);
  if (diedAt !== null) {
    deaths.push({
      signedInAt: existing.capturedAt,
      diedAt,
      lastAliveAt:
        existing.lastRefreshedAt > 0
          ? existing.lastRefreshedAt
          : existing.capturedAt,
      ...(typeof predictedDeadlineAt === "number" &&
      Number.isFinite(predictedDeadlineAt)
        ? { predictedDeadlineAt }
        : {}),
    });
  }
  const kept = deaths.slice(-SIGN_IN_DEATHS_MAX);
  return kept.length > 0 ? kept : undefined;
}

/**
 * Issue #6161 (R1): how long a sign-in lasts when the token response carries no
 * `refresh_token_expires_in` — 30 days, Claude Code 2.1.321's own default (its
 * constant `xU = 2592000000`). The three deaths measured before #6801 each came
 * at the first refresh after a recorded deadline of this length (Matt G on ms1,
 * 2026-11-02; Matt G on RP1, 2026-11-04; Mose on RP1, 2026-11-13).
 */
export const SIGN_IN_DEFAULT_LIFETIME_MS = 2_592_000_000;

/** Claude Code 2.1.321's lower bound for a deadline (`sW`): 2025-01-01 UTC. */
const DEADLINE_FLOOR_MS = Date.UTC(2025, 0, 1);
/** Claude Code 2.1.321's upper bound for a deadline: now + 10 years. */
const DEADLINE_HORIZON_MS = 315_360_000_000;
/** Claude Code 2.1.321's stale guard in its 3-day notice: 3 days. */
const DEADLINE_STALE_GUARD_MS = 3 * 86_400_000;
/**
 * A folder sign-in marker within this much of `capturedAt` names the same
 * sign-in as the store record (the marker is written just after the record).
 */
const MARKER_SAME_SIGN_IN_MS = 60_000;

/**
 * Issue #6161 (R6): true when `value` may be used as a deadline — a finite number
 * from 2025-01-01 UTC to `nowMs` + 10 years. This is Claude Code 2.1.321's `FNr`
 * exactly. Anything else (a value in seconds, a string, NaN) reads as absent.
 */
export function isPlausibleDeadline(
  value: unknown,
  nowMs: number
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= DEADLINE_FLOOR_MS &&
    value <= nowMs + DEADLINE_HORIZON_MS
  );
}

/** A `refresh_token_expires_in` value Hapimatic uses: a finite positive number. */
function isUsableExpiresIn(expiresIn: unknown): expiresIn is number {
  return (
    typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
  );
}

/**
 * Issue #6161 (R1): the deadline a sign-in at `nowMs` records — `nowMs` plus the
 * response's `refresh_token_expires_in` seconds when it is a finite positive
 * number (`server`), else `nowMs` plus {@link SIGN_IN_DEFAULT_LIFETIME_MS}
 * (`default`), as Claude Code 2.1.321 does at its own sign-in. A server value
 * whose deadline would fail {@link isPlausibleDeadline} (an overflow to
 * Infinity, or more than 10 years ahead) is treated as absent (review CR-F6),
 * so the store never holds a value every reader then ignores.
 */
export function signInDeadline(
  nowMs: number,
  expiresIn: unknown
): { at: number; source: "server" | "default" } {
  if (isUsableExpiresIn(expiresIn)) {
    const at = nowMs + expiresIn * 1000;
    if (isPlausibleDeadline(at, nowMs)) return { at, source: "server" };
  }
  return { at: nowMs + SIGN_IN_DEFAULT_LIFETIME_MS, source: "default" };
}

/**
 * Issue #6161 (R2, R20): the non-secret tag a sign-in or rotation log line
 * prints for a token response's raw `refresh_token_expires_in`: the number as
 * text, `absent` when the key is missing, or `non-number:<typeof>` (so a string
 * value is never logged as absent). It never holds the value of a non-number.
 */
export function describeExpiresIn(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "number") return String(value);
  return `non-number:${typeof value}`;
}

/**
 * Issue #6161 (R1, R5): a response's `refresh_token_expires_in` as a finite
 * number, or null for anything else (absent, a string, NaN).
 */
export function finiteExpiresIn(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Issue #6161 (R5): the deadline after a rotation at `nowMs`. Claude Code
 * 2.1.321's refresh rule: a plausible old value and a usable response value give
 * the earlier of the two; a plausible old value and no response value keep the
 * old value; an absent or implausible old value stays absent (undefined). A
 * rotation never moves a deadline later and never creates one.
 */
export function refreshDeadline(
  old: unknown,
  nowMs: number,
  expiresIn: unknown
): number | undefined {
  if (!isPlausibleDeadline(old, nowMs)) return undefined;
  return isUsableExpiresIn(expiresIn)
    ? Math.min(old, nowMs + expiresIn * 1000)
    : old;
}

/**
 * Issue #6161 (R7): true when the login's own facts prove `value` is not its
 * deadline — it refreshed successfully after `value` (`lastRefreshedAt > value`),
 * or its access token outlives `value` by more than 3 days (Claude Code
 * 2.1.321's own stale guard in its 3-day notice:
 * `if(typeof e.expiresAt==="number"&&e.expiresAt>t+n)return null`). The ONE
 * `disproved` test: {@link resolveSignInDeadline} and the folder seed use it.
 */
export function isDeadlineDisproved(
  value: number,
  lastRefreshedAt: number,
  expiresAt: number
): boolean {
  return lastRefreshedAt > value || expiresAt > value + DEADLINE_STALE_GUARD_MS;
}

/** The facts {@link resolveSignInDeadline} reads, all epoch ms. */
export interface SignInDeadlineFacts {
  /** The store record's sign-in time. */
  capturedAt: number;
  /** The store record's last successful refresh (0 when never). */
  lastRefreshedAt: number;
  /** The store record's access-token expiry (0 when unknown). */
  expiresAt: number;
  /** The store record's own `refreshTokenExpiresAt` (a sign-in on a build with #6161). */
  signInDeadline?: number | null;
  /** The account folder file's `claudeAiOauth.refreshTokenExpiresAt`, read live. */
  folderDeadline?: number | null;
  /** The `writtenAt` of the account folder's sign-in marker, read live. */
  folderSignInAt?: number | null;
  nowMs: number;
}

/**
 * Issue #6161 (R7): the ONE rule that resolves a login's sign-in deadline from
 * its facts. Every consumer (the web, the CLI and the alert service) calls it, so
 * a fix to the rule ships with the consumers' build, not with every node.
 *
 * Sources (a closed list, typed `string` so an older reader never rejects a new
 * one): `folder`, `sign-in`, `folder-unconfirmed`, `estimated`,
 * `marker-estimated`, `disproved`, `unknown` (and `unreported`, added by
 * `resolveEntryDeadline` for a node that sends no facts). `folder-unconfirmed`,
 * `estimated` and `marker-estimated` are estimates ("about").
 *
 * - A value the login has outlived is never the deadline ({@link isDeadlineDisproved}).
 * - A folder value earlier than the sign-in is a stale carry and is ignored.
 * - Signed in on a build with #6161 (a plausible `signInDeadline`): a folder value
 *   at or after `capturedAt` that is not disproved wins (a later native or
 *   sibling sign-in moved it); else the record's own deadline; else, when the
 *   folder's marker names a later sign-in, the marker time plus 30 days.
 * - Signed in before #6161: a folder value later than every estimate wins, because
 *   only a later sign-in can produce it; a folder value no later than the
 *   earliest live estimate is used, marked unconfirmed; else the earliest estimate
 *   that is not disproved (`capturedAt` + 30 d, or the marker time + 30 d).
 *
 * The rule takes the EARLIEST candidate that is not disproved, never the latest.
 * The marker is written whenever the account folder exists, but the tokens only
 * when its credentials file exists, so a marker can name a sign-in whose chain is
 * not in the folder; and nothing rewrites or deletes a marker, so it can be older
 * than a later native sign-in. It can be stale in both directions: taking the
 * latest candidate would then warn late or not at all, which is the outage #6161
 * exists to prevent. Taking the earliest costs at most an early warning, and the
 * first refresh after a wrong early candidate disproves it.
 */
export function resolveSignInDeadline(input: SignInDeadlineFacts): {
  at: number | null;
  source: string;
} {
  const { capturedAt, lastRefreshedAt, expiresAt, nowMs } = input;
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) {
    return { at: null, source: "unknown" };
  }
  const disproved = (v: number): boolean =>
    isDeadlineDisproved(v, lastRefreshedAt, expiresAt);
  const folder = isPlausibleDeadline(input.folderDeadline, nowMs)
    ? input.folderDeadline
    : null;
  const marker =
    typeof input.folderSignInAt === "number" &&
    Number.isFinite(input.folderSignInAt) &&
    input.folderSignInAt > 0 &&
    input.folderSignInAt <= nowMs
      ? input.folderSignInAt
      : null;
  const est = capturedAt + SIGN_IN_DEFAULT_LIFETIME_MS;

  // Signed in on a build with #6161: the record holds its own deadline.
  if (isPlausibleDeadline(input.signInDeadline, nowMs)) {
    const own = input.signInDeadline;
    // A folder value equal to its own deadline is the sign-in's own
    // write-through, not a confirmation (review CR-F2): it keeps the record's
    // source, so a defaulted sign-in still reads as "about".
    if (
      folder !== null &&
      folder !== own &&
      folder >= capturedAt &&
      !disproved(folder)
    ) {
      return { at: folder, source: "folder" };
    }
    if (!disproved(own)) return { at: own, source: "sign-in" };
    if (marker !== null && marker > capturedAt + MARKER_SAME_SIGN_IN_MS) {
      const markerEst = marker + SIGN_IN_DEFAULT_LIFETIME_MS;
      if (!disproved(markerEst)) {
        return { at: markerEst, source: "marker-estimated" };
      }
    }
    return { at: null, source: "disproved" };
  }

  // Signed in before #6161, no marker.
  if (marker === null) {
    if (folder !== null && !disproved(folder)) {
      if (folder > est) return { at: folder, source: "folder" };
      if (folder >= capturedAt) {
        return { at: folder, source: "folder-unconfirmed" };
      }
    }
    if (!disproved(est)) return { at: est, source: "estimated" };
    return { at: null, source: "disproved" };
  }

  // Signed in before #6161, with a marker.
  const markerEst = marker + SIGN_IN_DEFAULT_LIFETIME_MS;
  const later = Math.max(est, markerEst);
  const lower = Math.min(capturedAt, marker);
  const live = [est, markerEst]
    .filter(v => !disproved(v))
    .sort((a, b) => a - b);
  if (folder !== null && !disproved(folder)) {
    if (folder > later) return { at: folder, source: "folder" };
    if (folder >= lower && (live.length === 0 || folder <= live[0])) {
      return { at: folder, source: "folder-unconfirmed" };
    }
  }
  if (live.length > 0) {
    return {
      at: live[0],
      source: live[0] === est ? "estimated" : "marker-estimated",
    };
  }
  return { at: null, source: "disproved" };
}

/**
 * Issue #6800 (round 2, R2-1): the file a Provider Accounts sign-in leaves in the
 * account's existing folder, naming the sha256 fingerprint of the refresh token
 * that sign-in produced (never the token). A `host-chain-shared` flag is lifted
 * from a folder token only when the token matches this fingerprint, because a
 * token that merely differs from the flagged one may be an older token of the
 * same `~/.claude` chain. Written by the server, read by the CLI daemon.
 */
export const SIGN_IN_MARKER_FILE = ".hapimatic-sign-in.json";

/** The sign-in marker's on-disk shape (see {@link SIGN_IN_MARKER_FILE}). */
export interface SignInMarker {
  version: 1;
  /** sha256 hex of the refresh token the sign-in produced. */
  refreshFingerprint: string;
  /** ISO 8601 UTC time of the sign-in. */
  writtenAt: string;
}

/**
 * The refresh fingerprint a sign-in marker names, or null for anything that is
 * not a well-formed version-1 marker. Never throws.
 */
export function parseSignInMarker(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const marker = parsed as Partial<SignInMarker>;
    if (marker.version !== 1) return null;
    const fp = marker.refreshFingerprint;
    return typeof fp === "string" && /^[0-9a-f]{64}$/.test(fp) ? fp : null;
  } catch {
    return null;
  }
}

/**
 * Issue #6161 (DEC-1): the time a sign-in marker records (its `writtenAt`) as
 * epoch ms, or null for anything that is not a version-1 marker with a parsable
 * time. Never throws.
 */
export function parseSignInMarkerWrittenAt(raw: string): number | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const marker = parsed as Partial<SignInMarker>;
    if (marker.version !== 1 || typeof marker.writtenAt !== "string") {
      return null;
    }
    const at = Date.parse(marker.writtenAt);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
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
 * #4349 (E6 Sub A, Task 4a): a TOKEN-LESS Anthropic account — the customer signed in inside their
 * own VM with the unmodified Claude Code binary's `/login`, in this account's own isolated
 * `CLAUDE_CONFIG_DIR`. The binary holds, reads and rotates its credential in that directory;
 * Hapimatic stores only identity metadata (read from the dir's `.claude.json`, never its
 * `.credentials.json`) and the `configDir` REFERENCE, modelled on the reference-only Codex record
 * ({@link OpenAiStoredAccountSchema}'s `codexHome`).
 *
 * PK (`accountUuid`): a MINTED uuid that names the directory, so `configDir` is the canonical
 * `<accountConfigsDir>/<accountUuid>` every isolated-dir reader already uses. The dir exists before
 * `/login` reveals who signed in, so the Anthropic account's own uuid is kept separately as
 * `identityAccountUuid`. `provider` stays absent on disk (⇒ anthropic), like every Anthropic record.
 *
 * It is deliberately NOT a {@link StoredAccount}: {@link validateStoredAccount} refuses it, so no
 * token consumer (refresh, injection, the usage sampler's store read) can ever be handed one. The
 * refine forbids any token field, so a placeholder token can never be written into one.
 */
export const NativeAnthropicStoredAccountSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    provider: z.literal("anthropic").optional(),
    authKind: z.literal("native"),
    accountUuid: z.string().min(1),
    /** The Anthropic account uuid from the dir's `.claude.json` `oauthAccount` (identity only). */
    identityAccountUuid: z.string().min(1),
    emailAddress: z.string().min(1),
    organizationUuid: z.string().default(""),
    organizationName: z.string().default(""),
    displayName: z.string().default(""),
    billingType: z.string().default(""),
    /** The isolated `CLAUDE_CONFIG_DIR` the binary signed in to — a REFERENCE, never a secret. */
    configDir: z.string().min(1),
    capturedAt: z.number(),
    lastUsedAt: z.number(),
  })
  .passthrough()
  .refine(
    account =>
      !["accessToken", "refreshToken", "expiresAt", "scopes"].some(
        key => key in account
      ),
    { message: "a native account never carries a token (#4349)" }
  );
export type NativeAnthropicStoredAccount = z.infer<
  typeof NativeAnthropicStoredAccountSchema
>;

/** #4349: true for a token-less, in-VM-signed-in Anthropic account record. */
export function isNativeAnthropicAccount(
  account: AnyStoredAccount
): account is NativeAnthropicStoredAccount {
  return (account as { authKind?: unknown }).authKind === "native";
}

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
  | NativeAnthropicStoredAccount
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
  // #4349: a token-less in-VM-signed-in Anthropic record (authKind "native").
  if (
    (input as { authKind?: unknown } | null | undefined)?.authKind === "native"
  ) {
    const result = NativeAnthropicStoredAccountSchema.safeParse(input);
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
  // #4349: a native (token-less) record is never a token-bearing StoredAccount — say so plainly,
  // so a token consumer that reads it skips it instead of reporting a malformed token.
  if (
    (input as { authKind?: unknown } | null | undefined)?.authKind === "native"
  ) {
    return {
      ok: false,
      error:
        "native account: signed in inside the VM; the binary holds its credential in its config dir (#4349)",
    };
  }
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
 * True for a subscription entitled to the Max-class models (`"max"`, or
 * `"ultra"`). Anthropic now calls Max 20x the "Ultra" plan (#6095); no captured
 * `oauth/profile` response returns `"ultra"` yet, so accepting it is
 * forward-compatible hardening — a rename must not drop the `opus[1m]` entitled
 * pin or the model-downgrade warning, which both gate on this predicate.
 */
export function isMaxClassSubscription(
  subscriptionType: string | null | undefined
): boolean {
  const normalized = subscriptionType?.trim().toLowerCase();
  return normalized === "max" || normalized === "ultra";
}

/**
 * Computes a human-readable plan label from subscription type and rate limit tier.
 *
 * Mapping:
 * - "pro" → "Claude Pro"
 * - "max" + "default_claude_max_5x" → "Max 5X"
 * - "max" + "default_claude_max_20x" → "Max 20X"
 * - "max" (unknown tier) → "Claude Max"
 * - "ultra" → "Ultra" (#6095)
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

  if (normalizedType === "ultra") {
    return "Ultra";
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
