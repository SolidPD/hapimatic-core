// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import type { FederationHealthSeverity } from "@hapi/protocol";
import {
  severityToColor,
  LATENCY_FULL_SCALE_MS,
} from "./federation/federationHealthColors";

// Cap the rendered sample count so a long retention window can't blow up the
// sparkline point count (issue #1444, perf note).
const MAX_SPARKLINE_SAMPLES = 60;
const SPARKLINE_W = 100;
const SPARKLINE_H = 24;

export type NodeResourceMeterProps = {
  label: string;
  icon?: ReactNode;
  /** Current reading; null → unknown (e.g. latency on the local node). */
  value: number | null;
  unit: "%" | "ms";
  severity: FederationHealthSeverity;
  /** Secondary line, e.g. "40 GiB / 100 GiB" or a mount point. */
  detail?: string;
  /** Recent samples for the sparkline; nulls are gaps (skipped). */
  samples: Array<number | null>;
};

function barFillPercent(value: number, unit: "%" | "ms"): number {
  if (unit === "%") return Math.min(100, Math.max(0, value));
  return Math.min(100, Math.max(0, (value / LATENCY_FULL_SCALE_MS) * 100));
}

function formatValue(value: number | null, unit: "%" | "ms"): string {
  if (value === null) return "—";
  return unit === "%" ? `${Math.round(value)}%` : `${Math.round(value)} ms`;
}

/**
 * Build the sparkline polyline `points` from the last N non-null samples
 * (nulls are skipped, per R5). Y is scaled to the window's own min..max so the
 * trend shape is visible regardless of unit; a flat series renders mid-height.
 * Returns "" when there is nothing to plot. Exported for unit testing.
 */
export function sparklinePoints(samples: Array<number | null>): string {
  const recent = samples.slice(-MAX_SPARKLINE_SAMPLES);
  const values = recent.filter((v): v is number => v !== null);
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x =
        values.length === 1
          ? SPARKLINE_W / 2
          : (i / (values.length - 1)) * SPARKLINE_W;
      const y = SPARKLINE_H - ((v - min) / span) * SPARKLINE_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * Full-size per-node resource meter (issue #1444, Task 6): a label row with the
 * numeric value, a horizontal bar colored by the server-computed severity, and
 * an inline-SVG sparkline of the recent time-series. Larger than the summary
 * card's compact `DimensionBar`. No charting library — a hand-rolled polyline
 * keeps the four tiny sparklines cheap.
 */
export function NodeResourceMeter({
  label,
  icon,
  value,
  unit,
  severity,
  detail,
  samples,
}: NodeResourceMeterProps) {
  const color = severityToColor(severity);
  const points = sparklinePoints(samples);
  const fillPercent = value === null ? 0 : barFillPercent(value, unit);

  return (
    <div
      data-testid={`node-meter-${label.toLowerCase()}`}
      className="flex flex-col gap-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[length:var(--text-body)] font-medium text-[var(--app-fg)]">
          {icon ? <span className="text-[var(--app-hint)]">{icon}</span> : null}
          {label}
        </span>
        <span
          data-testid="node-meter-value"
          className={
            /* design-tokens-allow: 15px has no exact type-scale token (ladder: 14px label-strong → 16px is text-base) and no font-size-only Tailwind utility (text-base injects line-height) — D2 px-floor exception precedent (#3358) */ "text-[15px] font-semibold tabular-nums"
          }
          style={{ color: value === null ? "var(--app-hint)" : color }}
        >
          {formatValue(value, unit)}
        </span>
      </div>

      {detail ? (
        <span className="text-[length:var(--text-caption)] text-[var(--app-hint)]">
          {detail}
        </span>
      ) : null}

      <div className="h-2.5 overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
        {value !== null && (
          <div
            data-testid="node-meter-bar"
            className="h-full rounded-full transition-all duration-500 ease-out"
            style={{
              width: `${Math.max(fillPercent, 4)}%`,
              backgroundColor: color,
            }}
          />
        )}
      </div>

      <svg
        data-testid="node-meter-sparkline"
        viewBox={`0 0 ${SPARKLINE_W} ${SPARKLINE_H}`}
        preserveAspectRatio="none"
        className="h-6 w-full"
        role="img"
        aria-label={`${label} trend`}
      >
        {points ? (
          <polyline
            data-testid="node-meter-sparkline-line"
            points={points}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    </div>
  );
}
