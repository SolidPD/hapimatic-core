// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "@/components/icons";

/**
 * FilterChip — a filter-bar chip trigger for the shared design-system scope/filter
 * atoms (A3 / #1979). Presentational only: it renders the pill + chevron and signals
 * activation via `onClick`; opening and positioning the actual menu is the caller's
 * concern. Consumed by #1982 (Session Metadata filter bar), Federation, and A4.
 *
 * Styling models SearchFilterBar.tsx's `triggerClass`: active = mint accent tint,
 * idle = muted --app-hint with a subtle hover fill.
 *
 * Scope boundary (D12 item 4 / #1976): FilterChip covers ENUMERATED / menu-backed
 * filters only. Free-text inputs (e.g. SM03's session filter) and date-range inputs
 * stay native `<input>`s alongside the chips — do NOT force them through FilterChip.
 *
 * Accessibility: a `<button>` with `aria-haspopup="menu"` and `aria-expanded` (pass
 * `expanded` to reflect the menu's open state); keyboard-activatable as a button.
 */
export interface FilterChipProps {
  /** The filter's name (e.g. "Kind"). */
  label: React.ReactNode;
  /** The current selection, rendered as ": value" after the label. */
  value?: React.ReactNode;
  /** Highlight the chip (a non-default filter is applied). */
  active?: boolean;
  /** Reflects the associated menu's open state for `aria-expanded`. */
  expanded?: boolean;
  /** Fired on activation — the caller opens its menu here. */
  onClick?: () => void;
  /** Accessible label override (defaults to the button's text content). */
  ariaLabel?: string;
  className?: string;
}

export function FilterChip({
  label,
  value,
  active = false,
  expanded = false,
  onClick,
  ariaLabel,
  className,
}: FilterChipProps) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={expanded}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors",
        active
          ? "bg-[var(--app-accent)]/15 text-[var(--app-accent)]"
          : "text-[var(--app-hint)] hover:bg-[var(--app-secondary-bg)]",
        className
      )}
    >
      <span>
        {label}
        {value != null && <>: {value}</>}
      </span>
      <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" />
    </button>
  );
}
