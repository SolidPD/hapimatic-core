// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StatePanelVariant = "empty" | "error" | "loading";

/**
 * `StatePanel` — the shared empty / error / loading presentation (composite, #3032
 * Sub D; satisfies R4). Replaces the ~40 ad-hoc centered "Nothing here / Something
 * went wrong / Loading…" blocks with one contract: an optional icon, a title, an
 * optional description, and an optional action slot. Contract:
 * `docs/design/design-system/composites.md`.
 *
 * - **Anatomy**: a centered `flex-col` column → optional icon → title `<p>` →
 *   optional description `<p>` → optional `action` slot.
 * - **Props / API**: `variant` (`empty` | `error` | `loading`, default `empty`),
 *   `icon?`, `title`, `description?`, `action?`, `tone?` (title emphasis; defaults
 *   `muted` for empty/loading, `default` for error), `className?` (root passthrough
 *   — e.g. `flex-1` / `h-full` to fill), `testId?`.
 * - **Composes**: any icon + action primitives the caller supplies (e.g. `Button`,
 *   a router `Link`).
 * - **Variants / States**: `empty` (no role — a static region) · `error`
 *   (`role="alert"`) · `loading` (`role="status"` + `aria-busy`).
 * - **A11y**: `error` announces via `role="alert"`; `loading` via `role="status"` +
 *   `aria-busy`; `empty` is presentational (matches the ad-hoc sites it replaces —
 *   they had no live-region role). The icon is `aria-hidden` (decorative); the title
 *   carries the meaning.
 * - **Tokens**: `--text-label-strong` (title), `--text-body` (description),
 *   `--app-fg` / `--app-hint` (foreground vs muted). Layout-only spacing utilities.
 */
export interface StatePanelProps {
  /** empty (default) · error · loading — drives role/aria + default title tone. */
  variant?: StatePanelVariant;
  /** Optional leading icon (rendered muted + `aria-hidden`). */
  icon?: ReactNode;
  /** The state's headline. */
  title: ReactNode;
  /** Optional supporting description (muted, `max-w-sm`). */
  description?: ReactNode;
  /** Optional action slot (a `Button` / `Link`). */
  action?: ReactNode;
  /** Title emphasis. Defaults: `muted` for empty/loading, `default` for error. */
  tone?: "default" | "muted";
  /** Root passthrough (e.g. `flex-1`, `h-full`, override padding). */
  className?: string;
  testId?: string;
}

export function StatePanel({
  variant = "empty",
  icon,
  title,
  description,
  action,
  tone,
  className,
  testId,
}: StatePanelProps) {
  const role =
    variant === "error"
      ? "alert"
      : variant === "loading"
        ? "status"
        : undefined;
  const resolvedTone = tone ?? (variant === "error" ? "default" : "muted");
  return (
    <div
      role={role}
      aria-busy={variant === "loading" ? true : undefined}
      data-variant={variant}
      data-testid={testId}
      className={cn(
        "flex flex-col items-center justify-center gap-3 p-6 text-center",
        className
      )}
    >
      {icon != null && (
        <span className="text-[var(--app-hint)]" aria-hidden="true">
          {icon}
        </span>
      )}
      {/* Size + color tokens are kept in a plain string (never through `cn`),
          because twMerge classifies both `text-[var(...)]` utilities as text-color
          and would drop the font-size token — the design-system convention (see
          DenseRow/KVGrid). */}
      <p
        className={
          resolvedTone === "muted"
            ? "text-[length:var(--text-label-strong)] text-[var(--app-hint)]"
            : "text-[length:var(--text-label-strong)] font-medium text-[var(--app-fg)]"
        }
      >
        {title}
      </p>
      {description != null && (
        <p className="max-w-sm text-[length:var(--text-body)] text-[var(--app-hint)]">
          {description}
        </p>
      )}
      {action}
    </div>
  );
}
