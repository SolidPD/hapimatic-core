// SPDX-License-Identifier: AGPL-3.0-only
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { VerdictColor } from "@/types/harnessUpdates";

/**
 * Maps the shared `VerdictColor` (#1772) to a theme-correct `Badge` variant — no
 * custom component or CSS needed (KD-3): green=beneficial, orange=warning,
 * red=must-investigate, gray=neutral.
 */
const VARIANT_BY_COLOR: Record<
  VerdictColor,
  "success" | "warning" | "destructive" | "default"
> = {
  green: "success",
  orange: "warning",
  red: "destructive",
  gray: "default",
};

/** The default one-word verdict shown when no explicit `label` is passed. */
const LABEL_BY_COLOR: Record<VerdictColor, string> = {
  green: "Beneficial",
  orange: "Warning",
  red: "Investigate",
  gray: "Neutral",
};

/**
 * The color-coded impact chip (epic #1769 Sub-Issue D, issue #1773 — R3). `Badge`
 * is already `inline-flex`, so it sits inline with text; callers must still place
 * it inside a `<div>`/`<span>` (never a `<p>`) since `Badge` renders a `<div>`
 * (OR-4).
 */
export function ImpactColorChip({
  color,
  label,
  className,
}: {
  color: VerdictColor;
  label?: string;
  className?: string;
}) {
  return (
    <Badge
      variant={VARIANT_BY_COLOR[color]}
      className={cn("whitespace-nowrap", className)}
      data-testid={`impact-chip-${color}`}
    >
      {label ?? LABEL_BY_COLOR[color]}
    </Badge>
  );
}
