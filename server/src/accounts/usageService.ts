// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  UtilizationSchema,
  computePlanLabel,
  computeUtilizationScore,
  isEnvTokenAccount,
  type AccountUsage,
  type StoredAccount,
  type Utilization,
} from "@hapi/protocol";
import type {
  AccountService,
  RedactedAccount,
} from "../services/accountService";
import { VERSION } from "../version.generated";

/**
 * Per-account usage-fetch service (epic #1855, Sub-Issue B / #1857).
 *
 * Fetches Anthropic usage for each locally-known account by calling the same
 * `GET /api/oauth/usage` endpoint Claude Code's own `/usage` screen reads, and
 * classifies each outcome into the `AccountUsage.status` enum. The OAuth bearer
 * token NEVER leaves the server — `refresh()`/`getLatest()` return ONLY the redacted
 * `AccountUsage` envelope (the `web/routes/accounts.ts` route additionally
 * `AccountUsageSchema.parse`s each row as the structural redaction guarantee).
 *
 * The `server` package may only depend on `@hapi/protocol` (it cannot import the
 * cli-side token-resolution code in `cli/src/`), so this service re-implements
 * the on-disk token reads — exactly as `AccountService` re-implements the store
 * file access. The 3-tier token resolution mirrors
 * `cli/src/claude/accountTokenInjection.ts`:
 *   1. machine-global isolated dir
 *      `${XDG_CONFIG_HOME:-~/.config}/hapimatic/account-configs/<uuid>/.credentials.json`
 *      (the live source for non-host accounts — native Claude Code rotates it),
 *      with the per-instance `<dataDir>/account-configs/<uuid>/...` as a
 *      kill-switch-layout fallback,
 *   2. the store record `<dataDir>/accounts/<uuid>.json` (via `AccountService`),
 *   3. the host `~/.claude/.credentials.json` (only when `uuid` is the
 *      host-default account — that file is NOT keyed by uuid).
 *
 * Read-only by design (#1857): an expired/unrefreshable token is classified
 * `expired` and the upstream call is skipped — NO token rotation on read. This
 * deliberately avoids the #1520 host-default and #1644 cross-machine token
 * races. Security: token values are NEVER logged or returned.
 */

/** Anthropic usage endpoint — validated live (HTTP 200 with the oauth-beta header). */
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Required for the OAuth-token usage endpoint (CC `constants/oauth.ts` OAUTH_BETA_HEADER). */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** The scope the usage endpoint requires; its absence yields an empty `{}` upstream. */
const PROFILE_SCOPE = "user:profile";
/** Per-account upstream fetch timeout (R8 — matches CC's `fetchUtilization`). */
const FETCH_TIMEOUT_MS = 5_000;
/**
 * Bounded 429 retry budget (#2608). A per-account HTTP 429 is retried with a
 * `Retry-After`-aware backoff up to `MAX_RATE_LIMIT_RETRIES` times, but the TOTAL
 * added wall-time is capped at `RATE_LIMIT_RETRY_BUDGET_MS` (measured from the
 * first 429) so one rate-limited account cannot stall the `Promise.all` batch
 * (KD-2). The interactive `GET /api/accounts/usage` path awaits the full batch
 * whenever the snapshot is stale, so every second of backoff is added admin-UI
 * latency — the budget is deliberately ~2× the single-fetch timeout. A 429 that
 * clears within the budget → `ok`; one that outlasts it → the transient,
 * preservable `rate_limited` status (never a loop-tripping throw — #2035).
 */
const MAX_RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_RETRY_BUDGET_MS = 2 * FETCH_TIMEOUT_MS;
/** Treat a token within this window of expiry as expired (mirrors CC's `isOAuthTokenExpired`). */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
/**
 * Re-arm a refresh when the cached snapshot is older than this (#1962). Default is
 * 3× the 2-min sampler interval (`DEFAULT_SAMPLER_INTERVAL_MS` in usageHistory.ts) =
 * 6 min — long enough that normal 2-min sampling never trips it (no #1909 regression),
 * short enough that a dead/stalled sampler self-corrects within ~one extra read cycle.
 * Env-overridable via `HAPI_USAGE_STALE_AFTER_MS` (wired in index.ts). Defined locally
 * (not imported from usageHistory.ts) to keep the two sibling modules decoupled.
 */
