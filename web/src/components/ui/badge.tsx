// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
  {
    variants: {
      variant: {
        default:
          "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)]",
        warning:
          "border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] text-[var(--app-badge-warning-text)]",
        success:
          "border-[var(--app-badge-success-border)] bg-[var(--app-badge-success-bg)] text-[var(--app-badge-success-text)]",
        destructive:
          "border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] text-[var(--app-badge-error-text)]",
        // A3 (#1979) — additive variants for the shared design-system atoms.
        // `mint`: an accent pill for highlight/active plan labels. `subscription`:
        // a quiet secondary pill for plan/subscription labels, using muted
        // --app-hint text so it reads distinctly from `default` (which is --app-fg).
        // `subscription` is the canonical name for the secondary variant (the epic's
        // "subscription/secondary" — `secondary` is not aliased here since ui/button.tsx
        // already owns a `secondary` variant).
        mint: "border-[var(--app-accent)]/40 bg-[var(--app-accent)]/15 text-[var(--app-accent)]",
        subscription:
          "border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[var(--app-hint)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/**
 * `Badge` — a small non-interactive status/label pill (`cva`-driven `<div>`).
 * Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: a single `<div>` pill (rounded-full, border + tinted bg).
 * - **Props / API**: native `<div>` attributes + `variant`.
 * - **Variants**: `default` · `warning` · `success` · `destructive` (badge-error
 *   tokens) · `mint` (accent) · `subscription` (quiet secondary). No size axis.
 * - **States**: static — non-interactive (no hover/focus/disabled).
 * - **A11y**: decorative by default; when the badge conveys status not otherwise
 *   present in text, the CALLER supplies an accessible label (adjacent text or
 *   `aria-label`).
 * - **Tokens**: `--app-border`, `--app-subtle-bg`, `--app-fg`, `--app-hint`,
 *   `--app-accent`, and the `--app-badge-{warning,success,error}-*` families.
 */
export function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}
