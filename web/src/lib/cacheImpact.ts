// SPDX-License-Identifier: AGPL-3.0-only
import { resolveModelPricing } from "@hapi/protocol/pricing";

/**
 * Issue #2149 (R8) — prompt-cache-impact estimator for the Edit-session-params
 * modal.
 *
 * Keys the warning off **which parameters changed**, not off whether a relaunch
 * will occur: a live MCP toggle busts the prompt cache with no respawn, while a
 * launcher/safe-mode relaunch that changes nothing prompt-relevant only cold-pays
 * the cache once. The number is a **heuristic** — Hapimatic cannot observe
 * Anthropic's actual pre-hoc cache decision — so callers must label it as such.
 *
 * Reuses the pricing source of truth (`resolveModelPricing`, `@hapi/protocol/pricing`)
 * that `costEstimate.ts` reads, and the same `cacheWrite5mPerMTok`/`cacheReadPerMTok`
 * fields, so the estimate can never drift from the live cost widget.
 */

/** The launch parameters the Edit-session-params modal can change. */
export type EditableField =
  | "modelMode"
  | "rawModel"
  | "effort"
  | "permissionMode"
  | "mcp"
  | "launcher"
  | "safeMode"
  | "outputStyle"
  | "sessionRole"
  /** Epic #3285 round 14 (item 7): the staged per-session account switch. */
  | "account";

/**
 * Fields that invalidate the prompt cache when changed (heuristic). Only `effort`
 * is prompt-neutral — it tunes reasoning depth without changing the system prompt
 * or the resolved model's cache namespace. Everything else either changes the
 * model (`modelMode`/`rawModel`), the system prompt (`mcp` tool list,
 * `outputStyle`, `permissionMode` reminder block), or forces a fresh spawn
 * (`launcher`/`safeMode`/`sessionRole`), all of which drop the warm cache.
 */
const CACHE_BUSTING: Record<EditableField, boolean> = {
  modelMode: true,
  rawModel: true,
  mcp: true,
  outputStyle: true,
  permissionMode: true,
  launcher: true,
  safeMode: true,
  sessionRole: true,
  // A different account is a different org / cache namespace AND the switch
  // restarts the session (round 14) — the warm cache is gone either way.
  account: true,
  effort: false,
};

/**
 * Spawn-frozen fields with no live-mutation plane — changing one requires a
 * teardown + `--resume` relaunch, and the resumed session cold-writes its whole
 * context cache on the first post-relaunch turn.
 */
const FORCES_RELAUNCH: ReadonlySet<EditableField> = new Set<EditableField>([
  "launcher",
  "safeMode",
  "outputStyle",
  "sessionRole",
  "account",
]);

export type CacheImpact = {
  /** True when at least one changed field invalidates the warm prompt cache. */
  bustsCache: boolean;
  /** Tokens the next turn must re-write to the cache (≈ the current context). */
  estimatedTokens: number;
  /** USD delta of that re-write vs a cache read. `null` when the model is unknown. */
  estimatedUsd: number | null;
  /** Human-readable, explicitly-heuristic explanation. */
  reason: string;
  /** Always `true` — this is an estimate, not an observed cache decision. */
  isHeuristic: true;
};

/**
 * Estimate the prompt-cache impact of an edit.
 *
 * @param changedFields the set of fields the user changed in the modal
 * @param contextUsedTokens the session's current context size (tokens)
 * @param model the resolved model string (or model-mode) for pricing; `undefined`
 *   ⇒ USD is reported as `null` (the UI renders "—")
 */
export function estimateCacheImpact(args: {
  changedFields: ReadonlySet<EditableField>;
  contextUsedTokens: number;
  model: string | undefined;
}): CacheImpact {
  const { changedFields, contextUsedTokens, model } = args;
  const busting = [...changedFields].filter(f => CACHE_BUSTING[f]);

  if (busting.length === 0) {
    return {
      bustsCache: false,
      estimatedTokens: 0,
      estimatedUsd: 0,
      reason:
        changedFields.size === 0
          ? "No changes to apply."
          : "The changed parameter(s) keep the prompt cache warm — no extra cost.",
      isHeuristic: true,
    };
  }

  const estimatedTokens = Math.max(0, Math.round(contextUsedTokens));
  const pricing = resolveModelPricing(model);
  // Issue #3353 (3353-2): the cache-bust delta needs BOTH a cache-write and a
  // cache-read rate. A provider without a per-token cache-write fee (gemini /
  // codex) omits those rates, so the delta is not computable → null → "—".
  // Anthropic carries both, so claude behavior is unchanged.
  const cacheDeltaPerMTok =
    pricing?.cacheWrite5mPerMTok != null && pricing.cacheReadPerMTok != null
      ? pricing.cacheWrite5mPerMTok - pricing.cacheReadPerMTok
      : null;
  const estimatedUsd =
    cacheDeltaPerMTok != null
      ? (estimatedTokens / 1_000_000) * cacheDeltaPerMTok
      : null;

  const forcesRelaunch = busting.some(f => FORCES_RELAUNCH.has(f));
  const list = busting.join(", ");
  const tokenPhrase = `~${estimatedTokens.toLocaleString()} tokens`;
  const reason = forcesRelaunch
    ? `Changing ${list} relaunches the session; the first turn cold-writes the prompt cache (${tokenPhrase}).`
    : `Changing ${list} invalidates the warm prompt cache; the next turn re-writes it (${tokenPhrase}).`;

  return {
    bustsCache: true,
    estimatedTokens,
    estimatedUsd,
    reason,
    isHeuristic: true,
  };
}
