// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #1469: the context window is now sourced FIRST-ORDER from Claude Code's
 * get_context_usage (propagated as session.contextWindowTokens). The previous
 * proxy chain — a hardcoded model-family allowlist plus tier-suffix regex
 * parsing of a stale system.init model snapshot — has been DELETED. A correct
 * fix nets a deletion: this file no longer guesses the window from a model id.
 *
 * The UI keeps a conservative headroom budget below the true window to avoid
 * false confidence near the limit (system prompts, tool overhead, and other
 * hidden tokens consume extra space).
 */
const CONTEXT_HEADROOM_TOKENS = 10_000;

/**
 * Compute the usable context budget (tokens) from the first-order context
 * window reported by Claude Code. Returns null when the window is unknown
 * (e.g. an idle session that has not yet reported usage) — callers render a
 * neutral state rather than assuming a default. No proxy/heuristic fallback.
 */
export function getContextBudgetTokens(
  contextWindowTokens?: number
): number | null {
  if (contextWindowTokens && contextWindowTokens > 0) {
    return Math.max(1, contextWindowTokens - CONTEXT_HEADROOM_TOKENS);
  }
  return null;
}

/**
 * Result of {@link getModelContextTierLabel}.
 *
 * `label` is a short human string describing the effective context-window tier
 * (e.g. "1M tier", "200k tier", "500k tier"). Typed as string rather than a
 * literal union so future tiers render verbatim without a type update.
 *
 * Issue #1469 removed the tier-mismatch warning field: with a first-order
 * window there is no "model supports a larger tier but resolved lower"
 * ambiguity — the window IS whatever get_context_usage reports.
 */
export type ModelContextTierInfo = {
  label: string;
};

function formatTierLabel(windowTokens: number): string {
  if (windowTokens >= 1_000_000) {
    const millions = windowTokens / 1_000_000;
    // "1M" not "1.0M"; "1.5M" stays as "1.5M".
    const display = Number.isInteger(millions)
      ? millions.toString()
      : millions.toFixed(1);
    return display + "M tier";
  }
  if (windowTokens >= 1_000) {
    return Math.round(windowTokens / 1_000) + "k tier";
  }
  return windowTokens + " tier";
}

/**
 * Derive the effective context-window tier label from the first-order window
 * (session.contextWindowTokens). Returns null when the window is unknown
 * (idle session / not yet reported) so callers render a neutral state.
 */
export function getModelContextTierLabel(
  contextWindowTokens?: number
): ModelContextTierInfo | null {
  if (!contextWindowTokens || contextWindowTokens <= 0) return null;
  return { label: formatTierLabel(contextWindowTokens) };
}
