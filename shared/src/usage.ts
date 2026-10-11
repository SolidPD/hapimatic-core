// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { ProviderIdSchema } from "./providerAuthState";

/**
 * Per-account Claude usage-limit contract (epic #1855, Sub-Issue A / #1856).
 *
 * `Utilization` mirrors the Anthropic `GET /api/oauth/usage` response shape —
 * the endpoint Claude Code's own `/usage` screen reads. The server-side
 * usage-fetch service (Sub B / #1857) returns ONLY the redacted `AccountUsage`
 * envelope to the browser and across the federation boundary — never tokens —
 * extending the `RedactedAccount` whitelist discipline
 * (`server/src/services/accountService.ts`).
 *
 * passthrough policy (load-bearing — do NOT "normalize" this for consistency):
 *  - `Utilization` / `RateLimit` / `ExtraUsage` mirror upstream → `.passthrough()`
 *    so fields Anthropic adds before the fork catches up are preserved on parse
 *    (the `@hapi/protocol` convention for externally-sourced data — see
 *    `shared/CLAUDE.md`).
 *  - `AccountUsage` is the Hapimatic-defined redaction boundary → plain
 *    `z.object()` (NO `.passthrough()`) so unknown/token keys are STRIPPED on
 *    parse. This is the structural guarantee that `accessToken` / `refreshToken`
 *    / `scopes` can never leak through the envelope, mirroring
 *    `RedactedAccountSchema`. Adding `.passthrough()` here would silently defeat
 *    that guarantee.
 */

/**
 * One rate-limit window from `oauth/usage` (e.g. the 5-hour or weekly window).
 * `utilization` is a 0–100 percentage; both fields are null when the window has
 * no data.
 */
export const RateLimitSchema = z
  .object({
    utilization: z.number().nullable(), // 0–100 percentage
    resets_at: z.string().nullable(), // ISO-8601 timestamp
  })
  .passthrough();

export type RateLimit = z.infer<typeof RateLimitSchema>;

/**
 * Extra-usage credit pool (US dollars) from `oauth/usage`. `monthly_limit` is
 * the dollar cap, `used_credits` the dollars consumed this month, `utilization`
 * the 0–100 percentage of the cap used.
 */
export const ExtraUsageSchema = z
  .object({
    is_enabled: z.boolean(),
    monthly_limit: z.number().nullable(), // $ monthly cap
    used_credits: z.number().nullable(), // $ used this month
    utilization: z.number().nullable(), // 0–100 percentage
  })
  .passthrough();

export type ExtraUsage = z.infer<typeof ExtraUsageSchema>;

/**
 * A money value from the modern `oauth/usage` `spend` object, expressed in MINOR
 * units: dollars = `amount_minor / 10^exponent` (e.g. `4105`, exponent 2 → $41.05).
 * Every field is optional — see the schema-resilience note on {@link SpendSchema}.
 */
export const SpendMoneySchema = z
  .object({
    amount_minor: z.number().optional(),
    currency: z.string().optional(),
    exponent: z.number().optional(),
  })
  .passthrough();

export type SpendMoney = z.infer<typeof SpendMoneySchema>;

/**
 * The modern usage-credits / overage object from `oauth/usage` (issue #2091). The
 * structured successor to the legacy flat `extra_usage` fields — `used`/`limit` carry
 * the same dollar amounts as `extra_usage.{used_credits,monthly_limit}` (verified live
 * 2026-07-08: `spend.used.amount_minor === extra_usage.used_credits`, both in cents).
 *
 * Schema-resilience constraint (expert review 2091-1): the ONLY production parse is a
 * hard `UtilizationSchema.parse()` at `server/src/accounts/usageService.ts`, whose catch
 * degrades the ENTIRE account row to `status:"error"` (also suppressing usage alerts +
 * history sampling). Therefore EVERY field here MUST be optional/nullable — a single
 * required key turns benign upstream drift into a whole-row outage. `cap` (live shape
 * `{ money, credits }`) and `spend.disclaimer`/`auto_reload` ride through `.passthrough()`
 * un-typed; model them explicitly only if the UI ever reads them.
 */