export const DEFAULT_USAGE_STALE_AFTER_MS = 6 * 60 * 1000;

/**
 * Preserve an account's last SUCCESSFUL (`ok`) usage snapshot across a TRANSIENT
 * upstream failure (5xx / timeout → `status:"error"`; a persistent 429 past the
 * retry budget → `status:"rate_limited"`, #2608) for up to this window, instead
 * of blanking the row to "Couldn't load usage." (Fallback Preservation Rule — a
 * single Anthropic 429 must not make an account vanish from the usage list). Bounded so a genuinely-stuck account still surfaces its error
 * once the last-good data ages past the window (measured from the ORIGINAL good
 * `fetchedAt`, carried forward each cycle so the clock never resets). Deliberately
 * does NOT apply to `expired` / `no_scope`: those are persistent, actionable
 * states (re-login / missing profile scope) whose message must be shown, not
 * masked by stale data. Env-overridable via `HAPI_USAGE_PRESERVE_STALE_MS`.
 */
export const DEFAULT_PRESERVE_STALE_MS = 15 * 60 * 1000;

/** Narrow `fetch` shape — a test double satisfies it without the full signature. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/**
 * Parse an HTTP `Retry-After` header into a delay in ms (#2608, KD-3). The header
 * is either a non-negative integer count of SECONDS (RFC 9110 delay-seconds) or an
 * HTTP-date; both forms are honored. A past HTTP-date clamps to 0. Returns null
 * when the header is absent or unparseable — the caller then falls back to
 * exponential backoff. The caller ALSO clamps the returned delay to the remaining
 * retry budget, so a large `Retry-After` can never sleep past it (never negative).
 */
export function parseRetryAfter(
  headerValue: string | null | undefined,
  nowMs: number
): number | null {
  if (headerValue == null) return null;
  const trimmed = headerValue.trim();
  if (trimmed === "") return null;
  // Numeric seconds form: a non-negative integer (RFC 9110 delay-seconds).
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // A malformed numeric (signed or decimal, e.g. "-3", "+3", "3.5") is NOT an
  // HTTP-date — reject it rather than let `Date.parse` accidentally read "-3" as
  // a year and clamp it to 0 (the caller then uses exponential backoff instead).
  if (/^[+-]?\d*\.?\d+$/.test(trimmed)) {
    return null;
  }
  // HTTP-date form (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, dateMs - nowMs);
}

/** A resolved access token plus the metadata needed for classification. */
interface ResolvedToken {
  accessToken: string;
  scopes: string[];
  /** Unix epoch ms, or null when unknown (env-token style — never expired). */
  expiresAt: number | null;
}

/** Shape of a `.credentials.json` `claudeAiOauth` slice (isolated dir + host file). */
interface ClaudeAiOauthFile {
  claudeAiOauth?: {
    accessToken?: string;
    scopes?: string[];
    expiresAt?: number;
  };
}

/** Shape of `~/.claude.json` (host-default identity only). */
interface HostConfigFile {
  oauthAccount?: { accountUuid?: string };
}

