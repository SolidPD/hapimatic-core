// SPDX-License-Identifier: AGPL-3.0-only
import type {
  SelectHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";

/**
 * Unified form-control primitives for the Create-Session page (reusable
 * site-wide). ONE fixed height (`h-9`) and ONE border/background/text/focus
 * treatment, so every dropdown, text field, and toggle is visually identical —
 * the standard the rest of the page must draw from instead of hand-copying
 * ad-hoc `<select>`/`<input>` classes (which drifted into three different
 * heights).
 *
 * Font: plain `text-sm`. iOS zoom-on-focus is disabled app-wide by the viewport
 * meta (`maximum-scale=1, user-scalable=no`, `web/index.html`), so NO per-control
 * 16px font hack is needed or wanted.
 */
export const CONTROL_BASE =
  "h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50";

/** Down-chevron drawn for selects + the account field-button (one shared glyph). */
export function ControlChevron({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * Standard dropdown. A native `<select>` with `appearance-none` (native arrow
 * removed) + one shared chevron, so its height matches inputs/buttons exactly
 * instead of inheriting the OS widget's intrinsic height.
 */
export function UiSelect({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`${CONTROL_BASE} appearance-none pl-2.5 pr-8 ${className ?? ""}`}
      >
        {children}
      </select>
      <ControlChevron className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-hint)]" />
    </div>
  );
}

/** Standard single-line text field. */
export function UiInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      autoCapitalize="none"
      {...props}
      className={`${CONTROL_BASE} px-2.5 placeholder:text-[var(--app-hint)] ${className ?? ""}`}
    />
  );
}

/** Standard on/off switch. */
export function UiToggle(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <label className="relative inline-flex h-5 w-9 items-center">
        <input
          type="checkbox"
          checked={props.checked}
          onChange={e => props.onChange(e.target.checked)}
          disabled={props.disabled}
          className="peer sr-only"
        />
        <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-[var(--app-link)] peer-disabled:opacity-50" />
        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
      </label>
      <span className="whitespace-nowrap text-xs text-[var(--app-fg)]">
        {props.checked
          ? (props.onLabel ?? "Enabled")
          : (props.offLabel ?? "Disabled")}
      </span>
    </div>
  );
}
