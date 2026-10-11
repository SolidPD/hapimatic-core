// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Compact token formatter for the `builtin.token-usage` info-field slot
 * (issue #1285, Sub-Issue U of epic #1264).
 *
 * Format rules (per issue #1285 R1):
 *  - n >= 1_000_000  → "<n/1_000_000 to 1dp>M"   (e.g., 1_000_000 → "1.0M")
 *  - n >= 1_000      → "<round(n/1_000)>K"        (e.g., 246_500 → "247K")
 *  - n < 1_000       → "<n>"                       (e.g., 42 → "42")
 *
 * Intentionally distinct from `TokenUsageWidget:formatTokens`
 * (`web/src/components/TokenUsageWidget.tsx`), which emits a lowercase `k` with
 * one decimal (`247.0k`). The info-field is a compact single-line at-a-glance
 * display; the widget is the expanded analytical view. The two coexist by
 * design, so the divergence is deliberate and asserted by a colocated test.
 */
export function formatCompactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
