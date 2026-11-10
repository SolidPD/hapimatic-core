// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Issue #6169 (epic #6163, Sub C2) — prompt-cache keep-warm for sessions idle on
// a person, an approval or a PM message.
//
// A session's prompt cache lives one hour from the START of the last request
// that read or wrote it, and a read renews it at no extra cost. After a longer
// wait the next turn rewrites the whole context at 20 to 80 times the read price
// (40 times on Opus 5.5). The
// keep-alive renews the cache while a large session waits, without putting
// anything into the conversation: the server decides when a session is eligible
// and calls the CLI RPC `cache-keepalive`; the CLI sends Claude Code's
// `side_question` SDK control request, a one-shot fork that reuses the main
// conversation's cache prefix, has no tools, writes nothing to the transcript and
// fires no hooks. The main agent never sees it.
//
// This module is the contract both runtimes share: the RPC method name, the
// marker, the defaults and ranges, the keepAlive cache-state field and the RPC
// request/response shapes.

/** The CLI RPC method the server calls (registered by the SDK remote launcher only). */
export const CACHE_KEEPALIVE_RPC_METHOD = "cache-keepalive";

/** Marks the side question as an automated keep-alive, never a user question. */
export const CACHE_KEEPALIVE_MARKER = "[hapi-cache-keepalive]";

/** The side question the CLI sends. The answer is discarded. */
export const CACHE_KEEPALIVE_QUESTION = `${CACHE_KEEPALIVE_MARKER} Automated prompt-cache keep-alive from Hapimatic. This is not a question from the user and needs no answer. Reply with: ok`;

/**
 * Defaults (research P7: a read-only replay of 31 days of ms1 transcripts).
 * `deadlineMinutes` is the latest a keep-alive may fire after the last cache
 * touch: past it the cache may have expired, and a read of an expired cache
 * writes the whole prefix.
 */
export const CACHE_KEEPALIVE_DEFAULTS = {
  enabled: true,
  contextThresholdTokens: 150_000,
  intervalMinutes: 50,
  deadlineMinutes: 55,
  capHours: 12,
  typingQuietMinutes: 3,
} as const;

/** Accepted ranges; a value outside its range falls through to the next layer. */
export const CACHE_KEEPALIVE_RANGES = {
  contextThresholdTokens: { min: 0, max: 2_000_000 },
  intervalMinutes: { min: 1, max: 55 },
  /** Also at least 2 minutes (two server ticks) after `intervalMinutes`. */
  deadlineMinutes: { min: 2, max: 59 },
  capHours: { min: 1, max: 48 },
  typingQuietMinutes: { min: 0, max: 30 },
} as const;

/**
 * The CLI's own ceiling, whatever the server asks: never send a keep-alive for a
 * cache last touched this long ago (1-hour TTL minus a minute of margin).
 */
export const CACHE_KEEPALIVE_MAX_AGE_MS = 59 * 60_000;

/** The TTL of the main conversation's most recent cache write. */
export const PROMPT_CACHE_TTLS = ["1h", "5m"] as const;
export type PromptCacheTtl = (typeof PROMPT_CACHE_TTLS)[number];

/**
 * The CLI-reported prompt-cache state, carried on the 2 s keepAlive tick (the
 * path `appliedEffort` uses, #6166). Only the SDK remote launcher reports it.
 *
 * - `touchedAt`: when the last request that touched the main cache STARTED (a
 *   pushed prompt, a self-started turn's `system/init`, a tool result's
 *   follow-up request, or a keep-alive), counted once that call's usage shows a
 *   cache read or write — the cache lifetime runs from a request's start.
 * - `ttl`: the TTL of the last main-conversation cache write (`null` = none yet).
 * - `idleSince`: when the last turn ended; `null` while a turn is pending.
 */
export const PromptCacheStateSchema = z
  .object({
    touchedAt: z.number(),
    ttl: z.enum(PROMPT_CACHE_TTLS).nullable(),
    idleSince: z.number().nullable(),
  })
  .passthrough();
export type PromptCacheState = z.infer<typeof PromptCacheStateSchema>;

/**
 * Server → CLI: the epoch ms after which the warm window is closed
 * (`touchedAt + deadlineMinutes`). Absolute, and still safe across clocks:
 * `touchedAt` is the CLI's own report, so the CLI compares `deadlineAt` against
 * the clock that produced it, and it also applies its own 59-minute ceiling.
 */
export const CacheKeepaliveRequestSchema = z.object({
  deadlineAt: z.number(),
});
export type CacheKeepaliveRequest = z.infer<typeof CacheKeepaliveRequestSchema>;

/** Why the CLI refused or failed a keep-alive. */
export const CACHE_KEEPALIVE_REFUSAL_CODES = [
  "no_active_query",
  "unsupported",
  "input_ended",
  "turn_in_flight",
  "in_flight",
  "no_turn_yet",
  "cache_ttl_not_1h",
  "model_changed",
  "tools_changed",
  "window_missed",
  "invalid_request",
  "side_question_failed",
] as const;
export type CacheKeepaliveRefusalCode =
  (typeof CACHE_KEEPALIVE_REFUSAL_CODES)[number];

export const CacheKeepaliveResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), latencyMs: z.number() }).passthrough(),
  z
    .object({
      ok: z.literal(false),
      code: z.enum(CACHE_KEEPALIVE_REFUSAL_CODES),
      error: z.string().optional(),
      cause: z.string().optional(),
    })
    .passthrough(),
]);
export type CacheKeepaliveResponse = z.infer<
  typeof CacheKeepaliveResponseSchema
>;

/** The A1 ledger outcome of one keep-alive attempt. */
export const CACHE_KEEPALIVE_OUTCOMES = ["sent", "refused", "failed"] as const;
export type CacheKeepaliveOutcome = (typeof CACHE_KEEPALIVE_OUTCOMES)[number];

/**
 * The TTL a `result` message's usage shows for the turn's cache writes, or
 * `null` when the turn wrote nothing (the caller keeps the previous value).
 * Any 1-hour write means the main conversation uses 1-hour caches.
 */
export function cacheTtlOfUsage(usage: unknown): PromptCacheTtl | null {
  if (!usage || typeof usage !== "object") return null;
  const creation = (usage as { cache_creation?: unknown }).cache_creation;
  if (!creation || typeof creation !== "object") return null;
  const oneHour = (creation as { ephemeral_1h_input_tokens?: unknown })
    .ephemeral_1h_input_tokens;
  const fiveMin = (creation as { ephemeral_5m_input_tokens?: unknown })
    .ephemeral_5m_input_tokens;
  if (typeof oneHour === "number" && oneHour > 0) return "1h";
  if (typeof fiveMin === "number" && fiveMin > 0) return "5m";
  return null;
}
