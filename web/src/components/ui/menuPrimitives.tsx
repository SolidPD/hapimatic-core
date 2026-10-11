// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared dropdown-menu primitives for the app's sort/filter controls. Extracted
 * verbatim from SearchFilterBar (post-#942) so every sort surface — the session
 * list's Filter/Sort cluster and the account-usage page's Sort control — shares
 * ONE implementation: same trigger anatomy, same menu header + scoped clear,
 * same quiet-until-non-default mint signaling.
 */
import * as React from "react";
import { RotateCcwIcon } from "@/components/icons";
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/** Compact vertical padding so tall menus fit an iPhone screen (post-#942). */
export const COMPACT_ROW = "py-0.5";

/** Bright menu title sitting above the dimmer group labels (post-#942). */
export const MENU_TITLE = "py-0.5 text-sm font-semibold text-[var(--app-fg)]";

/**
 * Toolbar trigger button for a filter/sort menu: icon + label, mint accent while
 * the menu's selection is non-default so the toolbar reads quiet by default.
 */
export const menuTriggerClass = (active: boolean): string =>
  `flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors ${
    active
      ? "bg-[var(--app-accent)]/15 text-[var(--app-accent)]"
      : "text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]"
  }`;

export type MenuTriggerProps = {
  /**
   * True while the owning menu's selection is non-default — the trigger turns
   * mint (`menuTriggerClass(true)`) so the toolbar reads quiet by default.
   * Destructured here; it never reaches the DOM.
   */
  active: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * `MenuTrigger` — the shared filter/sort dropdown trigger (#3500). ONE native
 * `<button>` carrying `menuTriggerClass(active)`, mounted by every sort/filter
 * surface under `<DropdownMenuTrigger asChild>`. It consolidates the five
 * per-site raw triggers (`SearchFilterBar` ×2, `SystemJobsToolbar` ×2,
 * `account-usage`) — each of which carried its own `design-tokens-allow`
 * marker asserting the same thing — into one adjudicated exception, the
 * #3484 `SubheadingBar` / #3430 `CopyButton` precedent applied again.
 * Contract: `docs/design/design-system/primitives.md` → `menuPrimitives`.
 *
 * - **Anatomy**: a single `<button type="button">`; children are the caller's
 *   icon + label (`<FilterIcon /> <span>Filter</span>`).
 * - **Props / API**: `active` + every native `<button>` attribute (`title`,
 *   `data-testid`, `aria-*`, handlers) spread onto the element; `className`
 *   merged AFTER the base via `cn` for placement only (e.g. `shrink-0`); `ref`
 *   forwarded to the `HTMLButtonElement`.
 * - **Composes**: nothing — deliberately NOT a `Button`: `Button`'s cva base
 *   would layer under `menuTriggerClass()` and diverge the cluster (L8 #3410,
 *   D2 #3358), which is why the raw element is the adjudicated form.
 * - **States**: rest (`--app-hint` text, `--app-secondary-bg` hover) · active
 *   (15 % `--app-accent` tint + `--app-accent` text; hover-inert).
 * - **A11y**: native `<button>` Enter/Space. `aria-haspopup` / `aria-expanded` /
 *   `data-state` / the open-toggle `onClick` are injected by the Radix
 *   `DropdownMenuTrigger` Slot through the `{...rest}` spread — the spread
 *   landing on the `<button>` is the load-bearing contract at every `asChild`
 *   site. The accessible name is the caller's `title` / children.
 * - **Tokens**: `--app-accent`, `--app-hint`, `--app-secondary-bg` (all via
 *   `menuTriggerClass`).
 */
export const MenuTrigger = React.forwardRef<
  HTMLButtonElement,
  MenuTriggerProps
>(({ active, className, ...rest }, ref) => (
  <button /* design-tokens-allow: MenuTrigger is the shared menuTriggerClass() dropdown trigger (#3500) — the ONE adjudicated exception replacing the five per-site raw triggers; a <Button> box would layer its cva base under the helper and diverge the sort/filter cluster (L8 #3410, D2 #3358) */
    ref={ref}
    type="button"
    className={cn(menuTriggerClass(active), className)}
    {...rest}
  />
));
MenuTrigger.displayName = "MenuTrigger";

/**
 * A labelled radio group inside a dropdown menu. The CURRENT selection is
 * always highlighted in the accent (mint text on a 15% mint tint — the same
 * pair the toolbar trigger turns) — no dot. Until epic #3285 round 12 the
 * highlight was suppressed while the selection equalled the group's default,
 * so the Sort menu's "Last Active" (the default sort) never lit up; the
 * operator ruled (2026-09-07) that the selected option is highlighted whether
 * or not it is the default. The "quiet until you deviate" signal still lives
 * on the TRIGGER (`menuTriggerClass(active)`), which turns mint only for a
 * non-default selection.
 */
export function MenuRadioSection<T extends string>(props: {
  /** Section sublabel. Omit it when a single section sits under a menu whose
   *  title already names the axis (e.g. account-usage's "Sort" menu) — a
   *  "Sort by" sublabel there is redundant. */
  label?: string;
  value: string;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <>
      {props.label && (
        <DropdownMenuLabel className={`${COMPACT_ROW} text-[var(--app-hint)]`}>
          {props.label}
        </DropdownMenuLabel>
      )}
      <DropdownMenuRadioGroup
        value={props.value}
        onValueChange={v => props.onChange(v as T)}
      >
        {props.options.map(o => {
          const selected = o.value === props.value;
          return (
            <DropdownMenuRadioItem
              key={o.value}
              value={o.value}
              showIndicator={false}
              className={
                selected
                  ? `${COMPACT_ROW} bg-[var(--app-accent)]/15 text-[var(--app-accent)] focus:bg-[var(--app-accent)]/20 focus:text-[var(--app-accent)]`
                  : COMPACT_ROW
              }
            >
              {o.label}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </>
  );
}

/**
 * Menu header: the bright title plus a per-menu "clear to default" reset (the
 * same rotate-ccw glyph as the toolbar's global reset), shown ONLY when this
 * menu has a non-default selection. Scoped clear — leaves sibling menus and any
 * search untouched. A reset icon (not an "X") because an X in a popover header
 * reads as "close the menu". (post-#942)
 */
export function MenuHeader(props: {
  title: string;
  clearLabel: string;
  showClear: boolean;
  onClear: () => void;
}) {
  return (
    <DropdownMenuLabel className={MENU_TITLE}>
      <div className="flex items-center justify-between gap-2">
        <span>{props.title}</span>
        {props.showClear && (
          <button
            type="button"
            onClick={props.onClear}
            title={props.clearLabel}
            aria-label={props.clearLabel}
            className="flex items-center rounded p-0.5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
          >
            <RotateCcwIcon className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </DropdownMenuLabel>
  );
}
