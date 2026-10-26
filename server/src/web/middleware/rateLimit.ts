// SPDX-License-Identifier: AGPL-3.0-only
import type { Context, MiddlewareHandler } from "hono";
import type { WebAppEnv } from "./auth";

function parseEnvInt(envValue: string | undefined, fallback: number): number {
  if (envValue == null || envValue === "") return fallback;
  const parsed = parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const DEFAULT_LIMIT = parseEnvInt(process.env.HAPI_RATE_LIMIT_DEFAULT, 100);
const DEFAULT_WINDOW_MS = parseEnvInt(
  process.env.HAPI_RATE_LIMIT_WINDOW_MS,
  60_000
);
const DEFAULT_MAX_KEYS = parseEnvInt(
  process.env.HAPI_RATE_LIMIT_MAX_KEYS,
  10_000
);

const PRUNE_EVERY = 100;

export interface RateLimitOptions {
  name: string;
  limit?: number;
  windowMs?: number;
  /** Most buckets the limiter keeps; the oldest window is evicted past it (#5228). */
  maxKeys?: number;
  keyFn?: (c: Context<WebAppEnv>) => string;
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

export function createRateLimiter(
  options: RateLimitOptions
): MiddlewareHandler<WebAppEnv> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const keyFn =
    options.keyFn ?? (c => (c.get("namespace") ?? "anonymous") as string);

  const buckets = new Map<string, BucketEntry>();
  let requestCounter = 0;

  function maybePrune(): void {
    requestCounter++;
    if (requestCounter < PRUNE_EVERY) return;
    requestCounter = 0;

    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now > entry.resetAt) {
        buckets.delete(key);
      }
    }
  }

  return async (c, next) => {
    maybePrune();

    const key = keyFn(c);
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || now > entry.resetAt) {
      // #5228: a client cycling source addresses adds a bucket per address, so
      // the map is capped. A key is re-inserted on every window reset, so Map
      // order is window-start order and the first key is the oldest window.
      // Evicting it, rather than refusing new keys, never locks a new client out.
      buckets.delete(key);
      while (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      await next();
      return;
    }

    if (entry.count >= limit) {
      const secondsUntilReset = Math.max(
        1,
        Math.ceil((entry.resetAt - now) / 1000)
      );
      c.header("Retry-After", String(secondsUntilReset));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    entry.count++;
    await next();
    return;
  };
}
