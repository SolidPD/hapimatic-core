// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * RadioRow — a compact row of mutually exclusive choices that can show NOTHING
 * selected (#6606; an extension accepted by the board-26 PM, ruling PM-C-i).
 * It looks like `SegmentedToggle`'s `outline` variant, but where that control
 * always has a value (it makes only the selected segment a tab stop, so with
 * none selected every segment is `tabIndex=-1`, and it cannot go back to
 * unset), a RadioRow starts unset, stays reachable by keyboard, and can be
 * cleared. Use it where "no answer yet" is a real state: a yes/no question in
 * an MCP server's form, where Hapimatic must not preselect anything.
 *
 * Accessibility:
 * - `role="radiogroup"` labelled by the required `ariaLabel`; each option is a
 *   `role="radio"` with `aria-checked`.
 * - Roving tabindex: the selected option is the tab stop; with nothing selected
 *   the FIRST option is. Arrow keys move focus and selection together, wrapping;
 *   Home/End jump; Space or Enter selects the focused option.
 * - `clearable` adds a "Clear" button while a value is selected, which sets the
 *   value back to `null`.
 */
export interface RadioRowOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** The option's hover tooltip; defaults to a string label. */
  title?: string;
}

export interface RadioRowProps<T extends string> {
  options: RadioRowOption<T>[];
  /** The selected value, or null for none. */
  value: T | null;
  onChange: (value: T | null) => void;
  /** Accessible group label — required (this is a radiogroup). */
  ariaLabel: string;
  /** Offer a "Clear" button that sets the value back to null. */
  clearable?: boolean;
  disabled?: boolean;
  /** Wire from `FormField` (hint or error). */
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  className?: string;
}

export function RadioRow<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  clearable = false,
  disabled = false,
  className,
  ...aria
}: RadioRowProps<T>) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = options.findIndex(option => option.value === value);
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  const select = (index: number) => {
    const option = options[index];
    if (!option || disabled) return;
    onChange(option.value);
    refs.current[index]?.focus();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const last = options.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = index >= last ? 0 : index + 1;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = index <= 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case " ":
      case "Enter":
        next = index;
        break;
      default:
        return;
    }
    event.preventDefault();
    select(next);
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        aria-describedby={aria["aria-describedby"]}
        aria-invalid={aria["aria-invalid"]}
        className="flex flex-wrap gap-2"
      >
        {options.map((option, i) => {
          const selected = i === selectedIndex;
          return (
            <Button
              key={option.value}
              variant="outline"
              size="dense"
              ref={el => {
                refs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={i === tabStop ? 0 : -1}
              title={
                option.title ??
                (typeof option.label === "string" ? option.label : undefined)
              }
              disabled={disabled}
              onClick={() => select(i)}
              onKeyDown={event => handleKeyDown(event, i)}
              // SegmentedToggle's `outline` pills on the shared Button.
              className={cn(
                "rounded",
                selected
                  ? "border-[var(--app-link)] bg-[var(--app-link)]/10 text-[color:var(--app-fg)]"
                  : "text-[color:var(--app-hint)]"
              )}
            >
              {option.label}
            </Button>
          );
        })}
      </div>
      {clearable && selectedIndex >= 0 ? (
        <Button
          type="button"
          variant="ghost"
          size="dense"
          title="Clear the answer"
          disabled={disabled}
          onClick={() => onChange(null)}
        >
          Clear
        </Button>
      ) : null}
    </div>
  );
}