export interface UsageServiceOptions {
  /** Source of the account list + full records (token-bearing). */
  accountService: AccountService;
  /** `HAPI_HOME` data dir — roots the per-instance config-dir fallback. */
  dataDir: string;
  /** This node's federation label for the `machines` field; null falls back to `[]`. */
  nodeLabel?: string | null;
  /** Injectable fetch (test seam). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Clock seam (test seam). Defaults to `Date.now`. */
  now?: () => number;
  /** Machine-global isolated-config base (test seam). */
  accountConfigsDir?: string;
  /** Per-instance isolated-config base (kill-switch layout; test seam). */
  perInstanceConfigsDir?: string;
  /** Host credentials path (test seam). */
  hostCredentialsPath?: string;
  /** Host config path — source of the host-default uuid (test seam). */
  hostConfigPath?: string;
  /**
   * Resolves an account's user-set nickname for the `AccountUsage.nickname`
   * field. Injected (not imported) so the service stays decoupled from the
   * nickname store. Absent → `nickname` is left undefined.
   */
  nicknameLookup?: (uuid: string) => string | undefined;
  /**
   * Re-arm a refresh when the cached snapshot is older than this many ms (#1962).
   * Defaults to `DEFAULT_USAGE_STALE_AFTER_MS` (6 min). Test seam: pass a small
   * value to exercise the staleness guard deterministically with the injected `now`.
   */
  staleAfterMs?: number;
  /**
   * Preserve an account's last-good usage across a TRANSIENT `error` for up to
   * this many ms. Defaults to `DEFAULT_PRESERVE_STALE_MS` (15 min). Test seam:
   * pass a small value (with the injected `now`) to exercise the bound
   * deterministically.
   */
  preserveStaleMs?: number;
  /**
   * Async delay seam (test seam). Defaults to a `setTimeout`-based sleep.
   * Injected so the 429 retry backoff (#2608) is deterministically testable
   * without real wall-clock sleeps — a test passes a recorder that also advances
   * the injected `now`, making the retry budget an enforceable wall-time bound.
   */
  sleep?: (ms: number) => Promise<void>;
}

export class UsageService {
  private readonly accountService: AccountService;
  private readonly nodeLabel: string | null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly accountConfigsDir: string;
  private readonly perInstanceConfigsDir: string;
  private readonly hostCredentialsPath: string;
  private readonly hostConfigPath: string;
  private readonly nicknameLookup?: (uuid: string) => string | undefined;
  private readonly staleAfterMs: number;
  private readonly preserveStaleMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /**
   * The last full snapshot of every account's usage (push-to-cache model,
   * #1909). `null` until the first `refresh()` completes; after ANY refresh —
   * even one returning zero accounts — this holds an array, so an empty-account
   * node does not lazy-init-loop.
   */
  private latest: { value: AccountUsage[]; at: number } | null = null;
  /**
   * In-flight `refresh()` promise — coalesces concurrent cold reads into a
   * single upstream fetch (#1909 R2). Cleared in a `finally` when it settles.
   */
  private inflight: Promise<AccountUsage[]> | null = null;
  /**
   * #4736: bumped by `clearCache()`. A `refresh()` stores its snapshot only while
   * the generation it started under is still current.
   */
  private generation = 0;

