// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * SegmentedToggle — an iOS-style segmented control for the shared design-system
 * scope/filter atoms (A3 / #1979). Generalizes the inline scope toggle in
 * routes/settings/session-metadata.tsx ("This node" / "All nodes"). Consumed by #1982
 * (Session Metadata scope bar), Federation, and A4 page migrations.
 *
 * Controlled component: the caller owns `value` and updates it in `onChange`.
 *
 * Accessibility (locked prop-API contract):
 * - `role="radiogroup"` wrapper labelled by the required `ariaLabel`; each segment is a
 *   `role="radio"` with `aria-checked` reflecting selection.
 * - Roving tabindex: only the selected segment is a tab stop (`tabIndex=0`); the rest
 *   are `tabIndex=-1`. Arrow keys (Left/Right/Up/Down) move DOM focus AND selection
 *   together (avoiding the classic "focus stranded on an unchecked segment" bug),
 *   wrapping at the ends; Home/End jump to first/last.
 * - `testIdPrefix` renders `{prefix}-{value}` as each segment's `data-testid` (required
 *   for Federation/A4 tests that click e.g. `federation-filter-all-nodes`).
 */
export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

export interface SegmentedToggleProps<T extends string> {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible group label — required (this is a radiogroup). */
  ariaLabel: string;
  /** Optional prefix for per-option `data-testid`s, rendered as `{prefix}-{value}`. */
  testIdPrefix?: string;
  /**
   * Visual treatment. `"default"` is the compact subtle-bg track with an elevated
   * selected segment; `"accent-filled"` gives an accent-fill selected segment
   * (`bg-[var(--app-link)]` + dark text) matching the settings radio-rows (#3339).
   * `"outline"` gives bordered NewVmForm-style pills — accent border + 10 % accent
   * tint when selected, neutral border + hint text unselected, `text-xs`, no hover
   * (#3510).
   * @default "default"
   */
  variant?: "default" | "accent-filled" | "outline";
  /**
   * Stretch each segment to fill the container width (`flex-1`). Intended for the
   * `accent-filled` and `outline` variants, to match the full-width preferences
   * radio-rows.
   * @default false
   */
  fullWidth?: boolean;
  className?: string;
}

export function SegmentedToggle<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  testIdPrefix,
  variant = "default",
  fullWidth = false,
  className,
}: SegmentedToggleProps<T>) {
  const buttonRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const accent = variant === "accent-filled";
  const outline = variant === "outline";

  const moveTo = (index: number) => {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    buttonRefs.current[index]?.focus();
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    currentIndex: number
  ) => {
    const last = options.length - 1;
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = currentIndex >= last ? 0 : currentIndex + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = currentIndex <= 0 ? last : currentIndex - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    moveTo(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        accent || outline
          ? fullWidth
            ? "flex gap-2"
            : "flex flex-wrap gap-2"
          : "inline-flex rounded-md bg-[var(--app-subtle-bg)] p-0.5",
        className
      )}
    >
      {options.map((opt, i) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={el => {
              buttonRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={
              testIdPrefix ? `${testIdPrefix}-${opt.value}` : undefined
            }
            onClick={() => onChange(opt.value)}
            onKeyDown={e => handleKeyDown(e, i)}
            className={cn(
              "font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]",
              outline
                ? "rounded border px-2 py-1 text-xs"
                : accent
                  ? "rounded-md px-3 py-2 text-sm"
                  : "rounded px-3 py-1 text-[length:var(--text-body)]",
              (accent || outline) && fullWidth && "flex-1",
              outline
                ? selected
                  ? "border-[var(--app-link)] bg-[var(--app-link)]/10 text-[color:var(--app-fg)]"
                  : "border-[var(--app-border)] text-[color:var(--app-hint)]"
                : accent
                  ? selected
                    ? "bg-[var(--app-link)] text-[color:var(--app-button-text)]"
                    : "bg-[var(--app-secondary-bg)] text-[color:var(--app-fg)] hover:bg-white/10"
                  : selected
                    ? "bg-[var(--app-secondary-bg)] text-[color:var(--app-fg)] shadow-sm"
                    : "text-[color:var(--app-hint)]"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
