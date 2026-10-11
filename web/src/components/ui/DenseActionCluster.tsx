// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * `DenseActionCluster` — the horizontal group of equal-sized icon buttons that
 * fills a dense action bar (composite, #3032 Sub D). Encodes the shared gap +
 * alignment so a run of icon buttons reads as one unit; the app hand-rolls this
 * `flex items-center gap-[var(--icon-btn-gap)]` wrapper in `StatusBar` (7-button bar),
 * `ComposerButtons` (3-button composer group), `SessionNotes`, and more. Contract:
 * `docs/design/design-system/composites.md`.
 *
 * A layout shell for the icon-button run — it does NOT restyle its children (each
 * button keeps its own square `rounded-full` chrome). Pair with
 * `Button variant="ghost" size="icon"` (the dense icon button, #3337 Sub C) or
 * `TouchButton` (touch-first) children.
 *
 * - **Anatomy**: a single `flex items-center gap-[var(--icon-btn-gap)]` row wrapping
 *   its icon-button children.
 * - **Props / API**: `children` (the icon buttons), `aria-label?` (when set, the
 *   cluster becomes a labelled `role="group"`), `className?` (e.g. `shrink-0`, or a
 *   `gap-*` override for a looser cluster).
 * - **Composes**: `Button variant="ghost" size="icon"` (the dense icon button, #3337 Sub C)
 *   or `TouchButton` (touch-first) children.
 * - **A11y**: a plain layout shell by default; pass `aria-label` to expose it as a
 *   named `role="group"` (WAI-ARIA group) when the buttons form a meaningful set.
 *   Each child button supplies its own accessible name.
 * - **Tokens**: `--icon-btn-gap` (the app-shell icon-grid gap); colors come from
 *   the child buttons.
 */
export interface DenseActionClusterProps {
  /** The icon buttons that make up the cluster. */
  children: ReactNode;
  /** When set, exposes the cluster as a named `role="group"`. */
  "aria-label"?: string;
  /** Extra classes (e.g. `shrink-0`, or a `gap-*` override). */
  className?: string;
}

export function DenseActionCluster({
  children,
  "aria-label": ariaLabel,
  className,
}: DenseActionClusterProps) {
  return (
    <div
      role={ariaLabel != null ? "group" : undefined}
      aria-label={ariaLabel}
      className={cn("flex items-center gap-[var(--icon-btn-gap)]", className)}
    >
      {children}
    </div>
  );
}