export const SpendSchema = z
  .object({
    used: SpendMoneySchema.nullable().optional(),
    limit: SpendMoneySchema.nullable().optional(),
    percent: z.number().nullable().optional(),
    severity: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    disabled_reason: z.string().nullable().optional(),
    cap: SpendMoneySchema.nullable().optional(),
    balance: SpendMoneySchema.nullable().optional(),
    can_toggle: z.boolean().optional(),
    can_purchase_credits: z.boolean().optional(),
  })
  .passthrough();

export type Spend = z.infer<typeof SpendSchema>;

/**
 * The `scope` on a `limits[]` entry: identifies which model a `weekly_scoped` window
 * applies to (e.g. `scope.model.display_name: "Fable"`). All-optional per the
 * schema-resilience constraint on {@link SpendSchema}.
 */
export const LimitScopeSchema = z
  .object({
    model: z
      .object({ display_name: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type LimitScope = z.infer<typeof LimitScopeSchema>;

/**
 * One entry of the modern `limits[]` array from `oauth/usage` (issue #2091). A
 * self-describing window keyed by `kind`:
 *  - `kind:"session"`       → the 5-hour window
 *  - `kind:"weekly_all"`    → the "All models" weekly window
 *  - `kind:"weekly_scoped"` → a per-model weekly window; `scope.model.display_name`
 *    names the model (e.g. "Fable"). Render ALL `weekly_scoped` entries generically
 *    by their `display_name` so a future scoped model auto-appears.
 *
 * All-optional per the schema-resilience constraint on {@link SpendSchema}.
 */
export const LimitEntrySchema = z
  .object({
    kind: z.string().optional(),
    group: z.string().nullable().optional(),
    percent: z.number().nullable().optional(),
    severity: z.string().nullable().optional(),
    resets_at: z.string().nullable().optional(), // ISO-8601 timestamp
    scope: LimitScopeSchema.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .passthrough();

export type LimitEntry = z.infer<typeof LimitEntrySchema>;

/**
 * Full `oauth/usage` payload. Every field is optional AND nullable: the
 * endpoint returns `{}` when the token lacks the `profile` scope, and an
 * individual window can be null when it carries no data.
 */
export const UtilizationSchema = z
  .object({
    five_hour: RateLimitSchema.nullable().optional(),
    seven_day: RateLimitSchema.nullable().optional(),
    seven_day_sonnet: RateLimitSchema.nullable().optional(),
    seven_day_opus: RateLimitSchema.nullable().optional(),
    seven_day_oauth_apps: RateLimitSchema.nullable().optional(),
    extra_usage: ExtraUsageSchema.nullable().optional(),
    // Modern per-model / self-describing window array (issue #2091). Carries the
    // `weekly_scoped` Fable window; rides alongside the legacy flat `five_hour` /
    // `seven_day` fields (which stay the source for the existing meters).
    limits: z.array(LimitEntrySchema).nullable().optional(),
    // Modern usage-credits / overage object (issue #2091) — structured successor
    // to `extra_usage`; the source for the new overage bar.
    spend: SpendSchema.nullable().optional(),
  })
  .passthrough();

export type Utilization = z.infer<typeof UtilizationSchema>;

/**
 * Per-account usage-fetch outcome, classified server-side:
 *  - `ok`         — the endpoint returned usage data
 *  - `expired`    — the token is genuinely dead (the server skips the call to
 *                   avoid a 401): reserved for `unrefreshable === true` or a live
 *                   401/403. Actionable — the user must re-login.
 *  - `refreshing` — (#2281) the token is within `EXPIRY_BUFFER_MS` of expiry but
 *                   the account is REFRESHABLE, so the upstream call was skipped
 *                   and the daemon backstop rotates it within ~60s. Transient,
 *                   self-healing, NOT user-actionable — distinct from `expired`.
 *  - `rate_limited` — (#2608) the upstream returned HTTP 429 and a bounded,
 *                   Retry-After-aware retry did not clear within the sampler
 *                   budget. Transient and retriable (distinct from `error`); the
 *                   last-good meters are preserved and flagged, so the card shows
 *                   meters + "temporarily rate-limited" rather than a blank row.
 *  - `no_scope`   — the token lacks the `profile` scope (endpoint returned `{}`)
 *  - `error`      — the fetch threw or timed out
 */
export const AccountUsageStatusSchema = z.enum([
  "ok",
  "expired",
  "refreshing",
  "rate_limited",
  "no_scope",
  "error",
]);

export type AccountUsageStatus = z.infer<typeof AccountUsageStatusSchema>;

/**
 * Redacted per-account usage envelope returned over the HTTP API and across the
 * federation boundary. Whitelist-by-construction (plain `z.object()`, NO
 * `.passthrough()`) — mirrors `RedactedAccountSchema`. Carries display-safe
 * identity + utilization + status; structurally CANNOT carry `accessToken` /
 * `refreshToken` / `scopes`.
 */
export const AccountUsageSchema = z.object({
  accountUuid: z.string(),
  // Human-readable label for the card; the server (Sub B) populates this from
  // the account's displayName || emailAddress.
  displayLabel: z.string(),
  // The account's email address — display-safe identity, populated server-side
  // from the redacted account's `emailAddress`. Optional for backward
  // compatibility with envelopes serialized before this field existed. The card
  // renders this as the primary identifier with `displayLabel` as the
  // secondary colloquial name (epic #1855 follow-up to Sub E).
  email: z.string().optional(),
  // Optional user-set nickname (epic #1855 follow-up). Persisted server-side in
  // a dedicated nickname store keyed by accountUuid (NOT the token-bearing
  // record). The card renders it as the editable colloquial label; absent →
  // falls back to displayLabel.
  nickname: z.string().optional(),
  // Plan badge label (e.g. "Max 20X") via computePlanLabel; may be undefined
  // when subscription type is unknown.
  planLabel: z.string().optional(),
  // Node labels holding a valid token for this account (e.g. ["rp1", "sl7"]).
  // Usage limits are account-global, so this is metadata, not separate cards.
  machines: z.array(z.string()),
  utilization: UtilizationSchema,
  status: AccountUsageStatusSchema,
  fetchedAt: z.number(), // server-stamped epoch ms (Date.now())
  // Pacing score on the 0–100 burn scale (epic #2038 Sub A1 / #2039; algorithm
  // redesigned 2026-07-20 to sustainable-rate pacing — see
  // computeUtilizationScore). Stamped server-side by usageService.buildUsage
  // — a number for status "ok", null for {expired, refreshing, rate_limited, no_scope, error}. OPTIONAL for the same
  // federation backward-compat reason as email/nickname/planLabel above: a peer that
  // serialized an envelope before this field existed must still parse (the field is absent,
  // not invalid), so the hub's AccountUsageSchema.safeParse keeps the row instead of dropping it.
  score: z.number().nullable().optional(),
});

export type AccountUsage = z.infer<typeof AccountUsageSchema>;

/**
 * Per-provider usage-fetch outcome for a NON-Anthropic account (issue #3809). A
 * DISTINCT status vocabulary from `AccountUsageStatusSchema` because the provider
 * signals differ in kind: OpenAI's pacing snapshot is SESSION-delivered (fresh only
 * while a session of that account runs), and Google is a derived spend counter with
 * no pollable limit at all. States:
 *  - `ok`      — fresh snapshot (OpenAI) or a current counter (Google)
 *  - `stale`   — the OpenAI snapshot is older than the sampler interval → the card
 *                shows "as of <time>"
 *  - `unknown` — no snapshot has arrived yet for this account
 *  - `error`   — the OpenAI snapshot aged past the hard threshold, so a selector
 *                never makes a false-healthy pick
 * `[ER 2026-09-19: 3809-3]`
 */
export const ProviderUsageStatusSchema = z.enum([
  "ok",
  "stale",
  "unknown",
  "error",
]);

export type ProviderUsageStatus = z.infer<typeof ProviderUsageStatusSchema>;

/**
 * One raw window from the OpenAI/codex `token_count.rate_limits` snapshot
 * (`primary` = 5-hour, `secondary` = weekly), carried verbatim beside the mapped
 * `utilization` so the card can show the provider's own window semantics. Plain
 * `z.object()` (whitelist, NO `.passthrough()`) — the same redaction boundary as
 * `AccountUsageSchema`. `resets_at` is an ISO-8601 string (epoch-seconds converted,
 * or `now + resets_in_seconds`, by the carrier — the source field on the installed
 * codex 0.147.x is pinned by #3352). `[ER 2026-09-19: NEW-3809-14]`
 */
export const ProviderUsageWindowSchema = z.object({
  name: z.enum(["primary", "secondary"]),
  used_percent: z.number(),
  window_minutes: z.number(),
  resets_at: z.string().nullable(),
});

export type ProviderUsageWindow = z.infer<typeof ProviderUsageWindowSchema>;

/**
 * Google (Gemini) derived token-SPEND counter (issue #3809, R2). Named `tokenSpend`
 * — NOT `spend` — to avoid the Anthropic overage object inside `UtilizationSchema`
 * (#2091). There is no queryable account-level Gemini limit for an API key, so this
 * is a plain running total from the node's `turns` rows: never a 0–100 % bar, never
 * a veto/HOLD input. `asOf` is server-stamped epoch ms. `[ER 2026-09-19: 3809-4]`
 */
export const ProviderTokenSpendSchema = z.object({
  tokensToday: z.number(),
  tokensThisWeek: z.number(),
  asOf: z.number(),
});

export type ProviderTokenSpend = z.infer<typeof ProviderTokenSpendSchema>;

/**
 * Redacted per-account usage envelope for a NON-Anthropic provider (issue #3809,
 * ruling D5 = C). Served under the SIBLING top-level key `providerUsage[]` on
 * `GET /api/accounts/usage` and `GET /api/federation/accounts/usage`, leaving
 * `AccountUsageSchema` / `usage[]` byte-identical and Anthropic-only forever.
 *
 * Whitelist-by-construction (plain `z.object()`, NO `.passthrough()`, `.parse()`d on
 * every egress exactly like `AccountUsageSchema`) — structurally cannot carry a
 * token/key value. `provider` is `ProviderIdSchema.exclude(["anthropic"])`
 * ("openai" | "google"), so a fourth provider added upstream flows through with no
 * edit here.
 *
 *  - **OpenAI**: `utilization` carries `five_hour` (codex `primary`) + `seven_day`
 *    (codex `secondary`) as `RateLimit` entries, so `computeUtilizationScore` applies
 *    UNCHANGED; `windows[]` carries the raw snapshot; `score` is a number when both
 *    windows have `resets_at`, else null.
 *  - **Google**: `utilization: {}`, `score: null`, `tokenSpend` carries the counter.
 * `[ER 2026-09-19: 3809-1]` `[ER 2026-09-19: D5]`
 */
export const ProviderAccountUsageSchema = z.object({
  provider: ProviderIdSchema.exclude(["anthropic"]),
  accountUuid: z.string(),
  displayLabel: z.string(),
  nickname: z.string().optional(),
  // Node labels holding this account (union across the federation), mirroring
  // AccountUsageSchema.machines.
  machines: z.array(z.string()),
  status: ProviderUsageStatusSchema,
  fetchedAt: z.number(), // server-stamped epoch ms (Date.now())
  // Pacing score on the 0–100 burn scale via computeUtilizationScore (OpenAI when
  // both windows carry resets_at), else null (OpenAI missing resets, Google always).
  score: z.number().nullable(),
  // OpenAI: five_hour + seven_day RateLimit entries so computeUtilizationScore
  // applies unchanged. Google: {}.
  utilization: UtilizationSchema,
  // Raw OpenAI snapshot windows (absent for Google).
  windows: z.array(ProviderUsageWindowSchema).optional(),
  // Google spend counter (absent for OpenAI).
  tokenSpend: ProviderTokenSpendSchema.optional(),
});

export type ProviderAccountUsage = z.infer<typeof ProviderAccountUsageSchema>;

/**
 * The paired usage envelope returned by both usage routes (issue #3809, D5 = C):
 * `usage[]` (Anthropic, byte-identical to the pre-#3809 contract) beside the
 * additive sibling `providerUsage[]` (OpenAI + Google). An un-upgraded reader that
 * knows only `usage[]` is unaffected — the sibling key is invisible to it, which is
 * what makes the two-repo rollback order-free.
 */
export const ProviderUsageEnvelopeSchema = z.object({
  usage: z.array(AccountUsageSchema),
  providerUsage: z.array(ProviderAccountUsageSchema),
});

export type ProviderUsageEnvelope = z.infer<typeof ProviderUsageEnvelopeSchema>;

/**
 * Per-account usage history + projection contract (epic #1855, Sub-Issue I / #1864).
 *
 * The history endpoint (`GET /api/accounts/usage/history`) returns, per limit
 * window, a recent utilization series (for a sparkline) plus a projected-exhaustion
 * estimate computed server-side from the recent slope. Like `AccountUsage`, these
 * are Hapimatic-defined redaction boundaries → plain `z.object()` (NO `.passthrough()`)
 * so unknown/token keys are STRIPPED on parse. Carries only display-safe numbers.
 */

/** The canonical `oauth/usage` window keys persisted per snapshot. */
export const UsageLimitKeySchema = z.enum([
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
  "seven_day_oauth_apps",
]);

export type UsageLimitKey = z.infer<typeof UsageLimitKeySchema>;

/** One persisted utilization sample: when it was taken + the 0–100 percentage. */
export const UsageHistoryPointSchema = z.object({
  sampledAt: z.number(), // epoch ms
  utilization: z.number(), // 0–100 percentage
});

export type UsageHistoryPoint = z.infer<typeof UsageHistoryPointSchema>;

/**
 * Projected-exhaustion estimate for one window, derived from the recent slope.
 * `exhaustionAt` is null when the projection is not derivable (< 2 points or a
 * non-positive slope) — never a fabricated time. `reachesLimitBeforeReset` is
 * false when the projected exhaustion falls after the window's `resets_at`.
 */
export const UsageProjectionSchema = z.object({
  exhaustionAt: z.number().nullable(), // epoch ms, or null when not projected
  slopePerHour: z.number(), // utilization-% per hour (recent slope)
  reachesLimitBeforeReset: z.boolean(),
  pointCount: z.number(), // sample points the projection was computed from
});

export type UsageProjection = z.infer<typeof UsageProjectionSchema>;

/** Recent series + projection for a single limit window. */
export const UsageWindowHistorySchema = z.object({
  limitKey: UsageLimitKeySchema,
  points: z.array(UsageHistoryPointSchema),
  projection: UsageProjectionSchema.nullable(),
});

export type UsageWindowHistory = z.infer<typeof UsageWindowHistorySchema>;

/**
 * Redacted per-account usage-history envelope returned over the HTTP API.
 * Whitelist-by-construction (plain `z.object()`, NO `.passthrough()`).
 */
export const AccountUsageHistorySchema = z.object({
  accountUuid: z.string(),
  windows: z.array(UsageWindowHistorySchema),
  generatedAt: z.number(), // server-stamped epoch ms
});

export type AccountUsageHistory = z.infer<typeof AccountUsageHistorySchema>;

/** Weekly rate-limit window length (7 days) — the basis for the weekly sustainable-rate
 *  ratio. Defined locally so the pacing algorithm stays self-contained in `@hapi/protocol`;
 *  deliberately NOT reused from `usageHistory.ts`'s unrelated sparkline lookback const. */
const WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** 5-hour rate-limit window length — the basis for the 5-hour sustainable-rate ratio. */
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60 * 1000;
/** One hour in ms — the unit the reference-burn tunables are expressed per. */
const HOUR_MS = 60 * 60 * 1000;
/** Pacing target for the WEEKLY window (#3610 D2): land at 100% of the weekly budget the
 *  moment it resets — "on pace" is a linear burn that exactly exhausts the weekly allowance
 *  at reset. Raised from the pre-#3610 shared 0.99 so weekly headroom is scored all the way
 *  to the cap (a late overshoot then locks every model until the weekly reset — the accepted
 *  D2 trade). The hard-lock at {@link HARD_LOCK_UTILIZATION} still deprioritizes an at-cap
 *  account before it locks. */
const WEEKLY_PACE_TARGET = 1.0;
/** Pacing target for the 5-HOUR window (#3610 D2): land at 99% the moment it resets, keeping
 *  the last 1% as unspent margin so a burst near the boundary does not trip the 5-hour cap. */
const FIVE_HOUR_PACE_TARGET = 0.99;
/** Reference burn rate for the 5-hour window — the "on-pace" spend rate (fraction of budget
 *  per hour) the pace score is measured against. Default = target / windowHours ≈ 0.198
 *  (19.8%/h), the value implicit in the pre-#3610 `windowMs/remainingMs` form (so the 5-hour
 *  score is unchanged by the #3610 rework). Exposed as a NAMED tunable (#3610 D3) so a future
 *  measured-live-slope upgrade can replace this default with an account's observed burn
 *  without touching the formula — a heavy session would then score worse than an idle one at
 *  the same utilization. */
const FIVE_HOUR_REFERENCE_BURN_PER_HOUR =
  FIVE_HOUR_PACE_TARGET / (FIVE_HOUR_WINDOW_MS / HOUR_MS);
/** Reference burn rate for the weekly window — same contract as
 *  {@link FIVE_HOUR_REFERENCE_BURN_PER_HOUR}. Default = target / windowHours ≈ 0.00595
 *  (0.595%/h). */
const WEEKLY_REFERENCE_BURN_PER_HOUR =
  WEEKLY_PACE_TARGET / (WEEKLY_WINDOW_MS / HOUR_MS);
/** Floor on time-to-reset inside the sustainable-rate ratio: prevents division blow-up at
 *  the reset boundary and bounds how hard "reset imminent + spare budget" can pull a score
 *  toward 0. A stale `resets_at` already in the past clamps here too (self-corrects on the
 *  next usage poll). */
const MIN_REMAINING_MS = 60 * 1000;
/** Utilization % at/above which a rate-limit window is EXHAUSTED and the account is fully
 *  unusable until it resets. A 5-hour or overall-weekly (`seven_day`) window at this level
 *  locks the account on EVERY model, so the pacing hard-lock forces the worst score (100).
 *  Model-scoped weekly windows (`seven_day_opus` / `seven_day_sonnet` / the Fable
 *  `weekly_scoped` entry) are deliberately NOT hard-locks — they cap one model but leave
 *  the account usable on the others; they are also excluded from the pacing math entirely
 *  (see {@link computeUtilizationScore}). */
// Exported (#3618) so the auto-switch selector reuses this literal instead of
// duplicating `100`. An account whose 5-hour OR overall-weekly window is at/above
// this level is fully unusable until reset — the least-attractive score.
export const HARD_LOCK_UTILIZATION = 100;

/**
 * Options for {@link computeUtilizationScore}. An injectable-clock seam so the weekly-pace
 * elapsed-fraction is deterministic under test (epic #2049, Sub-Issue I / #2058).
 */
export interface ComputeUtilizationScoreOptions {
  /** Resolved clock (epoch ms) the weekly-pace elapsed-fraction is computed against.
   *  Defaults to `Date.now()`; the server passes UsageService's injected clock so the
   *  score is deterministic under test (mirrors `computeProjection`'s `now: number`). */
  now?: number;
}

/**
 * Pace score for ONE rate-limit window on the 0–100 burn scale, or null when
 * `resetsAt` is absent/unparseable (the caller degrades — see the ladder in
 * {@link computeUtilizationScore}).
 *
 * Built on the **sustainable-rate ratio** `a`: the window's remaining budget per
 * remaining hour, normalized by a fresh window's budget per hour —
 *
 *   a = (paceTarget − used) / (referenceBurnPerHour × hoursToReset)
 *
 * (equivalent to the pre-#3610 `((paceTarget − used)/paceTarget) × windowMs/remainingMs`
 * when referenceBurnPerHour = paceTarget/windowHours, its default — see the constants).
 *
 * `a = 1` ⟺ the window sits EXACTLY on the ideal line that lands at 99% the
 * moment it resets, from ANY point in the cycle (fresh, mid-window, or late).
 * `a < 1` = burning ahead of that line; `a > 1` = spare capacity that EVAPORATES
 * at reset (use it or lose it). The hyperbolic map
 *
 *   score = 100 / (1 + a)
 *
 * pins the anchors: budget gone → 100, on pace → 50, double the sustainable
 * headroom → 33, reset-imminent-and-idle → ~0. Monotone in both inputs: more
 * usage → higher score; the SAME usage with a LONGER wait to reset → higher
 * score (94% with 6 days to wait is strictly worse than 94% with 1.6 days —
 * the reset moment is load-bearing, not just the percentage).
 */
function windowPaceScore(
  utilizationPct: number,
  resetsAt: string | null | undefined,
  windowMs: number,
  paceTarget: number,
  referenceBurnPerHour: number,
  now: number
): number | null {
  const resetMs = resetsAt ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(resetMs)) return null;
  const remainingMs = Math.min(
    windowMs,
    Math.max(MIN_REMAINING_MS, resetMs - now)
  );
  const remainingHours = remainingMs / HOUR_MS;
  const used = Math.min(1, Math.max(0, utilizationPct / 100));
  // Remaining budget (raw fraction of the window's allowance still unspent before the
  // per-window target) vs. the budget a reference-rate burn would still consume before
  // reset. availability = 1 ⟺ exactly on pace to hit `paceTarget` at reset; < 1 burning
  // ahead of pace; > 1 spare capacity that evaporates at reset. With referenceBurnPerHour =
  // paceTarget/windowHours (the default) this is identical to the pre-#3610
  // `remainingBudget × windowMs/remainingMs` form.
  const remainingBudget = Math.max(0, paceTarget - used);
  const sustainableRunway = referenceBurnPerHour * remainingHours;
  const availability =
    sustainableRunway > 0 ? remainingBudget / sustainableRunway : 0;
  return 100 / (1 + availability);
}

/**
 * Pacing score (0–100) for an account — **sustainable-rate pacing** (2026-07-20
 * redesign; supersedes the #2058 soft-OR pace-deviation formula, keeps #2161's
 * hard-lock). LOWER = more attractive to the load-balancer / sort — the convention
 * every consumer already assumes (the UI sorts ascending, most-available first).
 *
 * ## What the number means
 *
 * The score answers ONE question: *how much remaining budget-per-hour does this
 * account have, relative to the ideal pace that lands at 99% exactly when its
 * window resets?*
 *
 *   - **50**  = exactly on that ideal line (from any point in the cycle)
 *   - **< 50** = behind the line — spare capacity that EVAPORATES at reset (spend here)
 *   - **> 50** = ahead of the line — throttle, or the window trips before it resets
 *   - **100** = locked (a 5-hour or weekly window at cap — the hard-lock)
 *
 * ## Formula
 *
 * Per window ({@link windowPaceScore}; weekly T = 7 d, five-hour T = 5 h):
 *
 *   a       = (target − used) / (referenceBurnPerHour × hoursToReset)   // 1 = on pace
 *   S       = 100 / (1 + a)
 *   score   = round( max(S_weekly, S_5h) )
 *
 * Targets are per-window (#3610 D2): weekly = 1.00 (on pace = a linear burn that
 * exhausts the weekly allowance at reset), five-hour = 0.99 (keep 1% margin). The
 * reference burn rate is a NAMED tunable (#3610 D3) defaulting to target/windowHours
 * (weekly ≈ 0.595%/h, five-hour ≈ 19.8%/h). The score is the BINDING CONSTRAINT — the
 * MAX of the two window scores (#3610 D1): an account is only as available as its tighter
 * window, so a nearly-locked 5-hour window governs regardless of weekly slack, and a cold
 * 5-hour window can never pull the score below the weekly pace. (Pre-#3610 the 5-hour
 * window was a capped ≤ +20 penalty on the weekly headline, which let a nearly-locked
 * 5-hour account tie a cold one.) Tie-breaking on the OTHER window lives in the selectors
 * (hapimatic-private#3611 / rp1-home#2028), never blended into this served number.
 *
 * ## Why #2058 was replaced (the 2026-07-20 trigger report)
 *
 * All four Max-20x accounts read 62 / 62 / 66 / 73 while their weekly windows sat
 * at 94% (1.6 d to reset), 81% (2.8 d), 65% (4.4 d), and lowest-usage — the
 * least-used account ranked LAST-attractive. #2058's `0.5 + (w − 0.99·e)/2` scores
 * *deviation above the ideal line*, which INVERTS availability: a late-window
 * account at 94% sits NEAR the line (low deviation → low score) while a
 * freshly-reset account with modest usage towers over its near-zero ideal (high
 * score). Its /2 divisor then compressed everything into a ~55–75 band (the 62/62
 * tie). This formula scores *remaining-capacity-per-hour* instead — the quantity a
 * load-balancer actually spends. Same inputs now yield 81 / 68 / 65 / lowest:
 * correct burn-out ordering with real separation.
 *
 * ## Scope + degrade ladder
 *
 *   - Hard-lock (checked FIRST, unchanged from #2161): `five_hour ≥ 100` OR
 *     `seven_day ≥ 100` → 100. The account cannot serve a session right now.
 *   - Model-SCOPED weekly caps (`seven_day_opus` / `seven_day_sonnet` / the Fable
 *     `weekly_scoped` limits[] entry) are EXCLUDED entirely: they gate ONE model,
 *     not the account — the old `max()` fold made a single-model-capped account
 *     look globally hot. Per-model routing reads the per-model meters instead
 *     (e.g. the "Fable weekly %" sort mode).
 *   - Weekly reset null/unparseable → pace on the 5-hour window alone (full
 *     weight — it is the only time-aware signal left).
 *   - No usable reset at all → plain fullness `max(five_hour%, seven_day%)`,
 *     preserving ruling D11's property [expert-review 2026-07-02]: a hot 5-hour
 *     window is never masked into a top pick.
 *   - Degraded statuses never reach this function (usageService stamps score: null).
 *
 * `score = 0` is reachable only as "reset imminent with unspent budget" (burst
 * now — the capacity is about to be forfeited) or the all-idle degrade; both are
 * genuinely maximum-attraction states.
 *
 * `now` is read from `opts.now` (a resolved epoch-ms number) when provided, else
 * `Date.now()`. Lives in `@hapi/protocol` (shared) so the server derives the
 * number from one source — no per-package drift, mirroring {@link computePlanLabel}.
 */
export function computeUtilizationScore(
  utilization: Utilization,
  opts?: ComputeUtilizationScoreOptions
): number {
  const num = (v: number | null | undefined): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  const fiveHourPct = num(utilization.five_hour?.utilization);
  const weeklyPct = num(utilization.seven_day?.utilization);

  // Hard-lock override (checked before pace): a 5-hour OR overall-weekly window
  // at/above 100% means the account is fully unusable on every model until that
  // window resets, so it must be the LEAST-attractive score, unconditionally.
  if (
    fiveHourPct >= HARD_LOCK_UTILIZATION ||
    weeklyPct >= HARD_LOCK_UTILIZATION
  ) {
    return 100;
  }

  const now = opts?.now ?? Date.now();
  const weeklyScore = windowPaceScore(
    weeklyPct,
    utilization.seven_day?.resets_at,
    WEEKLY_WINDOW_MS,
    WEEKLY_PACE_TARGET,
    WEEKLY_REFERENCE_BURN_PER_HOUR,
    now
  );
  const fiveHourScore = windowPaceScore(
    fiveHourPct,
    utilization.five_hour?.resets_at,
    FIVE_HOUR_WINDOW_MS,
    FIVE_HOUR_PACE_TARGET,
    FIVE_HOUR_REFERENCE_BURN_PER_HOUR,
    now
  );

  // Binding constraint (#3610 D1): an account is only as available as its TIGHTER window,
  // so the served score is the MAX of the paceable window scores (higher = less attractive).
  // Replaces the pre-#3610 "weekly headline + capped 5-hour penalty (≤ +20)", which let a
  // nearly-locked 5-hour window tie a cold account. When only one window is paceable this
  // reduces to that window alone (Degrade 1: weekly un-paceable → 5-hour alone, and vice
  // versa). Tie-breaking on the other window lives in the selectors, never here.
  const paceScores = [weeklyScore, fiveHourScore].filter(
    (s): s is number => s != null
  );
  if (paceScores.length > 0) return Math.round(Math.max(...paceScores));
  // Degrade 2: no usable reset on either window → plain fullness max, so raw utilization
  // still orders selection (D11: a hot 5-hour window is never masked to 0).
  return Math.round(Math.min(100, Math.max(fiveHourPct, weeklyPct)));
}
