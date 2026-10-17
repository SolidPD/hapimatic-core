// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Daemon-side utilization sampler for the un-pinned spawn veto (issue #3023).
 *
 * There is NO usage/utilization client anywhere else in `cli/src` (grep-confirmed): the
 * account store carries `subscriptionType` / `rateLimitTier` only, and utilization lives
 * behind the server/gateway usage API. So the daemon needs its own read-only source at
 * spawn time. Per the directive's Key Decision (option b), the `TokenRefreshService`
 * tick refreshes a cached utilization snapshot per account here (the daemon already runs
 * that loop), and the veto reads the cache — no spawn-time network dependency.
 *
 * This mirrors `server/src/accounts/usageService.ts`'s fetch (the SAME `OAUTH_USAGE_URL`
 * + `oauth-2025-04-20` beta header) and reuses the SHARED `computeUtilizationScore`
 * (`shared/src/usage.ts`) — never a re-derived threshold. It emits a COARSE status
 * classification sufficient for the veto's STATUS-first decision (see
 * `selectHealthyAccount.ts`): `ok` (parseable utilization → a numeric score),
 * `rate_limited` (persistent 429 → the account an un-pinned spawn should MOST avoid),
 * `terminal` (401/403 → credential-dead), or `unknown` (timeout / 5xx / empty / malformed
 * → undetermined, pass through). The score is a number ONLY for `ok`.
 *
 * Every path is fail-safe: a fetch/parse error NEVER throws into the token-refresh tick;
 * it records an `unknown` snapshot and moves on.
 */

import {
  UtilizationSchema,
  computeUtilizationScore,
} from "@hapi/protocol/usage";
import type { AccountIndexEntry } from "@hapi/protocol/accounts";
import { logger } from "@/ui/logger";
import {
  ANTHROPIC_OAUTH_USAGE_URL,
  isTenantVm,
} from "@hapi/protocol/tenantMode";
import type {
  UtilizationSnapshot,
  UtilizationStatus,
} from "@/accounts/selectHealthyAccount";

/** Anthropic usage endpoint — same URL `usageService` validated live. */
const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/**
 * Resolve the usage endpoint. Defaults to the live Anthropic URL; overridable via
 * `HAPI_UTILIZATION_ENDPOINT` for a proxied/gateway deployment OR to point the daemon
 * sampler at a local mock during a controlled capacity/veto exercise (read at fetch
 * time so the override is honored without a rebuild).
 */
