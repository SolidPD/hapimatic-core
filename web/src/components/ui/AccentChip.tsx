// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * AccentChip — the 8×8 rounded-square accent chip: an icon (or any node) centered
 * on a square tinted with an accent color at 15% alpha. The shared primitive
 * behind the standalone settings accent chips (Sign-Out, Notifications, #3399),
 * generalizing the chip that `TitleChip`
 * (`components/settings/SettingsSectionHeader.tsx`) encapsulates for the page-title
 * context.
 *
 * Unlike `TitleChip` — which is title-context-specific (it forces a `LucideIcon`
 * and colors it internally from the sidebar registry) — `AccentChip` is
 * content-agnostic: the caller supplies the icon (or any node) as `children` and
 * owns its color, so the same chip serves any accent surface. `TitleChip` is now
 * re-expressed on top of this (#3471, the DRY follow-up over the 22 title sites) —
 * it delegates this decorative shell while still forcing and colouring its own
 * `LucideIcon` internally.
 *
 * Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: a single decorative `<span>` — `h-8 w-8`, `rounded-md`,
 *   accent-tinted background.
 * - **Props / API**: `accent` (a CSS color — a token `var(--…)` or a literal) +
 *   `children` (the icon or node to center) + optional `className`, merged (via
 *   `cn`) onto the fixed 8×8 base for placement (margins / positioning). The caller
 *   deliberately passes the accent BOTH here (chip tint) and on the child icon
 *   (`style={{ color: accent }}`) — the primitive is icon-agnostic and does not
 *   colour its children, so the two are not redundant.
 * - **A11y**: `aria-hidden` — the chip is decorative; the accessible name comes
 *   from the caller's adjacent text or `aria-label` (matches the `TitleChip` shape).
 * - **Tokens**: the caller-supplied `accent` (e.g. `var(--accent-red-500)`); the
 *   15% `color-mix` alpha ≙ the old `0x26` hex suffix (#3355/#3356/#3358 lineage).
 */
export function AccentChip({
  accent,
  children,
  className,
}: {
  accent: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md",
        className
      )}
      style={{
        backgroundColor: `color-mix(in srgb, ${accent} 15%, transparent)` /* 15% alpha ≙ old 0x26 suffix; var()-safe (#3355/#3356/#3358) */,
      }}
    >
      {children}
    </span>
  );
}
