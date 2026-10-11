// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * `SettingsRow` — a settings list-item: a label (+ optional description) on the
 * left and an interactive control on the right (composite, #3032 Sub D). The
 * interactive sibling of the read-only `DenseRow` primitive; the settings surfaces
 * hand-roll this `justify-between` label↔control row across 6+ files. Contract:
 * `docs/design/design-system/composites.md`.
 *
 * Boundary: `SettingsRow` is a *settings list-item* (label+description ↔ a trailing
 * toggle/switch/select/button governing a setting). For a labelled editable form
 * input with hint/error use `FormField`; for a read-only key/value row use the
 * `DenseRow` primitive. A `FormField`/control may sit in the `control` slot.
 *
 * - **Anatomy**: a `flex-col` wrapper → a `justify-between` row (`<label>` when
 *   `asLabel`, else `<div>`) holding the label `<span>` + `control` → optional
 *   description `<p>` below.
 * - **Props / API**: `label`, `control` (trailing), `description?`, `asLabel?`
 *   (wrap the row in `<label>` for implicit native-input association — set this
 *   when `control` is a native `<input>`/`<Checkbox>` so a tap on the label toggles
 *   it), `disabled?` (dims + de-emphasizes the row), `className?`.
 * - **Composes**: any control primitive (`Checkbox`, a toggle `Button`, `Select`).
 * - **A11y**: with `asLabel`, the wrapping `<label>` associates a tap on the label
 *   text with the enclosed control; without it, the `control` must carry its own
 *   accessible name (e.g. a toggle `<button aria-label>`). WAI-ARIA: the control's
 *   own role/keyboard semantics are unchanged.
 * - **Tokens**: `--text-label-strong` (label), `--text-body-dense` (description),
 *   `--app-fg` / `--app-hint`.
 */
export interface SettingsRowProps {
  /** Left-aligned setting label. */
  label: ReactNode;
  /** Trailing interactive control (toggle / switch / select / button). */
  control: ReactNode;
  /** Optional description below the row (muted). */
  description?: ReactNode;
  /** Wrap the row in `<label>` for implicit native-input association. */
  asLabel?: boolean;
  /** Dim + de-emphasize (and, when `asLabel`, drop the pointer cursor). */
  disabled?: boolean;
  className?: string;
}

export function SettingsRow({
  label,
  control,
  description,
  asLabel = false,
  disabled = false,
  className,
}: SettingsRowProps) {
  const rowClass = cn(
    "flex items-center justify-between gap-3",
    asLabel && (disabled ? "cursor-default opacity-60" : "cursor-pointer"),
    !asLabel && disabled && "opacity-60"
  );
  const labelSpan = (
    <span className="text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]">
      {label}
    </span>
  );

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {asLabel ? (
        <label className={rowClass}>
          {labelSpan}
          {control}
        </label>
      ) : (
        <div className={rowClass}>
          {labelSpan}
          {control}
        </div>
      )}
      {description != null && (
        <p className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]">
          {description}
        </p>
      )}
    </div>
  );
}
