// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Quota-weighted token estimate (issue #4385, epic #4382 Sub C, R4).
 *
 * A raw token total treats every class alike, but the classes do not draw on a
 * plan's limit alike: a cache READ is far cheaper than fresh input and a cache
 * WRITE costs more. Weighting by the standard prompt-caching price ratios —
 * cache read ×0.1, cache write ×1.25, input and output ×1 — gives a figure that
 * tracks how heavily a session (including its background agents) drew on the
 * plan, which the raw total badly overstates when cache reads dominate.
 *
 * It is an ESTIMATE: Anthropic does not publish how subscription limits weigh
 * token classes, and output is not equal to input on price. Always label it an
 * estimate wherever it renders.
 */

/** Weight applied to cache-read tokens (prompt-caching read price ratio). */
export const CACHE_READ_WEIGHT = 0.1;
/** Weight applied to cache-write tokens (5-minute cache-write price ratio). */
export const CACHE_WRITE_WEIGHT = 1.25;

/** The four token classes, as the token-usage widget holds them. */
export interface QuotaTokenClasses {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A stored usage record's four classes (the token-stats `backgroundAgentUsage`
 *  block and its per-agent rows). */
export interface StoredTokenClasses {
  tokIn: number;
  tokOut: number;
  tokCacheRead: number;
  tokCacheWrite: number;
}

/**
 * The RAW (unweighted) sum of a stored record's four classes — the figure both
 * the Token Usage breakdown and the agents modal show for a background agent,
 * so the two can never disagree (#4385). Contrast `weightedQuotaTokens`.
 */
export function rawTokenTotal(u: StoredTokenClasses): number {
  return u.tokIn + u.tokOut + u.tokCacheRead + u.tokCacheWrite;
}

/**
 * `in + out + 0.1 × cacheRead + 1.25 × cacheWrite`, rounded to a whole token.
 * Non-finite or negative class values count as 0, so a partial or malformed
 * stats object never renders NaN.
 */
export function weightedQuotaTokens(classes: QuotaTokenClasses): number {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  return Math.round(
    n(classes.in) +
      n(classes.out) +
      CACHE_READ_WEIGHT * n(classes.cacheRead) +
      CACHE_WRITE_WEIGHT * n(classes.cacheWrite)
  );
}
