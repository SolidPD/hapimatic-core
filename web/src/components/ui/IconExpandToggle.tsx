// SPDX-License-Identifier: AGPL-3.0-only
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface IconExpandToggleProps {
  /** Current expanded state (owned by the parent card — this is presentational). */
  expanded: boolean;
  /** Fired when the toggle is activated; the parent flips its own `expanded` state. */
  onToggle: () => void;
  /** Accessible label — callers pass the state-dependent string (`Collapse`/`Expand`). */
  "aria-label": string;
  /** Optional per-call-site test hook; the attribute is omitted when absent. */
  "data-testid"?: string;
}

/**
 * `IconExpandToggle` — the ghost expand-chevron toggle shared by the system-jobs
 * cards (#3421, dedupe of the byte-identical block that repeated 4× across
 * `SystemJobCard.tsx` (SystemJobCard / InProcessLoopCard / OsCronCard) and
 * `LoopCronCard.tsx`). Purely presentational: the `expanded` state stays in the
 * owning card and is passed in; activation is reported through `onToggle`.
 *
 * Renders the verified block unchanged for byte parity with every call-site:
 * a `variant="ghostStatic"` `Button` (`type="button"`, so it never submits) with
 * the `h-8 w-8 flex-shrink-0 p-0 hover:text-[var(--app-hint)]` override wrapping
 * a `ChevronDown` (expanded) / `ChevronRight` (collapsed) glyph.
 *
 * - **Tokens**: inherits `Button`'s `ghostStatic` variant tokens (hover-inert rest
 *   colors, #3464); the retained `hover:text-[var(--app-hint)]` pin keeps the dense
 *   icon-action look byte-identical (OQ7b).
 *   No literal hex, no arbitrary `[Npx]`.
 * - **A11y**: `aria-expanded` is ALWAYS rendered (every call-site set it — required
 *   for parity, not an enhancement); `aria-label` is caller-supplied.
 * - **History**: shipped on `variant="ghost"` + a `hover:bg-transparent` override per
 *   ruling D5a (#3421); moved onto #3396's `ghostStatic` variant by #3464.
 */
export function IconExpandToggle({
  expanded,
  onToggle,
  "aria-label": ariaLabel,
  "data-testid": dataTestid,
}: IconExpandToggleProps) {
  return (
    <Button
      type="button"
      variant="ghostStatic"
      onClick={onToggle}
      aria-label={ariaLabel}
      aria-expanded={expanded}
      data-testid={dataTestid}
      className="h-8 w-8 flex-shrink-0 p-0 hover:text-[var(--app-hint)]"
    >
      {expanded ? (
        <ChevronDown className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
    </Button>
  );
}
