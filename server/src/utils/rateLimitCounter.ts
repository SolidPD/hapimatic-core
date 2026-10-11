// SPDX-License-Identifier: AGPL-3.0-only
// Issue #1141: rate-limit errorLogger to prevent Sentry/DB flooding.
//
// Pure in-memory fixed-window counter. No HTTP/Hono dependency — bucket
// keys are opaque strings supplied by the caller (e.g. ErrorLogger uses
// `category`). Time is injected via `getNow` so tests are deterministic
// without global Date.now mocking.
//
// Decision contract:
//   - "forward"   — under threshold, caller emits the event normally
//   - "summarize" — first overflow in the window; caller emits ONE summary
//                   entry, subsequent calls return "drop" until the window
//                   expires. droppedCount is always 1 at emit time (single-
//                   event signal, not cumulative — see test for rationale)
//   - "drop"      — over threshold and summary already emitted; caller
//                   discards the event (no console, DB, Sentry, push)
//
// Memory bound (R4): caller invokes pruneOlderThan(2 * windowMs) on each
// log call. Buckets older than that are guaranteed to be window-expired.

export interface RateLimitDecisionForward {
  action: "forward";
}
export interface RateLimitDecisionDrop {
  action: "drop";
}
export interface RateLimitDecisionSummarize {
  action: "summarize";
  droppedCount: number;
}
export type RateLimitDecision =
  | RateLimitDecisionForward
  | RateLimitDecisionDrop
  | RateLimitDecisionSummarize;

interface Bucket {
  count: number;
  windowStart: number;
  summarized: boolean;
}

export interface FixedWindowCounterOptions {
  limit: number;
  windowMs: number;
  /** Defaults to () => Date.now(). Inject for deterministic tests. */
  getNow?: () => number;
}

export class FixedWindowCounter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly getNow: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: FixedWindowCounterOptions) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.getNow = options.getNow ?? (() => Date.now());
  }

  /**
   * Decide whether to forward, drop, or summarize an event for `key`.
   * Side effect: mutates internal bucket state for `key`.
   */
  check(key: string): RateLimitDecision {
    const now = this.getNow();
    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.windowStart + this.windowMs) {
      // New key, or stale bucket — start a fresh window
      this.buckets.set(key, {
        count: 1,
        windowStart: now,
        summarized: false,
      });
      return { action: "forward" };
    }

    bucket.count++;

    if (bucket.count <= this.limit) {
      return { action: "forward" };
    }

    if (!bucket.summarized) {
      bucket.summarized = true;
      // First overflow: emit a summary representing the start of suppression.
      // droppedCount=1 is a deliberate design choice — it signals "at least
      // one event was suppressed to trigger this", not a cumulative total.
      // See rateLimitCounter.test.ts "design-rationale regression sanity check".
      return { action: "summarize", droppedCount: 1 };
    }

    return { action: "drop" };
  }

  /** Removes buckets whose windowStart is older than `maxAgeMs`. Returns count removed. */
  pruneOlderThan(maxAgeMs: number): number {
    const now = this.getNow();
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.windowStart > maxAgeMs) {
        this.buckets.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Number of tracked buckets. Exposed for test assertions and diagnostics. */
  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Helper for env-var parsing — mirrors the convention in
 * `server/src/web/middleware/rateLimit.ts`. Re-exported so callers (e.g.
 * `ErrorLogger`) can read their own env vars with the same null/empty/NaN
 * handling without copying the snippet.
 */
export function parseEnvInt(
  envValue: string | undefined,
  fallback: number
): number {
  if (envValue == null || envValue === "") return fallback;
  const parsed = parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