function usageEndpoint(): string {
  // Issue #4349 (ruling D10): on a TENANT VM the endpoint is PINNED to api.anthropic.com — an
  // override would send the customer's credential somewhere else.
  if (isTenantVm()) return ANTHROPIC_OAUTH_USAGE_URL;
  const override = process.env.HAPI_UTILIZATION_ENDPOINT;
  return override && override.length > 0 ? override : OAUTH_USAGE_URL;
}
/** Required beta header for the OAuth-token usage endpoint (mirrors `usageService`). */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** Per-account upstream fetch timeout (matches `usageService`'s `FETCH_TIMEOUT_MS`). */
const FETCH_TIMEOUT_MS = 5_000;
/**
 * Minimum interval between re-sampling the SAME account. The token-refresh tick can fire
 * as often as its `minTickMs`, but the usage endpoint is already polled by the server's
 * sampler; this throttle bounds the daemon's added upstream load to ~1 fetch/account/90s
 * regardless of tick cadence. A snapshot younger than this is left untouched.
 */
const SAMPLE_INTERVAL_MS = 90_000;
/** Cosmetic User-Agent (the endpoint gates on the beta header + token, not the UA). */
const SAMPLE_USER_AGENT = "claude-code/1.0";

/** Narrow `fetch` shape — a test double satisfies it without the full signature. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

/** Reads an account's access token by UUID (the daemon injects a store-backed reader). */
export type AccessTokenReader = (accountUuid: string) => Promise<string | null>;

/** The status + score half of a snapshot (what one fetch determines). */
export interface UtilizationOutcome {
  status: UtilizationStatus;
  score: number | null;
  /**
   * Raw 5-hour / weekly window utilizations (0–100) from the SAME parsed usage the
   * score is computed from — carried for the #3611 optimal-pick tie-break (R9).
   * Populated only on `ok`; `null` for every degraded status (no usable windows).
   */
  fiveHourUtilization?: number | null;
  sevenDayUtilization?: number | null;
}

export interface UtilizationSamplerDeps {
  /** Resolve an account's access token (store record → `accessToken`). */
  readAccessToken: AccessTokenReader;
  /** Write a computed snapshot into the veto's cache (`accountStore.setUtilizationSnapshot`). */
  writeSnapshot: (accountUuid: string, snapshot: UtilizationSnapshot) => void;
  /** Read the current snapshot for the per-account throttle. */
  readSnapshot: (accountUuid: string) => UtilizationSnapshot | undefined;
  /** Injectable fetch (test seam). Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Clock seam (test seam). Defaults to `Date.now`. */
  now?: () => number;
  /** Per-account re-sample throttle (test seam). Defaults to {@link SAMPLE_INTERVAL_MS}. */
  sampleIntervalMs?: number;
}

/**
 * Fetch one account's utilization and classify the outcome (status + score). NEVER throws.
 * The access token value is never logged.
 *
 *   - HTTP 401/403          → `{ status: "terminal", score: null }` (credential-dead)
 *   - HTTP 429              → `{ status: "rate_limited", score: null }` (persistent throttle)
 *   - other non-OK (5xx …)  → `{ status: "unknown", score: null }`
 *   - empty `{}` (no scope) → `{ status: "unknown", score: null }`
 *   - malformed body        → `{ status: "unknown", score: null }`
 *   - parseable utilization → `{ status: "ok", score: <computeUtilizationScore> }`
 *   - network / timeout     → `{ status: "unknown", score: null }`
 */
export async function sampleAccountUtilization(
  accessToken: string,
  fetchImpl: FetchLike,
  now: () => number
): Promise<UtilizationOutcome> {
  try {
    const res = await fetchImpl(usageEndpoint(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
        "Content-Type": "application/json",
        "User-Agent": SAMPLE_USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // A rejected token → credential-dead (terminal); the veto refuses to auto-pick it.
    if (res.status === 401 || res.status === 403) {
      return { status: "terminal", score: null };
    }
    // A persistent 429 → the account is being throttled; the veto DEPRIORITISES it (the
    // account an un-pinned spawn should most avoid). Distinct from a generic non-OK.
    if (res.status === 429) {
      return { status: "rate_limited", score: null };
    }
    // Any other non-OK (5xx, unexpected) → undetermined. Do NOT veto on it.
    if (!res.ok) return { status: "unknown", score: null };
    const data: unknown = await res.json();
    // An empty object ⇒ the token lacks the profile scope (no usable utilization) → unknown.
    if (
      data === null ||
      typeof data !== "object" ||
      Object.keys(data as object).length === 0
    ) {
      return { status: "unknown", score: null };
    }
    const parsed = UtilizationSchema.safeParse(data);
    if (!parsed.success) return { status: "unknown", score: null };
    return {
      status: "ok",
      score: computeUtilizationScore(parsed.data, { now: now() }),
      // #3611: stash the raw window utilizations from the SAME parsed usage for the
      // optimal-pick tie-break (R9). `?? null` so an absent window is "no signal".
      fiveHourUtilization: parsed.data.five_hour?.utilization ?? null,
      sevenDayUtilization: parsed.data.seven_day?.utilization ?? null,
    };
  } catch {
    // Network failure, timeout (AbortError), or malformed JSON → undetermined. Never log
    // the token value.
    return { status: "unknown", score: null };
  }
}

/**
 * Sample utilization for every supplied account and refresh the veto's cache. Best-effort
 * and fully parallel: a slow/failed account never blocks the others, and nothing throws.
 * Per-account throttled by {@link SAMPLE_INTERVAL_MS} so frequent ticks do not hammer the
 * usage endpoint. This is the callback the `TokenRefreshService` invokes at its tick
 * loop-top (covering EVERY account, including the host-default the refresh loop defers).
 */
export async function sampleUtilizationForAccounts(
  entries: readonly AccountIndexEntry[],
  deps: UtilizationSamplerDeps
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike);
  const now = deps.now ?? Date.now;
  const sampleIntervalMs = deps.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
  const nowMs = now();

  // #3808 (R7): defence-in-depth — the OAUTH_USAGE_URL is the Anthropic usage
  // endpoint. NEVER sample a non-Anthropic record against it. Callers already
  // filter, but a provider record must never reach the fetch. (absent ⇒ anthropic)
  const anthropicEntries = entries.filter(
    e => (e.provider ?? "anthropic") === "anthropic"
  );

  await Promise.allSettled(
    anthropicEntries.map(async entry => {
      const uuid = entry.accountUuid;
      // Throttle: skip accounts sampled within the interval.
      const existing = deps.readSnapshot(uuid);
      if (existing && nowMs - existing.fetchedAt < sampleIntervalMs) return;

      let outcome: UtilizationOutcome = { status: "unknown", score: null };
      try {
        const token = await deps.readAccessToken(uuid);
        if (token) {
          outcome = await sampleAccountUtilization(token, fetchImpl, now);
        }
        // A missing token → cannot fetch → unknown (never veto on a store miss).
      } catch (err) {
        // readAccessToken should never throw, but stay fail-safe regardless.
        logger.debug(
          `[UTILIZATION_SAMPLER] ${uuid}: token read failed (${err instanceof Error ? err.message : String(err)}) — recording unknown`
        );
        outcome = { status: "unknown", score: null };
      }
      deps.writeSnapshot(uuid, {
        status: outcome.status,
        score: outcome.score,
        fetchedAt: now(),
        emailAddress: entry.emailAddress,
        // #3611: carry the raw windows (present only for `ok`) for the R9 tie-break.
        fiveHourUtilization: outcome.fiveHourUtilization,
        sevenDayUtilization: outcome.sevenDayUtilization,
      });
    })
  );
}

/**
 * Bind {@link sampleUtilizationForAccounts} to a set of deps, producing the
 * `(entries) => Promise<void>` callback the `TokenRefreshService` accepts as its
 * `sampleUtilization` seam. Wraps the whole pass so it can NEVER reject into the tick.
 */
export function createUtilizationSampler(
  deps: UtilizationSamplerDeps
): (entries: readonly AccountIndexEntry[]) => Promise<void> {
  return async entries => {
    try {
      await sampleUtilizationForAccounts(entries, deps);
    } catch (err) {
      logger.warn(
        `[UTILIZATION_SAMPLER] pass error (swallowed — never breaks the refresh tick): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
}
