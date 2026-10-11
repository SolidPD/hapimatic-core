// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Sparkline — a tiny hand-rolled SVG trend line (epic #1855, Sub-Issue I / #1864).
 *
 * Plots a 0–100 utilization series as a single `<polyline>` across a fixed box.
 * Points are evenly spaced by index (sane for the ~10-min sampler cadence); the
 * y-axis spans the 0–100 percentage domain (inverted for screen coords). Fewer
 * than two points renders nothing. Pure presentational, no dependency — matches
 * the codebase's hand-rolled `UsageBar` (a styled div) rather than a chart lib.
 */

type SparklinePoint = { sampledAt: number; utilization: number };

type SparklineProps = {
  points: SparklinePoint[];
  width?: number;
  height?: number;
  /** Stroke color; defaults to the mint accent. */
  color?: string;
  className?: string;
};

export function Sparkline(props: SparklineProps) {
  const {
    points,
    width = 96,
    height = 20,
    color = "var(--app-accent)",
    className,
  } = props;

  // Need at least two points to draw a line.
  if (points.length < 2) return null;

  const pad = 1;
  const innerH = height - pad * 2;
  const stepX = width / (points.length - 1);

  const coords = points
    .map((p, i) => {
      const x = i * stepX;
      const clamped = Math.min(100, Math.max(0, p.utilization));
      const y = pad + innerH - (clamped / 100) * innerH;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
      data-testid="usage-sparkline"
    >
      <polyline
        points={coords}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
