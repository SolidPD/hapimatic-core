// SPDX-License-Identifier: AGPL-3.0-only
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The wiring a `FormField` hands to its control via render-prop, so the control is
 * correctly labelled and described without the caller managing ids by hand.
 */
export interface FormFieldControlProps {
  /** Wire onto the control's `id` so the `<label htmlFor>` associates. */
  id: string;
  /** Wire onto the control's `aria-describedby` (points at the hint or error). */
  "aria-describedby": string | undefined;
  /** `true` while an `error` is shown — wire onto the control's `aria-invalid`. */
  "aria-invalid": boolean | undefined;
}

/**
 * `FormField` — a labelled form control with hint/error messaging (composite, #3032
 * Sub D). Pairs a `<label htmlFor>` with a control (any of C's `Input` / `Select` /
 * `Checkbox` / `Textarea` / `SearchInput`) and wires `aria-describedby` +
 * `aria-invalid` so the accessibility contract is correct by construction. There are
 * 60 hand-rolled `<label>` + control pairs across 33 files today. Contract:
 * `docs/design/design-system/composites.md`.
 *
 * Boundary: `FormField` is a *form input* (editable control + validation messaging).
 * For a settings list-row (label+description ↔ a toggle/switch governing a setting)
 * use `SettingsRow`; for a read-only key/value row use the `DenseRow` primitive.
 *
 * - **Anatomy**: a `flex-col` (or inline) wrapper → `<label htmlFor>` → control
 *   (via render-prop) → an error `<p>` (when `error`) else a hint `<p>` (when `hint`).
 * - **Props / API**: `label`, `children` (render-prop receiving `{ id,
 *   aria-describedby, aria-invalid }`), `hint?`, `error?` (replaces the hint +
 *   marks the field invalid), `required?`, `layout?` (`stacked` default | `inline`
 *   — label left, control right), `htmlFor?` (explicit id; else `useId()`),
 *   `className?`.
 * - **Composes**: C's control primitives via the render-prop.
 * - **A11y**: `<label htmlFor>` names the control; `aria-describedby` points at the
 *   hint or error; `aria-invalid` is set while an error shows. WAI-ARIA:
 *   the native control's own semantics are preserved (this only labels/describes).
 * - **Tokens**: `--text-label-strong` (label), `--text-body-dense` (hint/error),
 *   `--app-fg` / `--app-hint` / `--app-badge-error-text`.
 */
export interface FormFieldProps {
  /** Field label — rendered as `<label htmlFor>`. */
  label: ReactNode;
  /** Render the control; receives id + aria wiring to spread onto it. */
  children: (control: FormFieldControlProps) => ReactNode;
  /** Optional helper text (shown when there is no `error`). */
  hint?: ReactNode;
  /** Error message — replaces the hint and marks the control invalid. */
  error?: ReactNode;
  /** Appends a "*" required marker to the label. */
  required?: boolean;
  /** `stacked` (default, label above) or `inline` (label left, control right). */
  layout?: "stacked" | "inline";
  /** Explicit control id (defaults to a generated `useId()`). */
  htmlFor?: string;
  className?: string;
}

export function FormField({
  label,
  children,
  hint,
  error,
  required = false,
  layout = "stacked",
  htmlFor,
  className,
}: FormFieldProps) {
  const autoId = useId();
  const id = htmlFor ?? autoId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    error != null ? errorId : hint != null ? hintId : undefined;
  const control = children({
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error != null ? true : undefined,
  });

  const labelEl = (
    <label
      htmlFor={id}
      className="text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]"
    >
      {label}
      {required && (
        <span aria-hidden="true" className="text-[var(--app-badge-error-text)]">
          {" *"}
        </span>
      )}
    </label>
  );

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {layout === "inline" ? (
        <div className="flex items-center justify-between gap-3">
          {labelEl}
          {control}
        </div>
      ) : (
        <>
          {labelEl}
          {control}
        </>
      )}
      {error != null ? (
        <p
          id={errorId}
          className="text-[length:var(--text-body-dense)] text-[var(--app-badge-error-text)]"
        >
          {error}
        </p>
      ) : hint != null ? (
        <p
          id={hintId}
          className="text-[length:var(--text-body-dense)] text-[var(--app-hint)]"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}
