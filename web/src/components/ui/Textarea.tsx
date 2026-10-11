// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `Textarea` — the base multi-line text-input primitive: a native `<textarea>`
 * styled with the design tokens (#1977 A1 / #3030 B). Wraps the native accessible
 * element (never reimplements it). Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: a single native `<textarea>`.
 * - **Props / API**: all native `<textarea>` attributes + `ref`. Supply an
 *   accessible name via `aria-label` or an associated `<label htmlFor>`.
 * - **Variants / sizes**: none — a `min-h-16` floor that grows with `rows` /
 *   content; size via `className`.
 * - **States**: default · focus-visible ring (`--app-link`) · disabled
 *   (not-allowed cursor + 50% opacity) · placeholder (`--app-hint`).
 * - **A11y**: native `<textarea>` keyboard semantics; the CALLER must give it an
 *   accessible name (`aria-label` / `<label>`).
 * - **Tokens**: `--app-border`, `--app-fg`, `--app-hint`, focus `--app-link`.
 */
export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-16 w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-2 text-sm text-[var(--app-fg)] transition-colors placeholder:text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = "Textarea";
