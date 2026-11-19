// SPDX-License-Identifier: AGPL-3.0-only
// SubheadingBar — the ONE shared collapsible "subheading bar" used by every
// session-group subheading: managed peers (same-repo + cross-repo), branched
// conversations, scheduled peers, and the Schedulers group header. It replaces
// the hand-copied raw <button> subheadings that each carried a "grandfathered
// pattern" design-tokens-allow comment, so all subheading bars are UNIFORMLY
// formatted by construction (issue #3484).
//
// Uniform anatomy, left → right:
//   [status cluster]  [icon?]  [label]  [(count)?]  ————ml-auto————  [chevron]
//
// - The status cluster sits at the FAR LEFT. Its four columns each reserve their
//   own width (SessionCountBadge variant="aligned", STATUS_COUNT_COLUMN_CLASS), and
//   the router.tsx toolbar accumulator renders the same column classes, so the two
//   are the same width. The card pattern insets a subheading by 5px (its own 4px
//   rail + the 1px card hairline, --subheading-rail-inset in index.css), and the
//   toolbar cluster is padded left by that same inset, so both start at the same x
//   and every column of every bar sits under the toolbar's column. Bars with no
//   session-status cluster (the Schedulers group header) omit it — the label then
//   starts at the far left.
// - `nestedInRail`: a bar whose card sits INSIDE an outer 4px rail (the managed
//   clusters' dark-gold rail, the scheduler section's dark-blue rail) is pushed
//   4px further right than a bar whose card is not (branched conversations).
//   Such bars use pl-1 instead of pl-2 so every bar's cluster starts at the same
//   x (content-left + 13px) regardless of nesting — the "all four uniform"
//   ruling (#3484 Option 2).
// - The chevron is pinned FAR RIGHT (ml-auto) in a slot exactly as wide as the
//   session rows' rightmost icon-column control (--icon-btn-size, 32px) behind
//   the same pr-2 the rows use, so its center lands on the rows' expand/collapse
//   chevron column by construction: right-edge − 8px − 16px on both.
// - The bar is ~50% taller than the old py-0.5 subheadings (py-1.5) with the
//   text vertically centered (items-center) — a small even pad above and below.
//
// HUE-AGNOSTIC: the composite hard-codes NO color. The caller passes the tint
// (bg / border-l rail / text / hover) via `className`; the base owns only
// layout (flex / gap / height / padding / alignment).
import type { MouseEvent, ReactNode } from "react";
import { ChevronIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export interface SubheadingBarProps {
  /** Collapsed state — drives the chevron rotation and `aria-expanded`. */
  collapsed: boolean;
  /** Fired when the bar is activated (click). */
  onToggle: () => void;
  /** The section label (e.g. "managed peers", "Schedulers"). */
  label: ReactNode;
  /** Optional count / secondary text (e.g. "(4)", "3 schedulers · 2 enabled"). */
  count?: ReactNode;
  /**
   * Optional far-left status cluster — pass a
   * `<SessionCountBadge variant="aligned" />`, whose reserved-width columns align
   * under the toolbar accumulator. Omit for bars that have no session-status
   * cluster (the Schedulers group header).
   */
  cluster?: ReactNode;
  /** Optional leading glyph between the cluster and the label (e.g. a clock icon). */
  icon?: ReactNode;
  /**
   * True when this bar's card is wrapped by an OUTER 4px rail (managed-peer
   * clusters, the scheduler section). Trades pl-2 for pl-1 so the cluster's left
   * edge matches the bars that have no outer rail (see header comment).
   */
  nestedInRail?: boolean;
  /** Tint + rail chrome passthrough for the bar `<button>` (bg / border-l / text / hover). */
  className?: string;
  /** Optional passthrough for the count/secondary-text span (e.g. opacity). */
  countClassName?: string;
  /**
   * #6646 (Task 14, review P17): an optional control beside the toggle (e.g. the
   * "To confirm" bar's Keep all). With it, the bar is a `div` holding the toggle
   * button, the action and the chevron as a second button calling `onToggle`,
   * so no button nests in another. Without it the markup is unchanged.
   */
  action?: ReactNode;
  "aria-controls"?: string;
  "data-testid"?: string;
}

export function SubheadingBar({
  collapsed,
  onToggle,
  label,
  count,
  cluster,
  icon,
  nestedInRail = false,
  className,
  countClassName,
  action,
  "aria-controls": ariaControls,
  "data-testid": dataTestid,
}: SubheadingBarProps) {
  const toggle = (e: MouseEvent) => {
    e.stopPropagation();
    onToggle();
  };
  if (action != null) {
    return (
      <div
        data-testid={dataTestid}
        data-nested-in-rail={nestedInRail ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-1.5 pr-2 transition-colors",
          nestedInRail ? "pl-1" : "pl-2",
          className
        )}
      >
        <button /* design-tokens-allow: SubheadingBar's toggle (#3484) — hue-agnostic, every tint arrives via the caller's className on the wrapping div. */
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={ariaControls}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left"
        >
          <SubheadingBarText
            cluster={cluster}
            icon={icon}
            label={label}
            count={count}
            countClassName={countClassName}
          />
        </button>
        {action}
        <button /* design-tokens-allow: SubheadingBar's chevron (#3484), the same toggle as a second button so the action sits between them; no color of its own. */
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={ariaControls}
          aria-label={collapsed ? "Expand" : "Collapse"}
          data-subheading-chevron
          className="flex shrink-0 items-center justify-center self-stretch w-[var(--icon-btn-size)]"
        >
          <ChevronIcon className="h-2.5 w-2.5 shrink-0" collapsed={collapsed} />
        </button>
      </div>
    );
  }
  return (
    <button /* design-tokens-allow: SubheadingBar is the shared, hue-agnostic subheading composite (#3484) — it hard-codes NO color; every tint arrives via the caller's className. It consolidates the previously grandfathered per-site raw subheading buttons into one primitive. */
      type="button"
      // stopPropagation so a toggle click never reaches an enclosing clickable
      // row (the "scheduled peers" bar nests inside a clickable schedule row);
      // harmless for the managed/branch bars which have no row-level click nav.
      onClick={e => {
        e.stopPropagation();
        onToggle();
      }}
      aria-expanded={!collapsed}
      aria-controls={ariaControls}
      data-testid={dataTestid}
      data-nested-in-rail={nestedInRail ? "true" : undefined}
      // pr-2 mirrors SessionItem's row padding (`pr-2`) so the chevron slot
      // below lands on the session rows' chevron column. pl-1 vs pl-2 absorbs
      // the outer-rail nesting difference (see header comment).
      className={cn(
        "flex w-full items-center gap-1.5 py-1.5 pr-2 text-left transition-colors",
        nestedInRail ? "pl-1" : "pl-2",
        className
      )}
    >
      {cluster != null && (
        <span
          data-subheading-cluster
          // #3285: `mr-1.5` adds 6px beyond the row's gap-1.5, separating the
          // status-count values from the label (e.g. "…· 4  managed peers") which
          // read as one run when only 6px apart. It's a MARGIN outside the
          // cluster, so the columns' alignment under the toolbar accumulator is
          // unchanged. The cluster sizes itself: each column reserves its own
          // width (see the header comment).
          className="flex shrink-0 mr-1.5"
        >
          {cluster}
        </span>
      )}
      {icon}
      <span className="min-w-0 truncate select-none text-[length:var(--text-caption-xs)] font-medium leading-none">
        {label}
      </span>
      {count != null && (
        <span
          className={cn(
            // Round 14 follow-up (mockup C): no opacity dimming — it let the
            // cluster tint bleed through the count (40 % at 0.6).
            "shrink-0 select-none text-[length:var(--text-caption-xs)] leading-none",
            countClassName
          )}
        >
          {count}
        </span>
      )}
      {/* Chevron slot — as wide as the session rows' rightmost icon-column
          control (--icon-btn-size = 32px, the row's expand/collapse chevron
          button), pinned far right (ml-auto) behind the same pr-2 the rows use.
          Both centers are therefore right-edge − 8px − 16px: the alignment is
          structural, not a tuned margin. The glyph keeps its size-retained
          h-2.5 and is centered in the slot. */}
      <span
        data-subheading-chevron
        className="ml-auto flex shrink-0 items-center justify-center w-[var(--icon-btn-size)]"
      >
        <ChevronIcon className="h-2.5 w-2.5 shrink-0" collapsed={collapsed} />
      </span>
    </button>
  );
}

/** The bar's cluster, icon, label and count, inside the toggle (with an action). */
function SubheadingBarText(props: {
  cluster?: ReactNode;
  icon?: ReactNode;
  label: ReactNode;
  count?: ReactNode;
  countClassName?: string;
}) {
  return (
    <>
      {props.cluster != null && (
        <span data-subheading-cluster className="flex shrink-0 mr-1.5">
          {props.cluster}
        </span>
      )}
      {props.icon}
      <span className="min-w-0 truncate select-none text-[length:var(--text-caption-xs)] font-medium leading-none">
        {props.label}
      </span>
      {props.count != null && (
        <span
          className={cn(
            "shrink-0 select-none text-[length:var(--text-caption-xs)] leading-none",
            props.countClassName
          )}
        >
          {props.count}
        </span>
      )}
    </>
  );
}
