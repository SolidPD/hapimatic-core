// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";

export interface ListDetailProps {
  /** The list pane. */
  list: ReactNode;
  /** The detail pane. When absent, the list fills the surface. */
  detail?: ReactNode;
  /**
   * SPATIAL toggle: when true (and a detail is present) render list + detail
   * side-by-side. The consumer drives this from `useSplitView` (the 800px split
   * eligibility threshold) — it is a WIDTH/spatial signal, never a device name
   * (decision-layout-adaptation.md L-1/L-2).
   */
  split?: boolean;
  /**
   * In single-pane mode, which pane is visible. Defaults to the detail pane when a
   * detail is present, else the list.
   */
  activePane?: "list" | "detail";
  /** Width of the list pane (px) in split mode. Defaults to 360. */
  listWidth?: number;
}

/**
 * ListDetail — the list / list-detail split layout template (Interface Design System
 * Sub-Issue E, epic #3028). A list pane and an optional detail pane that sit
 * side-by-side when the viewport is split-eligible, or one-at-a-time otherwise.
 *
 * Regions: list pane · detail pane. Exactly ONE scroll owner PER pane — each pane
 * root is its own `overflow-y-auto` scroll container (#2830 invariant, generalized).
 *
 * Pane adaptation is capability/spatial-driven: the `split` toggle comes from
 * `useSplitView` (window-dimension), never from a device category. The template
 * itself is pure (no hook, no `window.innerWidth`) so it is fully testable; the
 * consumer wires the sanctioned hook's output in.
 *
 * See the layout catalog at `docs/design/design-system/layouts.md`.
 */
export function ListDetail({
  list,
  detail,
  split = false,
  activePane,
  listWidth = 360,
}: ListDetailProps) {
  const hasDetail = detail != null;
  const showBoth = split && hasDetail;
  const pane = activePane ?? (hasDetail ? "detail" : "list");
  const showList = showBoth || pane === "list";
  const showDetail = hasDetail && (showBoth || pane === "detail");

  return (
    <div className="flex h-full min-h-0 w-full">
      {showList && (
        <div
          data-region="list"
          className={`flex min-h-0 flex-col overflow-y-auto ${
            showBoth
              ? "flex-shrink-0 border-r border-[var(--app-border)]"
              : "flex-1"
          }`}
          style={showBoth ? { width: `${listWidth}px` } : undefined}
        >
          {list}
        </div>
      )}
      {showDetail && (
        <div
          data-region="detail"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
          {detail}
        </div>
      )}
    </div>
  );
}
