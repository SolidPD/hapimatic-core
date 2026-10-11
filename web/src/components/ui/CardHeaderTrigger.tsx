// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { usePointerFocusRing } from "@/hooks/usePointerFocusRing";
import { cn } from "@/lib/utils";

export type CardHeaderTriggerProps =
  React.ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * `CardHeaderTrigger` — the shared card-header focus-wrapper mounted under a
 * `<DialogTrigger asChild>` (#3500). It consolidates the two prop-identical raw
 * `<button>` wrappers in `DiffView` and `ToolCard` (same `w-full text-left`
 * base, same focus-visible ring, same three `usePointerFocusRing` handlers)
 * into ONE adjudicated `design-tokens-allow` exception — the #3430
 * `CopyButton` "byte-identical inline sites → one composite" precedent.
 * `CliOutputBlock`'s header wrapper is NOT a consumer: it has no ring and no
 * handlers, so folding it in would ADD behaviour that card never had.
 * Contract: `docs/design/design-system/primitives.md` → `CardHeaderTrigger`.
 *
 * - **Anatomy**: a single native `<button type="button">` spanning the card
 *   header (`w-full text-left`); the rich header markup is the caller's
 *   children. It OWNS `usePointerFocusRing`, so the call site needs no handler
 *   composition — `<CardHeaderTrigger>{header}</CardHeaderTrigger>`.
 * - **Props / API**: every native `<button>` attribute; `className` merged
 *   AFTER the base via `cn`; caller `onPointerDown` / `onKeyDown` / `onBlur`
 *   are composed with the ring handlers (hook first, then the caller's — the
 *   same child-then-slot order the raw sites had under the Radix Slot); `ref`
 *   forwarded to the `HTMLButtonElement`.
 * - **Composes**: `usePointerFocusRing` (the pointer-vs-keyboard focus-ring
 *   discriminator). Deliberately NOT a `Button`: its box (bg / hover / height /
 *   `font-medium` / `rounded`) would alter the bare rich header (L6 #3408).
 * - **States**: rest · keyboard-focused (`focus-visible:ring-2` in
 *   `--app-link`) · pointer-focused (ring suppressed via `focus-visible:ring-0`
 *   until the next keydown / blur).
 * - **A11y**: native `<button>` Enter/Space activation; `aria-haspopup="dialog"`
 *   / `aria-expanded` / `aria-controls` / `data-state` and the open-toggle
 *   `onClick` are injected by the `DialogTrigger` Slot through the `{...rest}`
 *   spread — the spread landing on the `<button>` is the load-bearing contract
 *   at both `asChild` sites. The accessible name is the header's text content.
 * - **Tokens**: `--app-link` (focus ring). No literal hex, no arbitrary px.
 */
export const CardHeaderTrigger = React.forwardRef<
  HTMLButtonElement,
  CardHeaderTriggerProps
>(({ className, onPointerDown, onKeyDown, onBlur, ...rest }, ref) => {
  const {
    suppressFocusRing,
    onTriggerPointerDown,
    onTriggerKeyDown,
    onTriggerBlur,
  } = usePointerFocusRing();
  return (
    <button /* design-tokens-allow: CardHeaderTrigger is the shared DialogTrigger card-header focus-wrapper (#3500) — the ONE adjudicated exception replacing the identical DiffView + ToolCard raw wrappers; a <Button> box (bg/hover/height/font-medium/rounded) would alter the bare rich header (L6 #3408) */
      ref={ref}
      type="button"
      className={cn(
        "w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]",
        suppressFocusRing && "focus-visible:ring-0",
        className
      )}
      {...rest}
      onPointerDown={event => {
        onTriggerPointerDown(event);
        onPointerDown?.(event);
      }}
      onKeyDown={event => {
        onTriggerKeyDown(event);
        onKeyDown?.(event);
      }}
      onBlur={event => {
        onTriggerBlur(event);
        onBlur?.(event);
      }}
    />
  );
});
CardHeaderTrigger.displayName = "CardHeaderTrigger";
