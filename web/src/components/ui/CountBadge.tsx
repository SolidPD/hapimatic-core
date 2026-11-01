// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@/lib/utils";

/** The default cap: counts above it render as `99+`. */
export const COUNT_BADGE_MAX = 99;

export interface CountBadgeProps {
  /** The count to show (floored). Below 1, negative or non-finite renders nothing. */
  count: number;
  /**
   * Counts above this render as `<max>+`. Defaults to `COUNT_BADGE_MAX` (99);
   * a non-finite or < 1 value falls back to the default.
   */
  max?: number;
  /**
   * Screen-reader text for the badge. When set, the badge is exposed as
   * `role="img"` with this accessible name. When absent the badge is
   * `aria-hidden` and the CALLER carries the count in its own accessible name
   * (e.g. a button's `aria-label`), so it is announced once.
   */
  label?: string;
  /** Positioning (e.g. `relative top-0.5 -ml-2` in an `inline-flex items-end` icon wrapper). */
  className?: string;
}

/**
 * `CountBadge` — a small red (`--destructive`) circle with a white count, overlaid on an
 * icon to signal unread or pending items (issue #2913: the footer feedback
 * envelope; #3277: the header gear's update count). Contract:
 * `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: a single `<span>` circle; it widens into a pill for 2–3 chars.
 * - **Props / API**: `count`, `max?`, `label?`, `className?`. No variants, no
 *   size axis.
 * - **States**: static. Renders nothing when the floored count is `<= 0`;
 *   `<max>+` above `max`.
 * - **A11y**: `aria-hidden` by default; with `label`, `role="img"` +
 *   `aria-label={label}`.
 * - **Tokens**: `--destructive` (via the `bg-destructive` utility — white text on
 *   it passes WCAG AA, ~4.8:1; operator ruling F2:1), `--text-caption-xs`.
 *
 * Distinct from `Badge` (a bordered label pill with no overlay use) and from
 * `SessionCountBadge` (the four-count session-status breakdown).
 */
export function CountBadge({ count, max, label, className }: CountBadgeProps) {
  // Floor first, so a fractional count below 1 renders nothing rather than "0".
  const n = Math.floor(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  const cap =
    max !== undefined && Number.isFinite(max) && max >= 1
      ? Math.floor(max)
      : COUNT_BADGE_MAX;
  const text = n > cap ? `${cap}+` : `${n}`;
  const a11y = label
    ? { role: "img" as const, "aria-label": label }
    : { "aria-hidden": true as const };
  return (
    <span
      {...a11y}
      data-testid="count-badge"
      className={cn(
        "pointer-events-none inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-destructive px-0.5 text-[length:var(--text-caption-xs)] font-semibold leading-none tabular-nums text-white",
        className
      )}
    >
      {text}
    </span>
  );
}
