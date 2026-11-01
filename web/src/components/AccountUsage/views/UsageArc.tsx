// SPDX-License-Identifier: AGPL-3.0-only
import { LEVEL_COLOR, usageLevel } from "../UsageBar";
import { arcBackground, arcSweepDeg } from "./usageMeters";

/** The ring: masks away the hole (inside 68% of the radius) AND everything
 *  past the radius, because a conic gradient fills its whole 2:1 box and the
 *  box's top corners would otherwise show (#4467). */
const ARC_MASK =
  "radial-gradient(circle farthest-side at 50% 100%, transparent 68%, black 69%, black 99%, transparent 100%)";

/**
 * One semicircular usage arc (#4467 R3): the band-coloured sweep over the
 * track, with the percentage in its mouth in the same band colour. Pure CSS (a
 * conic gradient masked to a ring); its width is the `--arc-size` the grid sets,
 * and its height follows from `aspect-ratio`, so five columns at 393px simply
 * shrink it. A placeholder (no meter) draws the track only, with a dash.
 */
export function UsageArc({ pct }: { pct: number | null }) {
  const level = pct == null ? null : usageLevel(pct);
  const color = level ? LEVEL_COLOR[level] : "var(--app-hint)";
  const sweep = arcSweepDeg(pct);
  return (
    <div
      data-testid="usage-arc"
      data-sweep={sweep}
      data-usage-level={level ?? "none"}
      className="relative mx-auto shrink-0"
      style={{ width: "var(--arc-size)", aspectRatio: "2 / 1" }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background: arcBackground(sweep, color),
          maskImage: ARC_MASK,
          WebkitMaskImage: ARC_MASK,
        }}
      />
      <span
        className="absolute inset-x-0 bottom-0 text-center text-[length:var(--text-body-dense)] font-bold leading-none tabular-nums"
        style={{ color }}
      >
        {pct == null ? "—" : `${Math.round(pct)}%`}
      </span>
    </div>
  );
}
