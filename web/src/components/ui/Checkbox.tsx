// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `Checkbox` — the base boolean-toggle primitive: a native
 * `<input type="checkbox">` tinted with the accent token (#1977 A1 / #3030 B).
 * A styled NATIVE checkbox (not a Radix composition): zero new dependency, fully
 * accessible and keyboard-operable by construction. Contract:
 * `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: a single native `<input type="checkbox">`.
 * - **Props / API**: all native checkbox attributes EXCEPT `type` (fixed) + `ref`,
 *   plus `disabledDim` (see below). Supply an accessible name via `aria-label` or an
 *   associated `<label htmlFor>`.
 * - **Variants / sizes**: none — `h-4 w-4`; size via `className`.
 * - **States**: unchecked / checked (native + `accent-color`) · focus-visible ring
 *   (`--app-link`) · disabled (not-allowed cursor + 50% opacity, the latter opt-out
 *   via `disabledDim={false}` for already-dimmed containers — #3338 Sub C).
 * - **A11y**: native `role="checkbox"` + `Space`-to-toggle keyboard semantics and
 *   `aria-checked` reflected by the native element; the CALLER supplies the name.
 * - **Tokens**: accent tint `--app-accent` (runtime-swappable), `--app-border`,
 *   focus `--app-link`.
 */
export type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type"
> & {
  /**
   * Whether the checkbox self-dims to 50% opacity while `disabled`. Default `true`
   * (the standard disabled treatment). Pass `false` when the checkbox lives inside a
   * container that ALREADY dims on the same disabled condition (e.g. a row whose
   * `<label>` gets `opacity-50`) — self-dimming there would double-dim (#3338 Sub C:
   * the `ApiErrorClassOverrides` composition). Only the checkbox's own opacity is
   * affected; `disabled:cursor-not-allowed` and the native `disabled` semantics stay.
   * @default true
   */
  disabledDim?: boolean;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, disabledDim = true, ...props }, ref) => (
    <input
      ref={ref}
      type="checkbox"
      className={cn(
        "h-4 w-4 shrink-0 rounded border-[var(--app-border)] accent-[var(--app-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed",
        disabledDim && "disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Checkbox.displayName = "Checkbox";
