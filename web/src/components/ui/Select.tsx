// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `Select` — the base single-choice dropdown primitive: a native `<select>`
 * styled with the design tokens (#1977 A1 / #3030 B). A styled NATIVE select
 * (not a Radix composition): drop-in for the app's existing `<select>` sites,
 * zero new dependency, and fully accessible by construction. If a future consumer
 * needs a fully custom-styled listbox, wrap the present `@radix-ui/react-select`
 * dep then (recorded YAGNI in `primitives.md`). Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: a native `<select>` with caller-supplied `<option>` children.
 * - **Props / API**: all native `<select>` attributes + `ref` + `children`. Supply
 *   an accessible name via `aria-label` or an associated `<label htmlFor>`.
 * - **Variants / sizes**: none — one control-height (`h-9`); size via `className`.
 * - **States**: default · focus-visible ring (`--app-link`) · disabled
 *   (not-allowed cursor + 50% opacity).
 * - **A11y**: native `<select>` keyboard semantics (arrow keys, typeahead, native
 *   popup); the CALLER must give it an accessible name.
 * - **Tokens**: `--app-border`, `--app-secondary-bg`, `--app-fg`, focus `--app-link`.
 */
export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-1 text-sm text-[var(--app-fg)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";
