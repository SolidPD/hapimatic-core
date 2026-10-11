// SPDX-License-Identifier: AGPL-3.0-only
import { useId } from "react";
import type { ReactNode } from "react";
import { ChevronIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface GroupToggleHeaderProps {
  /** Collapsed state — drives the chevron rotation and `aria-expanded`. */
  collapsed: boolean;
  /** Fired when the bar is activated (click / Enter / Space). */
  onToggle: () => void;
  /** The section label (e.g. "Schedulers", "managed peers"). */
  label: ReactNode;
  /** Optional count / secondary text (e.g. "3 schedulers · 2 enabled", "(4)"). */
  count?: ReactNode;
  /** Optional leading glyph between the chevron and the label (e.g. a clock icon). */
  icon?: ReactNode;
  /** Optional trailing node pinned to the row end (e.g. a `SessionCountBadge`). */
  trailing?: ReactNode;
  /**
   * Optional collapsible body. When provided it renders below the bar ONLY
   * while expanded (the two never render simultaneously). Omit it to use the
   * bar as a standalone header and render the body yourself.
   */
  children?: ReactNode;
  /**
   * Tint + chrome passthrough for the bar `Button` — bg / text / hover /
   * padding. The composite is HUE-AGNOSTIC: the caller supplies the tint (a
   * blue-tinted scheduler subheader vs a mint/gold cluster header) via tokens
   * or utilities here, overriding the `ghost` variant's transparent default via
   * twMerge. Never hard-code a hue in the composite.
   */
  className?: string;
  /** Optional passthrough for the outer wrapper (e.g. a `border-l-4` tint rail). */
  wrapperClassName?: string;
  /**
   * `aria-controls` for the standalone-bar case — the id of a collapsible region
   * the caller renders separately. Ignored when `children` is provided (the
   * composite then wires its own body id).
   */
  "aria-controls"?: string;
  "data-testid"?: string;
}

/**
 * `GroupToggleHeader` — the recurring "group toggle header" collapse bar: a
 * full-width, tinted toggle (chevron + optional leading icon + label + optional
 * count + optional trailing badge) that collapses a section beneath it. Sits in
 * `web/src/components/ui/` beside `CollapsibleSection` / `DenseRow` (composite
 * conventions). Contract: `docs/design/design-system/composites.md`.
 *
 * - **Anatomy**: a full-width `Button` (`variant="ghost"`, `size="dense"`,
 *   overridden to `flex w-full justify-start` — the primitive-bypass gate keeps
 *   the bar on the shared `Button` rather than a raw `<button>`) → rotating
 *   `ChevronIcon` (`collapsed` state) → optional `icon` → `label` → optional
 *   `count` (`opacity-60`) → optional `trailing` (`ml-auto`); an optional
 *   collapsible body renders below when expanded.
 * - **Props / API**: `collapsed` + `onToggle` (state) · `label` (req) · `count?`
 *   · `icon?` (leading) · `trailing?` (badge) · `children?` (collapse body) ·
 *   `className` (bar tint/chrome — the hue seam) · `wrapperClassName?` (rail) ·
 *   `aria-controls?` (standalone case) · `data-testid?`.
 * - **Composes**: the `Button` primitive (`ghost` variant) + `ChevronIcon`
 *   (`@/components/icons`); the caller supplies the `icon` / `trailing` nodes
 *   (e.g. a `SessionCountBadge`).
 * - **Tint (R2)**: HUE-AGNOSTIC — the composite hard-codes NO hue. Callers pass
 *   their tint through `className` (bar bg/text/hover, overriding `ghost`'s
 *   transparent default via twMerge) and `wrapperClassName` (rail). The mint
 *   accent reads `text-accent` / `bg-accent` (runtime-swappable via
 *   `--palette-accent`); other sites pass their own token/utility tint.
 * - **States**: collapsed (chevron un-rotated, body absent) · expanded (chevron
 *   `rotate-90`, body in the DOM). The body is only in the DOM while expanded, so
 *   the summary/body never double-render.
 * - **A11y**: the `Button` primitive's native `<button>` (Enter/Space for free)
 *   and `focus-visible` ring, plus `aria-expanded` reflecting `!collapsed` and a
 *   conditional `aria-controls` (wired only while the referenced body is in the
 *   DOM, per axe `aria-valid-attr-value`).
 * - **Tokens**: `--text-caption` (label), `--text-caption-xs` (count); the bar's
 *   surface/hover/focus tokens come from the `Button` `ghost` variant. All hue
 *   comes from the caller.
 *
 * Standalone bar (caller renders the body + owns collapse state):
 * ```tsx
 * <GroupToggleHeader
 *   collapsed={isCollapsed}
 *   onToggle={onToggle}
 *   label="Schedulers"
 *   count={`${total} schedulers · ${enabled} enabled`}
 *   icon={<CalendarClockIcon className="h-3 w-3 shrink-0 opacity-80" />}
 *   className="bg-blue-950/20 py-1 px-2.5 text-blue-300 hover:bg-blue-950/30"
 *   wrapperClassName="border-l-4 border-l-blue-800"
 * />
 * ```
 *
 * With a collapsible body (mint cluster header):
 * ```tsx
 * <GroupToggleHeader
 *   collapsed={isCollapsed}
 *   onToggle={onToggle}
 *   label="managed peers"
 *   count={`(${children.length})`}
 *   trailing={<SessionCountBadge breakdown={breakdown} className="shrink-0" />}
 *   className="bg-accent/10 border-l-4 border-l-accent text-accent/70 hover:text-accent hover:bg-accent/15"
 * >
 *   {children.map(renderItem)}
 * </GroupToggleHeader>
 * ```
 */
export function GroupToggleHeader({
  collapsed,
  onToggle,
  label,
  count,
  icon,
  trailing,
  children,
  className,
  wrapperClassName,
  "aria-controls": ariaControls,
  "data-testid": dataTestid,
}: GroupToggleHeaderProps) {
  const bodyId = useId();
  const hasBody = children != null;

  return (
    <div data-testid={dataTestid} className={cn(wrapperClassName)}>
      <Button
        type="button"
        variant="ghost"
        size="dense"
        onClick={onToggle}
        aria-expanded={!collapsed}
        // The body is only in the DOM while expanded, so aria-controls is wired
        // only then — the referenced id must exist whenever the attribute is
        // present (axe aria-valid-attr-value). For the standalone case (no
        // children) the caller may point aria-controls at its own region.
        aria-controls={
          hasBody ? (collapsed ? undefined : bodyId) : ariaControls
        }
        className={cn(
          "flex w-full items-center justify-start gap-1.5 rounded-none py-0.5 text-left",
          className
        )}
      >
        <ChevronIcon className="h-2.5 w-2.5 shrink-0" collapsed={collapsed} />
        {icon}
        <span className="min-w-0 truncate select-none text-[length:var(--text-caption)] font-medium leading-none">
          {label}
        </span>
        {count != null && (
          <span className="shrink-0 select-none text-[length:var(--text-caption-xs)] leading-none opacity-60">
            {count}
          </span>
        )}
        {trailing != null && (
          <span className="ml-auto flex shrink-0 items-center">{trailing}</span>
        )}
      </Button>
      {hasBody && !collapsed && <div id={bodyId}>{children}</div>}
    </div>
  );
}
