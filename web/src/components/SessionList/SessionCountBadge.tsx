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

// The layout of one count column in the ALIGNED cluster, shared by the router.tsx
// toolbar and every SubheadingBar so their columns cannot drift apart.
//
// Each column reserves the width of its widest expected value through an
// invisible, zero-height `::before` sizer: "00" for the first three counts and
// "000" for inactive, so "99 · 99 · 99 · 999" fits. The width comes from the
// rendered digits themselves (tabular figures, the device's own font), so no pixel
// constant has to be kept in step with the font. A count with more digits than its
// sizer widens its own column instead of overflowing. The old layout gave all four
// columns an equal share of a fixed 60px box sized for "9 · 9 · 9 · 99"; a
// three-digit inactive count pushed the row out of that box and under the search
// field.
//
// Each count is CENTERED in its column (Matt, 2026-11-16), so the space between a
// number and the dot on either side of it is equal. Right-aligned, as the columns
// first shipped, every number sat against the dot to its right and a one-digit
// count left its whole spare width on the left: the row read as clumps.
const COUNT_COLUMN_SIZER =
  "shrink-0 text-center before:block before:h-0 before:overflow-hidden before:invisible";

/** Column classes for the aligned cluster, keyed by status category. */
export const STATUS_COUNT_COLUMN_CLASS: Record<keyof StatusBreakdown, string> =
  {
    orange: COUNT_COLUMN_SIZER + " before:content-['00']",
    blue: COUNT_COLUMN_SIZER + " before:content-['00']",
    green: COUNT_COLUMN_SIZER + " before:content-['00']",
    gray: COUNT_COLUMN_SIZER + " before:content-['000']",
  };

// design-system PERMANENT exception (#3336, from #3038 pilot): the 6px separator
// dot sits far below the type-scale floor (--text-caption-xs = 10px), a decorative
// glyph size, not "type". Registered in
// docs/design/design-system/decision-typography.md § Sub-floor type-size
// exceptions. This is its one definition: the toolbar, the aligned cluster and the
// compact cluster all build on it.
const SEPARATOR_DOT = "shrink-0 text-[var(--app-hint)] text-[6px] leading-none";

/**
 * The separator dot of the aligned cluster. 2px each side, against the compact
 * cluster's 4px, so a column filled to its last digit ("99 · 99") still shows
 * space on both sides of its dot (Matt, 2026-11-16). At 1px each side the numbers
 * touched the dots. The search field beside the toolbar cluster pays for it: see
 * the toolbar block in router.tsx.
 */
export const STATUS_COUNT_SEPARATOR_CLASS = SEPARATOR_DOT + " px-0.5";
const COMPACT_SEPARATOR_CLASS = SEPARATOR_DOT + " px-1";

/**
 * Render the four-count session-status breakdown as colored numbers separated by
 * neutral dots, matching the toolbar cluster. All four counts always render,
 * including zeros (#3133).
 *
 * Two layouts (`variant`):
 * - `"compact"` (default) — a COMPACT `inline-flex` cluster for a header corner:
 *   each count is natural-width. Used wherever the badge is pinned beside a label
 *   or far-right (the historical placement).
 * - `"aligned"` — the router.tsx toolbar cluster's geometry: each count sits in a
 *   column of a reserved width (`STATUS_COUNT_COLUMN_CLASS`), so the four columns
 *   of every subheading bar line up under the toolbar's four (issue #3484). The
 *   toolbar renders the same classes, and both clusters start at the same x.
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
      className={`inline-flex items-center leading-none tabular-nums text-[length:var(--text-caption-xs)] ${props.className ?? ""}`}
      title={ariaLabel}
      aria-label={ariaLabel}
    >
      {/* Flat structure — numbers and separator dots are DIRECT siblings, exactly
          like the router.tsx toolbar cluster, so in `aligned` mode each column's
          width is its own reserved width and nothing else (a per-category wrapper
          would add the separator's width to a column and break the
          column-for-column alignment under the toolbar). */}
      {BADGE_CATEGORIES.map((c, i) => (
        <Fragment key={c.key}>
          {i > 0 && (
            <span
              aria-hidden="true"
              className={
                aligned ? STATUS_COUNT_SEPARATOR_CLASS : COMPACT_SEPARATOR_CLASS
              }
            >
              •
            </span>
          )}
          <span
            data-status-count={c.key}
            className={
              aligned
                ? `${STATUS_COUNT_COLUMN_CLASS[c.key]} ${c.colorClass}`
                : c.colorClass
            }
          >
            {breakdown[c.key]}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
