// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * `Toolbar` — the shared search-and-action toolbar shell (composite, #3032 Sub D).
 * Extracts the structural shell that `SearchFilterBar` and `SystemJobsToolbar`
 * duplicate byte-for-byte: a flex row holding a flex-growing leading slot (a
 * `SearchInput` or a title) and a trailing dense action cluster, with the
 * mobile focus-collapse behavior that lets a focused search field reclaim the
 * cluster's space. Contract: `docs/design/design-system/composites.md`.
 *
 * Deliberately extracts ONLY the shell + spacing + focus-collapse — NOT the
 * filter/sort vocabularies, which legitimately differ per surface ("compose,
 * don't generalize", epic CF-5). Each consumer supplies its own `end` controls.
 *
 * - **Anatomy**: a `flex items-center gap-1.5` row → `start` slot (unwrapped, so
 *   it can `flex-1`) + an `items-center gap-0.5 shrink-0` wrapper around `end`.
 * - **Props / API**: `start` (leading, flex-grows), `end?` (trailing cluster),
 *   `collapseEndWhenFocused?` + `focused?` (wire from `SearchInput.onFocusChange`),
 *   `className?` (root passthrough — e.g. `flex-1 min-w-0` when nested in a flex row).
 * - **Composes**: `SearchInput` (typical `start`), any dropdown/button primitives
 *   in `end`.
 * - **States**: default · focused (when `collapseEndWhenFocused`, the `end` cluster
 *   is `hidden` below `sm` so `start` expands into it; restored on blur).
 * - **A11y**: a layout shell — NOT `role="toolbar"` (that ARIA role implies
 *   roving-tabindex arrow navigation these toolbars do not implement; claiming it
 *   would mislead assistive tech). Interactive children carry their own names.
 * - **Tokens**: layout-only (gap utilities); colors come from the composed children.
 *
 * A `center` slot is a reserved future ADDITIVE extension — no audited occurrence
 * uses three slots today, so it is not built now (YAGNI; mirrors `StatusDot`'s
 * reserved-extension convention).
 */
export interface ToolbarProps {
  /** Leading content — flex-grows to fill (typically a `SearchInput` or a title). */
  start: ReactNode;
  /** Trailing dense action cluster (filter / sort / reset controls). */
  end?: ReactNode;
  /**
   * When true, the `end` cluster is hidden below `sm` while `focused` is true, so
   * the leading content (a focused search field) expands into its space. Restored
   * on blur. Wire `focused` from `SearchInput`'s `onFocusChange`.
   */
  collapseEndWhenFocused?: boolean;
  /** Focus state driving `collapseEndWhenFocused`. */
  focused?: boolean;
  /** Extra classes on the root (e.g. `flex-1 min-w-0` when nested in a flex row). */
  className?: string;
}

export function Toolbar({
  start,
  end,
  collapseEndWhenFocused = false,
  focused = false,
  className,
}: ToolbarProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      {start}
      {end != null && (
        <div
          className={cn(
            collapseEndWhenFocused && focused ? "hidden sm:flex" : "flex",
            "items-center gap-0.5 shrink-0"
          )}
        >
          {end}
        </div>
      )}
    </div>
  );
}
