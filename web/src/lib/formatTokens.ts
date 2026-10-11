// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Format a raw token count into a compact human-readable string — the Token
 * Usage widget's format (`1.2k`, `4.2M`; "1M" not "1.0M", modelConfig's
 * tier-label convention). Shared with `BackgroundAgentsModal` so a per-agent
 * figure reads the same in the widget breakdown and the modal (#4385). Distinct
 * by design from `extensions/token-usage/formatCompactTokens` (the compact
 * info-field format, `247K`).
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
