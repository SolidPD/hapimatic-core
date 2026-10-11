// SPDX-License-Identifier: AGPL-3.0-only
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import type { FederationNodeHealthStatus } from "@hapi/protocol";
import { severityToColor, severityToLabel } from "./federationHealthColors";

/**
 * FederationStatusDot — the design-system dot for the FIVE-state federation health
 * domain (healthy / degraded / warning / critical / offline), promoted from the
 * recurring `severityToColor` inline-dot exception (issue #3342, epic #3028).
 *
 * Deliberately a SIBLING of `@/components/ui/StatusDot`, NOT a replacement: `StatusDot`
 * is the token-only 3-state atom (ok/warn/hot → A1 status tokens, no literal hex) and
 * stays as-is. This component expresses the federation severity vocabulary, whose colors
 * come from the fixed semantic health palette via `severityToColor` (`getStatusColor`) —
 * a DOCUMENTED literal-hex exception (health colors are semantic, not swappable brand
 * tokens). `offline` renders distinct from `critical` (`offline → gray`, `critical → red`).
 *
 * The color source stays centralized in `federationHealthColors.ts`; this consolidates the
 * previously-duplicated inline dot spans across `FederationNodeCard`, `AggregateHealthHeader`,
 * and `FederationAlertsFeed` into one component.
 */
const SIZE_CLASS = {
  sm: "h-2.5 w-2.5", // 10px — legend / alert dots
  md: "h-3 w-3", // 12px — per-node card dot
  lg: "h-4 w-4", // 16px — aggregate worst-case dot
} as const;

export interface FederationStatusDotProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  "aria-label"
> {
  /** Federation node health status (healthy/degraded/warning/critical/offline). */
  status: FederationNodeHealthStatus;
  /** Dot diameter. Defaults to `md` (12px). */
  size?: keyof typeof SIZE_CLASS;
  /** Accessible label. Defaults to `severityToLabel(status)`. */
  label?: string;
}

export function FederationStatusDot({
  status,
  size = "md",
  label,
  className,
  style,
  ...rest
}: FederationStatusDotProps) {
  return (
    <span
      role="img"
      aria-label={label ?? severityToLabel(status)}
      className={cn(
        "inline-block shrink-0 rounded-full",
        SIZE_CLASS[size],
        className
      )}
      style={{ backgroundColor: severityToColor(status), ...style }}
      {...rest}
    />
  );
}
