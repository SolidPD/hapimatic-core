// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ACP usage detector (issue #3352, epic #3345 — Sub G).
 *
 * The non-claude analogue of `cli/src/claude/utils/contextUsageDetector.ts`: a
 * PURE extractor that reads token usage out of the two places an ACP agent
 * surfaces it, so the runner can feed `onContextUsage` (context window, R6) and
 * the per-turn stats pipeline (R5). It is pure (no session/emit coupling) so it
 * is unit-testable against fixture payloads (Task 7).
 *
 * ⚠️ Verified against gemini-cli 0.57.0 (pinned in each manifest's
 * `verifiedAgainst`). Two ASYMMETRIC channels — the directive's original
 * "usage rides a session/update" assumption is only half right:
 *
 *   1. **Context occupancy** rides a `session/update` of kind `usage_update`,
 *      carrying `{ size, used }` (size = context-window size, used = tokens
 *      occupied). → {@link acpContextFromSessionUpdate}.
 *   2. **Per-turn tokens** ride the `session/prompt` RESPONSE, under the ACP
 *      `_meta` extension escape hatch:
 *        `_meta.quota.token_count.{ input_tokens, output_tokens }`
 *        `_meta.quota.model_usage[].model`   (resolved model id, R8)
 *      There is NO cache-read/write split → those fields stay ABSENT (R4).
 *      → {@link acpUsageFromPromptResponse}.
 *
 * Both are defensively typed: an unrecognized shape (e.g. a future opencode
 * dialect) returns `null`, degrading honestly to a boundary-only turn row rather
 * than fabricating numbers.
 */

import { isObject } from "@/agent/utils";

export interface AcpContextUsage {
  contextWindowTokens: number;
  contextUsedTokens: number;
}

export interface AcpTurnUsage {
  tokIn?: number;
  tokOut?: number;
  /** Cache-read tokens, when the emission carries a split (opencode). */
  tokCacheRead?: number;
  /** Cache-write/creation tokens, when the emission carries a split (opencode). */
  tokCacheWrite?: number;
  /** Resolved model id from the emission (e.g. "gemini-2.5-pro"), if present. */
  modelId?: string;
}

/** Finite non-negative number, else null (rejects NaN/Infinity/negatives/non-number). */
function nonNegNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Extract context-window occupancy from an ACP `session/update` payload. Gemini
 * emits `sessionUpdate: "usage_update"` with `{ size, used }`. Returns null for
 * any other update kind, a malformed payload, or a non-positive window (R6
 * skip-on-unknown-window: no usable window → no context snapshot, exactly as the
 * claude `contextUsageDetector` returns when the window is undefined).
 */
export function acpContextFromSessionUpdate(
  update: unknown
): AcpContextUsage | null {
  if (!isObject(update)) return null;
  if (update.sessionUpdate !== "usage_update") return null;
  const size = nonNegNum(update.size);
  const used = nonNegNum(update.used);
  if (size === null || size <= 0 || used === null) return null;
  return { contextWindowTokens: size, contextUsedTokens: used };
}

/**
 * Extract per-turn token usage from an ACP `session/prompt` RESPONSE. Two
 * emission shapes are recognized (a runner uses one or the other):
 *
 *   - **Shape A — gemini 0.57.0**: `_meta.quota.token_count.{ input_tokens,
 *     output_tokens }` + `_meta.quota.model_usage[].model`. No cache split.
 *   - **Shape B — claude-style (opencode 1.17.11)**: a `usage` object with
 *     `{ input, output, cache_read_input, cache_creation_input }` (opencode's
 *     normalized shape) OR the Anthropic `{ input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens }` shape — carrying a
 *     FULL cache read/write split. Located defensively at `_meta.usage`,
 *     `_meta.quota.usage`, or a top-level `usage`.
 *
 * Returns null when no usage is present on any recognized path (the turn then
 * records a boundary-only row — V6). Emits ONLY the fields actually present
 * (R4 — an absent field is never a fabricated 0).
 */
export function acpUsageFromPromptResponse(
  response: unknown
): AcpTurnUsage | null {
  if (!isObject(response)) return null;
  const meta = isObject(response._meta) ? response._meta : undefined;
  const quota = meta && isObject(meta.quota) ? meta.quota : undefined;

  // Shape A — gemini `_meta.quota.token_count` + model_usage.
  if (quota) {
    const tc = isObject(quota.token_count) ? quota.token_count : undefined;
    const tokIn = tc ? nonNegNum(tc.input_tokens) : null;
    const tokOut = tc ? nonNegNum(tc.output_tokens) : null;
    let modelId: string | undefined;
    if (Array.isArray(quota.model_usage) && quota.model_usage.length > 0) {
      const first = quota.model_usage[0];
      if (isObject(first) && typeof first.model === "string" && first.model) {
        modelId = first.model;
      }
    }
    if (tokIn !== null || tokOut !== null || modelId !== undefined) {
      const out: AcpTurnUsage = {};
      if (tokIn !== null) out.tokIn = tokIn;
      if (tokOut !== null) out.tokOut = tokOut;
      if (modelId !== undefined) out.modelId = modelId;
      return out;
    }
  }

  // Shape B — a claude-style `usage` object (opencode). Try the likely carriers.
  const usageObj =
    (meta && isObject(meta.usage) ? meta.usage : undefined) ??
    (quota && isObject(quota.usage) ? quota.usage : undefined) ??
    (isObject(response.usage) ? response.usage : undefined);
  if (usageObj) {
    const claude = extractClaudeStyleUsage(usageObj);
    if (claude) return claude;
  }

  return null;
}

/**
 * Extract a claude-style usage object. Accepts both opencode's normalized field
 * names (`input`/`output`/`cache_read_input`/`cache_creation_input`) and the raw
 * Anthropic names (`*_tokens`). Returns null when no token field is present.
 */
function extractClaudeStyleUsage(
  usage: Record<string, unknown>
): AcpTurnUsage | null {
  const tokIn = nonNegNum(usage.input) ?? nonNegNum(usage.input_tokens);
  const tokOut = nonNegNum(usage.output) ?? nonNegNum(usage.output_tokens);
  const cacheRead =
    nonNegNum(usage.cache_read_input) ??
    nonNegNum(usage.cache_read_input_tokens);
  const cacheWrite =
    nonNegNum(usage.cache_creation_input) ??
    nonNegNum(usage.cache_creation_input_tokens);
  if (
    tokIn === null &&
    tokOut === null &&
    cacheRead === null &&
    cacheWrite === null
  ) {
    return null;
  }
  const out: AcpTurnUsage = {};
  if (tokIn !== null) out.tokIn = tokIn;
  if (tokOut !== null) out.tokOut = tokOut;
  if (cacheRead !== null) out.tokCacheRead = cacheRead;
  if (cacheWrite !== null) out.tokCacheWrite = cacheWrite;
  return out;
}
