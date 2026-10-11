// SPDX-License-Identifier: AGPL-3.0-only
/**
 * UsageBar — the canonical color-threshold progress bar (epic #1855, Sub E / #1860).
 *
 * Renders a horizontal bar whose fill width equals `value` (a 0–100 percentage,
 * matching the `oauth/usage` utilization scale from `@hapi/protocol`) and whose
 * color reflects the threshold band: mint < 70, amber 70–90 (inclusive), red > 90.
 * A missing value (null / undefined / non-finite) renders a muted "—" instead of a
 * filled bar. Pure presentational — no state, no effects.
 *
 * Modeled after `SystemHealthModal.tsx`'s `MetricProgressBar`, but with its own
 * 70/90 thresholds (the issue spec) rather than that component's 80/90 health bands.
 */

type UsageLevel = "mint" | "amber" | "red";

export const LEVEL_COLOR: Record<UsageLevel, string> = {
  // Design-system tokens (L3 #3405). mint is the runtime-swappable accent — never
  // hardcode the literal, or the theme swap breaks. amber/red map to the tokens
  // that carry the exact former hexes (status-warn, accent-red-500).
  mint: "var(--app-accent)", // runtime-swappable mint accent — < 70%
  amber: "var(--status-warn)", // amber warn — 70–90%
  red: "var(--accent-red-500)", // red — > 90%
};

/**
 * Threshold band for a raw 0–100 utilization percentage (the 5h / Wk / credits
 * bars). The pacing-score badge uses {@link scoreLevel} instead — the score is a
 * pace-relative composite, not a raw %, so its bands differ.
 */
export function usageLevel(pct: number): UsageLevel {
  if (pct > 90) return "red";
  if (pct >= 70) return "amber";
  return "mint";
}

/**
 * Threshold band for the account PACING score badge (2026-07-20 sustainable-rate
 * redesign, usage.ts computeUtilizationScore). The score is pace-relative — 50 =
 * exactly on the line that lands at 99% when the window resets — so its bands are
 * anchored to that meaning rather than the raw-% 70/90 thresholds: mint < 60
 * (at/behind pace — spend here), amber 60–80 (ahead of pace — throttle), red > 80
 * (nearly spent for its window, or locked). LOWER is more attractive.
 */
export function scoreLevel(score: number): UsageLevel {
  if (score > 80) return "red";
  if (score >= 60) return "amber";
  return "mint";
}

type UsageBarProps = {
  /** 0–100 percentage. `null`/`undefined`/non-finite renders a muted "—". */
  value: number | null | undefined;
  /** Optional leading label (e.g. "5-hour"). */
  label?: string;
  className?: string;
};

export function UsageBar(props: UsageBarProps) {
  const { value, label, className } = props;
  const hasValue = value != null && Number.isFinite(value);

  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <div className="flex items-center justify-between text-[length:var(--text-body)] leading-none">
        {label != null && <span className="text-[var(--app-fg)]">{label}</span>}
        {hasValue ? (
          <span
            className="tabular-nums font-semibold"
            style={{ color: LEVEL_COLOR[usageLevel(value)] }}
          >
            {Math.round(value)}%
          </span>
        ) : (
          <span className="tabular-nums font-semibold text-[var(--app-hint)]">
            —
          </span>
        )}
      </div>
      <div className="h-2 bg-[var(--app-subtle-bg)] rounded-full overflow-hidden">
        {hasValue && (
          <div
            data-testid="usage-bar-fill"
            data-usage-level={usageLevel(value)}
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${value <= 0 ? 0 : Math.min(100, Math.max(2, value))}%`,
              backgroundColor: LEVEL_COLOR[usageLevel(value)],
            }}
          />
        )}
      </div>
    </div>
  );
}
