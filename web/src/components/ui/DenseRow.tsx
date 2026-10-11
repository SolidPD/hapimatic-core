// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * DenseRow — a compact key/value list row for the shared design-system dense-list
 * atoms (A3 / #1979). Generalizes the inline `InfoRow` in routes/settings/about.tsx by
 * adding a leading-icon slot and an optional trailing slot (a StatusDot or Badge).
 * Consumed by #1983 (About rows) and A4 page migrations.
 *
 * Layout: leading icon + label (left, muted) with the right-aligned value on a single
 * row; an optional `trailing` node sits in the value cluster.
 *
 * CONSISTENT HEIGHT (locked contract): the row height does NOT change whether `icon`
 * or `trailing` are present. This rests on `items-center` plus fixed-size boxes — the
 * icon renders in a fixed h-4 w-4 box, and a trailing Badge (~22px) / StatusDot (8px)
 * is <= the value line-height (~22.5px). jsdom cannot assert pixel heights, so the
 * guarantee is structural rather than test-asserted.
 *
 * DENSITY: `py-[var(--row-padding-y)]` (6px normal, driven by useDensity) intentionally
 * halves InfoRow's fixed `py-3` (12px) — #1983's About migration will visibly tighten
 * rows. This is intended density behavior.
 */
export interface DenseRowProps {
  /** Optional leading icon, rendered in a fixed h-4 w-4 box inheriting --app-hint. */
  icon?: ReactNode;
  /** Left-aligned label (muted). */
  label: ReactNode;
  /** Right-aligned value. */
  value?: ReactNode;
  /** Optional trailing node in the value cluster — a StatusDot or Badge. */
  trailing?: ReactNode;
  className?: string;
  testId?: string;
}

export function DenseRow({
  icon,
  label,
  value,
  trailing,
  className,
  testId,
}: DenseRowProps) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex items-center justify-between gap-3 border-b border-[var(--app-border)] px-4 py-[var(--row-padding-y)]",
        className
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon != null && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-hint)]">
            {icon}
          </span>
        )}
        <span className="truncate text-[length:var(--text-body)] text-[var(--app-hint)]">
          {label}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {value != null && (
          // #3031 Task 4 — ANNOTATED EXCEPTION: B's type scale tops at
          // --text-label-strong (14px); no 15px token exists. Mapping to 14px
          // would alter rendering (R5 behavior-preservation), so this stays
          // an arbitrary value. See docs/design/design-system/primitives.md.
          <span className="text-right text-[15px] text-[var(--app-fg)]">
            {value}
          </span>
        )}
        {trailing}
      </div>
    </div>
  );
}
