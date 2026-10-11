// SPDX-License-Identifier: AGPL-3.0-only
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * StatusDot — the simple 3-variant health dot (ok / warn / hot) for the shared
 * design-system dense-list atoms (A3 / #1979). Consumed by Epic B (#1982 Session
 * Metadata, #1983 About) and A4 page migrations.
 *
 * Deliberately distinct from the rich session-status dot (`getStatusDotClass` /
 * `StatusDotPopover`, which carries violet/blue/orange runtime states) — that one
 * stays as-is. StatusDot maps ONLY to the A1 status-token triad, no literal hex:
 *   ok   -> --app-badge-success-text (green)
 *   warn -> --app-badge-warning-text (amber)
 *   hot  -> --app-badge-error-text   (red)
 *
 * Published conventions for downstream consumers (locked prop-API contract):
 * - Pulse: pass `className="animate-pulse"` at the call site (e.g. #1982's active
 *   open->ok treatment; precedent `RecoveryStatusBadge.tsx`). A `pulse?` prop is a
 *   reserved future ADDITIVE extension — not built now.
 * - Unknown/absent status: callers render NO dot (per #1983 K2). A `dimmed` variant
 *   is a future additive option — not built now.
 */
const statusDotVariants = cva("inline-block shrink-0 rounded-full", {
  variants: {
    status: {
      ok: "bg-[var(--app-badge-success-text)]",
      warn: "bg-[var(--app-badge-warning-text)]",
      hot: "bg-[var(--app-badge-error-text)]",
    },
    size: {
      sm: "h-2 w-2",
      md: "h-2.5 w-2.5",
    },
  },
  defaultVariants: {
    size: "sm",
  },
});

export type StatusDotVariant = NonNullable<
  VariantProps<typeof statusDotVariants>["status"]
>;

export interface StatusDotProps {
  /** Health state — the published-once enum (ok / warn / hot). */
  status: StatusDotVariant;
  /** Dot diameter. Defaults to `sm` (8px). */
  size?: "sm" | "md";
  /** Accessible label. Defaults to the `status` string. */
  label?: string;
  className?: string;
}

export function StatusDot({
  status,
  size = "sm",
  label,
  className,
}: StatusDotProps) {
  return (
    <span
      role="img"
      aria-label={label ?? status}
      className={cn(statusDotVariants({ status, size }), className)}
    />
  );
}