  constructor(opts: UsageServiceOptions) {
    this.accountService = opts.accountService;
    this.nodeLabel = opts.nodeLabel ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    const xdgBase =
      process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
    this.accountConfigsDir =
      opts.accountConfigsDir ?? join(xdgBase, "hapimatic", "account-configs");
    this.perInstanceConfigsDir =
      opts.perInstanceConfigsDir ?? join(opts.dataDir, "account-configs");
    this.hostCredentialsPath =
      opts.hostCredentialsPath ??
      join(homedir(), ".claude", ".credentials.json");
    this.hostConfigPath =
      opts.hostConfigPath ?? join(homedir(), ".claude.json");
    this.nicknameLookup = opts.nicknameLookup;
    this.staleAfterMs = opts.staleAfterMs ?? DEFAULT_USAGE_STALE_AFTER_MS;
    this.preserveStaleMs = opts.preserveStaleMs ?? DEFAULT_PRESERVE_STALE_MS;
    this.sleep =
      opts.sleep ??
      (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  }

  /**
   * Drop the stored snapshot so the next read lazy-inits a fresh `refresh()`
   * (re-reading nicknames). Called after a nickname mutation so the change is
   * reflected on the next fetch rather than waiting for the next sampler tick
   * (#1909 — preserves the prior "nickname appears on next fetch" behavior).
   */
  clearCache(): void {
    // #4736: bump the generation so a refresh already in flight does not write its
    // (older) snapshot over this clear. (The `.finally()` identity check in
    // `refresh()` separately keeps it from clearing a newer in-flight promise.)
    this.generation += 1;
    this.latest = null;
    this.inflight = null;
  }

  /**
   * The last stored snapshot of every account's usage, or `null` if `refresh()`
   * has never completed (push-to-cache model, #1909). Synchronous — readers
   * call this and lazy-init `refresh()` only when it returns `null`. NEVER
   * triggers an upstream fetch itself.
   */
  getLatest(): AccountUsage[] | null {
    return this.latest?.value ?? null;
  }

  /**
   * Push-to-cache read with a staleness guard (#1962). Serves the cached snapshot
   * when it is fresh (younger than `staleAfterMs`); re-arms an upstream `refresh()`
   * when the snapshot is `null` (lazy-init — the unchanged #1909 fallback) OR older
   * than `staleAfterMs` (self-heals a frozen cache when the background `UsageSampler`
   * loop has silently stopped). This is a strict superset of `getLatest() ?? refresh()`:
   * it AUGMENTS the existing null-fallback with a staleness re-arm, never replaces it
   * (Fallback Preservation Rule). Refresh calls coalesce via the existing `inflight`
   * guard, so concurrent stale reads trigger exactly ONE upstream fetch (no thundering
   * herd). NEVER fetches when the snapshot is fresh AND still describes the store's
   * accounts — preserving the #1909 benefit that the 60s auto-poll reads the cache,
   * not the upstream.
   *
   * #4736 membership guard: a fresh snapshot whose Anthropic account set no longer
   * matches the store is re-fetched too. The store also changes OUTSIDE this process —
   * the daemon's boot seed writes the onboarding account 1–3 s after the server took
   * its first (empty) sample — so time alone cannot tell the cache is wrong. The guard
   * only runs on the fresh branch (the null/stale branches refresh anyway), compares
   * SETS from the same filter `refresh()` classifies, and serves the snapshot if the
   * store cannot be read, exactly as before.
   */
  async getCachedOrRefresh(): Promise<AccountUsage[]> {
    const snap = this.latest;
    if (snap && this.now() - snap.at < this.staleAfterMs) {
      if (this.snapshotMatchesStore(snap.value)) return snap.value;
      return this.refresh();
    }
    return this.refresh();
  }

  /**
   * The Anthropic accounts `refresh()` classifies (#3808 R7: `list()` spans providers;
   * an absent provider means Anthropic). Shared with the #4736 membership guard so the
   * two sides can never compute membership differently — a mismatch would refresh
   * upstream on every read.
   */
  private anthropicAccounts(): RedactedAccount[] {
    return this.accountService
      .list()
      .filter(a => (a.provider ?? "anthropic") === "anthropic");
  }

  /**
   * #4736: whether `rows` (a cached snapshot) covers exactly the store's current
   * Anthropic accounts. Set equality on `accountUuid`. A store read that throws
   * (`list()` rethrows non-ENOENT fs errors) counts as a match, so the fresh snapshot
   * is served as it was before the guard existed — never a new failure.
   */
  private snapshotMatchesStore(rows: readonly AccountUsage[]): boolean {
    let current: Set<string>;
    try {
      current = new Set(this.anthropicAccounts().map(a => a.accountUuid));
    } catch {
      return true;
    }
    const cached = new Set(rows.map(r => r.accountUuid));
    if (cached.size !== current.size) return false;
    for (const uuid of current) {
      if (!cached.has(uuid)) return false;
    }
    return true;
  }

  /**
   * Fetch every account's usage upstream and store the result as the latest
   * snapshot (#1909). The SOLE method that calls the Anthropic usage endpoint —
   * the background `UsageSampler` is its only scheduled caller; readers reach it
   * only via lazy-init (snapshot never populated) or the force path. Concurrent
   * calls coalesce into one in-flight fetch (R2). Per-account fetches run
   * concurrently; one account's failure NEVER fails the list (R6).
   */
  async refresh(): Promise<AccountUsage[]> {
    if (this.inflight) return this.inflight;
    // #4736: the generation this refresh belongs to. `clearCache()` bumps it, so a
    // refresh that was already running when the cache was cleared does not write its
    // older snapshot over the clear.
    const generation = this.generation;
    const run = async (): Promise<AccountUsage[]> => {
      // Snapshot the prior value BEFORE the fetch batch so a transient failure
      // this cycle can fall back to each account's last-good row (`this.latest`
      // is only reassigned at the end of this closure).
      const prev = this.latest?.value ?? null;
      // #3808 (R7): the usage poller classifies each account against the Anthropic
      // OAuth usage endpoint. `list()` now spans providers, so filter to Anthropic
      // BEFORE classify (absent provider ⇒ anthropic) — a codex/gemini record must
      // never be probed against api.anthropic.com. The per-provider usage signal is
      // #3809's `providerUsage[]` (D5 = C), out of scope here.
      const accounts = this.anthropicAccounts();
      const rows = await Promise.all(
        accounts.map(a => this.classify(a).catch(() => this.errorResult(a)))
      );
      const merged = this.preserveLastGoodAcrossTransientError(rows, prev);
      if (generation === this.generation) {
        this.latest = { value: merged, at: this.now() };
      }
      return merged;
    };
    // #4736: clear `inflight` in a `.finally()` callback, which always runs AFTER the
    // assignment below, and only if it still holds THIS promise. The previous inline
    // `finally` ran synchronously when `list()` threw before the first await — before
    // `inflight` was assigned — so the rejected promise stayed in `inflight` and every
    // later refresh returned it. The identity check also keeps a stale refresh from
    // clearing a newer in-flight promise after `clearCache()`.
    const pending: Promise<AccountUsage[]> = run().finally(() => {
      if (this.inflight === pending) this.inflight = null;
    });
    this.inflight = pending;
    return pending;
  }

  /**
   * Carry an account's last SUCCESSFUL (`ok`) usage forward across a TRANSIENT
   * failure so one unlucky sample does not blank the row (Fallback Preservation
   * Rule). Two transient statuses are preserved, with a deliberate difference:
   *  - `error` (5xx / timeout) → coerce the merged row to `ok`, carrying the
   *    prior meters + score, so it reads as healthy (#2607).
   *  - `rate_limited` (persistent 429 past the retry budget, #2608) → carry the
   *    prior meters but KEEP `status:"rate_limited"` so the card shows meters +
   *    the "temporarily rate-limited" flag (KD-1). `score` is NOT carried — it
   *    stays `null` on every `rate_limited` row (ruling D5), preserving the
   *    "numeric score ⟺ status `ok`" invariant `buildUsage` stamps.
   * A prior `rate_limited` row (with meters) is ALSO eligible as the carried
   * source (ruling D4), so the meters survive across CONSECUTIVE 429 cycles
   * instead of blanking after one; the carried ORIGINAL `fetchedAt` still ages
   * the chain out at `preserveStaleMs`, measured from the last-good sample
   * (carried forward each cycle so a long burst never resets the clock).
   * `expired` / `no_scope` are NEVER preserved — those are persistent, actionable
   * states whose message must show. Identity/display fields stay FRESH (from the
   * current row); only the usage-bearing fields and the last-good `fetchedAt` are
   * carried, so the UI's "updated N ago" honestly signals staleness. The result
   * is still a valid `AccountUsage` (every field comes from an already-
   * `AccountUsageSchema`-shaped row), so the route's output-redaction parse is
   * unaffected.
   */
  private preserveLastGoodAcrossTransientError(
    rows: AccountUsage[],
    prev: AccountUsage[] | null
  ): AccountUsage[] {
    if (!prev) return rows;
    return rows.map(row => {
      if (row.status !== "error" && row.status !== "rate_limited") return row;
      const prior = prev.find(p => p.accountUuid === row.accountUuid);
      if (
        !prior ||
        // Prior must carry usable meters: a fresh `ok` sample, OR a preserved
        // `rate_limited` row (ruling D4 — keeps meters across consecutive 429
        // cycles). Its `utilization == null` and staleness are checked below.
        (prior.status !== "ok" && prior.status !== "rate_limited") ||
        prior.utilization == null ||
        this.now() - prior.fetchedAt > this.preserveStaleMs
      ) {
        return row;
      }
      if (row.status === "rate_limited") {
        // KEEP the transient flag (KD-1); score stays null (D5).
        return {
          ...row, // fresh displayLabel / email / nickname / planLabel / machines
          status: "rate_limited",
          utilization: prior.utilization,
          score: null,
          fetchedAt: prior.fetchedAt, // last-good timestamp → staleness visible
        };
      }
      return {
        ...row, // fresh displayLabel / email / nickname / planLabel / machines
        status: "ok", // #2607: an `error` row reads as healthy last-good
        utilization: prior.utilization,
        score: prior.score,
        fetchedAt: prior.fetchedAt, // last-good timestamp → staleness stays visible
      };
    });
  }

  /** The classification state machine (mirrors CC's `fetchUtilization`). */
  private async classify(account: RedactedAccount): Promise<AccountUsage> {
    const uuid = account.accountUuid;
    const rec = this.accountService.getRaw(uuid);
    const token = this.resolveToken(uuid, rec);

    // Cannot resolve any token → error (nothing to call the endpoint with).
    if (!token) {
      return this.buildUsage(account, "error", {});
    }

    // #4736: an env-token account (the onboarding setup-token the daemon seeds on a
    // provisioned VM) is `user:inference`-scoped, so it can never read the usage
    // endpoint — `no_scope`, decided by KIND without a call. It must not reach the
    // expiry arm below: its `expiresAt: 0` is the seed's "no known expiry" sentinel
    // (cli/src/accounts/seedFromEnvToken.ts), which `isExpired` reads as long past,
    // and env-token accounts are never refreshed, so the card stuck at "Refreshing
    // sign-in…" forever. Same kind-based exemption as the spawn gate
    // (syncEngine.ts) and accountTokenInjection.ts.
    if (rec && isEnvTokenAccount(rec)) {
      return this.buildUsage(account, "no_scope", {});
    }

    // near-expiry — a token within the expiry buffer skips the call, NO rotation.
    // #3544: the sticky `unrefreshable` flag is NO LONGER an `expired` signal
    // here. It is per-instance store state, but the isolated token it describes
    // is machine-global, so a stale flag can sit in THIS instance's store while a
    // sibling reads the SAME token as healthy. When a token is resolved and
    // unexpired, fall THROUGH to the live probe below (401/403 → expired at the
    // `:345-347` arm; 200 → ok) — never report `ok` without the probe confirming.
    // A genuinely dead account still reads `expired` via that live 401/403, and an
    // unresolvable token already returned `error` above (out of scope, R2).
    //
    // #2281 (landed AFTER #3544, ON TOP of the reorder above — the probe block is
    // untouched): split the `"expired"` literal into a `refreshing` ternary. A
    // near-expiry REFRESHABLE account is transient — the daemon backstop
    // (tokenRefreshService.refreshIdleIsolatedAccounts, same 5-min gate) rotates
    // it within ~60s — so it reads `refreshing` (benign, self-healing, NOT
    // user-actionable). Only an `unrefreshable` account (which that backstop SKIPS
    // — `tokenRefreshService.ts` `if (account.unrefreshable) continue;`) reads
    // `expired` here: a human must re-login. This is the one place the sticky flag
    // is still consulted, and correctly so — the call is already skipped (probing
    // a clock-expired token would only 401), so there is no live signal to prefer.
    if (this.isExpired(token.expiresAt)) {
      return this.buildUsage(
        account,
        rec?.unrefreshable === true ? "expired" : "refreshing",
        {}
      );
    }

    // no_scope pre-check (R4) — a token whose scopes lack user:profile would get
    // an empty {} from upstream anyway; skip the call.
    if (token.scopes.length > 0 && !token.scopes.includes(PROFILE_SCOPE)) {
      return this.buildUsage(account, "no_scope", {});
    }

    // Live fetch (R5/R6). A 429 is retried with a bounded, Retry-After-aware
    // backoff (#2608, KD-2/KD-3): up to MAX_RATE_LIMIT_RETRIES retries, TOTAL
    // added wall-time capped at RATE_LIMIT_RETRY_BUDGET_MS (measured from the
    // first 429 via `retryDeadline`). A retry that clears → the normal ok /
    // no_scope path; a 429 that outlasts the budget → the transient, preservable
    // `rate_limited` status (NOT `error`). 401/403 → expired and thrown/timeout →
    // error are unchanged, and expired/no_scope are decided BEFORE the fetch
    // (above) so they are never retried (R5). The whole loop stays inside this
    // per-account try/catch, so a 429 never throws out of the sampler tick and
    // cannot trip #2035's SupervisedLoop failure counter — a bounded retry ending
    // in `rate_limited` is a HANDLED outcome, not a loop failure.
    const requestInit = {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "Content-Type": "application/json",
        "User-Agent": `claude-code/${VERSION}`,
      },
    } as const;
    // Absolute wall-clock deadline for the retry phase — set lazily on the first
    // 429 so the initial fetch is NOT charged against the added-time budget.
    let retryDeadline: number | null = null;
    try {
      for (let attempt = 0; ; attempt++) {
        const res = await this.fetchImpl(OAUTH_USAGE_URL, {
          ...requestInit,
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        // A rejected token reads as expired (live-probed: invalid token → 401).
        if (res.status === 401 || res.status === 403) {
          return this.buildUsage(account, "expired", {});
        }

        // Rate-limited → bounded Retry-After backoff (#2608). Retry only while
        // BOTH the attempt count and the wall-time budget allow; otherwise
        // surface the transient, preservable `rate_limited` status.
        if (res.status === 429) {
          if (retryDeadline === null) {
            retryDeadline = this.now() + RATE_LIMIT_RETRY_BUDGET_MS;
          }
          const remaining = retryDeadline - this.now();
          if (attempt >= MAX_RATE_LIMIT_RETRIES || remaining <= 0) {
            return this.buildUsage(account, "rate_limited", {});
          }
          // Prefer the server's Retry-After; else exponential backoff (1s, 2s…).
          // Clamp the sleep to the remaining budget so we never sleep past it.
          const retryAfter = parseRetryAfter(
            res.headers.get("retry-after"),
            this.now()
          );
          const backoff = retryAfter ?? 1000 * 2 ** attempt;
          await this.sleep(Math.max(0, Math.min(backoff, remaining)));
          continue;
        }

        if (!res.ok) {
          return this.buildUsage(account, "error", {});
        }

        const data: unknown = await res.json();
        // Empty object ⇒ token lacks the profile scope (no_scope) per CC semantics.
        if (this.isEmptyObject(data)) {
          return this.buildUsage(account, "no_scope", {});
        }

        // passthrough schema — preserves the live superset fields, never throws on
        // unknown keys (validated against the live response during research).
        const utilization = UtilizationSchema.parse(data);
        return this.buildUsage(account, "ok", utilization);
      }
    } catch {
      // Network failure, timeout (AbortError), or malformed JSON → error.
      // Never log the token value.
      return this.buildUsage(account, "error", {});
    }
  }

  /**
   * Resolve the access token to use for this account, by priority (R2):
   * isolated dir → store record → host credentials (host-default only).
   */
  private resolveToken(
    uuid: string,
    rec: StoredAccount | null
  ): ResolvedToken | null {
    // Tier 1: machine-global isolated dir, then the per-instance fallback layout.
    for (const base of [this.accountConfigsDir, this.perInstanceConfigsDir]) {
      const isolated = this.readClaudeAiOauth(
        join(base, uuid, ".credentials.json")
      );
      if (isolated) return isolated;
    }

    // Tier 2: store record (advisory cache for isolated accounts; the synced
    // record for the host-default; the Hapimatic-refreshed token otherwise).
    if (rec?.accessToken) {
      return {
        accessToken: rec.accessToken,
        scopes: rec.scopes ?? [],
        expiresAt: rec.expiresAt ?? null,
      };
    }

    // Tier 3: host credentials — only meaningful when this IS the host-default
    // account (the host file is not keyed by uuid; the uuid lives in ~/.claude.json).
    if (uuid === this.readHostDefaultAccountUuid()) {
      const host = this.readClaudeAiOauth(this.hostCredentialsPath);
      if (host) return host;
    }

    return null;
  }

  /** Read + parse a `claudeAiOauth` credentials file; null on any failure. */
  private readClaudeAiOauth(path: string): ResolvedToken | null {
    try {
      const parsed = JSON.parse(
        readFileSync(path, "utf-8")
      ) as ClaudeAiOauthFile;
      const oauth = parsed.claudeAiOauth;
      if (!oauth?.accessToken) return null;
      return {
        accessToken: oauth.accessToken,
        scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
        expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
      };
    } catch {
      return null;
    }
  }

  /** The host-default account uuid from `~/.claude.json`; null on any failure. */
  private readHostDefaultAccountUuid(): string | null {
    try {
      const parsed = JSON.parse(
        readFileSync(this.hostConfigPath, "utf-8")
      ) as HostConfigFile;
      return parsed.oauthAccount?.accountUuid ?? null;
    } catch {
      return null;
    }
  }

  /** True when the token is at/within the expiry buffer (mirrors CC). */
  private isExpired(expiresAt: number | null): boolean {
    if (expiresAt === null) return false;
    return this.now() >= expiresAt - EXPIRY_BUFFER_MS;
  }

  /** True for a non-null, non-array object with no own keys (`{}`). */
  private isEmptyObject(data: unknown): boolean {
    return (
      typeof data === "object" &&
      data !== null &&
      !Array.isArray(data) &&
      Object.keys(data as Record<string, unknown>).length === 0
    );
  }

  /**
   * Build the redacted `AccountUsage` envelope FIELD-BY-FIELD (never a spread of
   * `StoredAccount`) — the structural redaction guarantee (R1). A token value
   * cannot reach this object because only display-safe fields are assigned.
   */
  private buildUsage(
    account: RedactedAccount,
    status: AccountUsage["status"],
    utilization: Utilization
  ): AccountUsage {
    return {
      accountUuid: account.accountUuid,
      displayLabel: account.displayName || account.emailAddress,
      email: account.emailAddress,
      nickname: this.nicknameLookup?.(account.accountUuid),
      planLabel: computePlanLabel(
        account.subscriptionType,
        account.rateLimitTier
      ),
      machines: this.nodeLabel ? [this.nodeLabel] : [],
      utilization,
      status,
      // Pacing score (epic #2038, #2039; sustainable-rate redesign 2026-07-20): a
      // number for "ok", null for degraded statuses. Set explicitly to null rather
      // than relying on computeUtilizationScore({}) === 0 — a degraded account must
      // read as "no score", not "maximally attractive".
      score:
        status === "ok"
          ? computeUtilizationScore(utilization, { now: this.now() })
          : null,
      fetchedAt: this.now(),
    };
  }

  /** Belt-and-suspenders error envelope for a thrown `fetchOne`. */
  private errorResult(account: RedactedAccount): AccountUsage {
    return this.buildUsage(account, "error", {});
  }
}
