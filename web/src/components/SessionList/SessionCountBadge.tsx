// SPDX-License-Identifier: AGPL-3.0-only
// SessionCountBadge — a compact, ALWAYS-VISIBLE four-count status breakdown
// (needs-attention / working / active / inactive) rendered on every session-group
// surface header: project-group headers, branch clusters, managed-peer clusters,
// and scheduler-spawned sections. #3133 made it always-on and always-four-count;
// it began life in #2900 as the collapsed-only, zeros-omitted "HiddenStatusHint".
//
// The colors, order, and neutral-dot separators MUST mirror the toolbar status
// cluster in router.tsx (orange → blue → green → gray) EXACTLY. Both derive their
// numbers from getStatusBreakdown / getSessionStatusCategory, so a per-surface
// badge can never diverge from the global toolbar total (R4).
import { Fragment } from "react";
import type { StatusBreakdown } from "@/lib/sessionHelpers";

const BADGE_CATEGORIES: ReadonlyArray<{
  key: keyof StatusBreakdown;
  colorClass: string;
  label: string;
}> = [
  // #3334 (epic #3028 Sub B): the session-status category quad is now a named token
  // family — --status-cat-attention / -working / -active / -inactive (see tokens.css),
  // distinct from the --status-ok/warn/hot health triad. These MUST still mirror the
  // router.tsx toolbar cluster byte-for-byte (same tokens, same orange→blue→green→gray
  // order). Other consumers of the same orange/blue (RecoveryStatusBadge, StatusBar)
  // are Sub K's (#3039) sweep, not this issue.
  {
    key: "orange",
    colorClass: "text-[var(--status-cat-attention)]",
    label: "needs attention",
  },
  {
    key: "blue",
    colorClass: "text-[var(--status-cat-working)]",
    label: "working",
  },
  {
    key: "green",
    colorClass: "text-[var(--status-cat-active)]",
    label: "active",
  },
  {
    key: "gray",
    colorClass: "text-[var(--status-cat-inactive)]",
    label: "inactive",
  },
];

/**
 * Render the four-count session-status breakdown as colored numbers separated by
 * neutral dots, matching the toolbar cluster. All four counts always render,
 * including zeros (#3133).
 *
 * Two layouts (`variant`):
 * - `"compact"` (default) — a COMPACT `inline-flex` cluster for a header corner:
 *   each count is natural-width. Used wherever the badge is pinned beside a label
 *   or far-right (the historical placement).
 * - `"aligned"` — reproduces the router.tsx toolbar cluster geometry EXACTLY: a
 *   `flex w-full` row whose four columns are `flex-1 text-right`, so the columns
 *   distribute a FIXED parent width into an even grid that lines up column-for-column
 *   under the toolbar's own `flex-1 text-right` cluster (issue #3484 — subheading
 *   bars align their status cluster under the title-bar accumulator). The caller
 *   supplies the fixed width via a wrapping box (see `SubheadingBar`).
 */
export function SessionCountBadge(props: {
  breakdown: StatusBreakdown;
  className?: string;
  variant?: "compact" | "aligned";
}) {
  const { breakdown } = props;
  const variant = props.variant ?? "compact";
  const aligned = variant === "aligned";
  const total = BADGE_CATEGORIES.reduce((n, c) => n + breakdown[c.key], 0);
  const summary = BADGE_CATEGORIES.map(
    c => `${breakdown[c.key]} ${c.label}`
  ).join(", ");
  const ariaLabel = `${total} session${total === 1 ? "" : "s"}: ${summary}`;
  return (
    <span
      data-testid="session-count-badge"
      data-variant={variant}
      className={`${aligned ? "flex w-full" : "inline-flex"} items-center leading-none tabular-nums text-[length:var(--text-caption-xs)] ${props.className ?? ""}`}
      title={ariaLabel}
      aria-label={ariaLabel}
    >
      {/* Flat structure — numbers and separator dots are DIRECT siblings, exactly
          like the router.tsx toolbar cluster, so `aligned` mode's four `flex-1
          text-right` number columns are all equal width (a per-category wrapper
          would make column 0 wider by the separator width, breaking column-for-column
          alignment under the toolbar). */}
      {BADGE_CATEGORIES.map((c, i) => (
        <Fragment key={c.key}>
          {i > 0 && (
            /* design-system PERMANENT exception (#3336, from #3038 pilot): the 6px
               separator dot sits far below the type-scale floor (--text-caption-xs =
               10px) — a decorative glyph size, not "type". Registered in
               docs/design/design-system/decision-typography.md
               § Sub-floor type-size exceptions. */
            <span
              aria-hidden="true"
              className="shrink-0 text-[var(--app-hint)] text-[6px] leading-none px-1"
            >
              •
            </span>
          )}
          <span
            className={
              aligned ? `flex-1 text-right ${c.colorClass}` : c.colorClass
            }
          >
            {breakdown[c.key]}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
