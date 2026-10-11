// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { Button, type ButtonProps } from "@/components/ui/button";

/**
 * Props for `BareButton`: every `ButtonProps` field EXCEPT the three pinned legs
 * (`variant`, `size`, `tooltipOnDisabled`) and `asChild`. Omitting them makes
 * the triple unsettable at the type level, so no call site can silently diverge
 * from the canonical spelling (#3499 R5).
 */
export type BareButtonProps = Omit<
  ButtonProps,
  "variant" | "size" | "tooltipOnDisabled" | "asChild"
>;

/**
 * `BareButton` — the canonical shorthand for the `Button` triple
 * `variant="ghostStatic" size="bare" tooltipOnDisabled` (#3499). It is a thin
 * `forwardRef` wrapper that pins those three props and contributes **zero
 * classes of its own**: the caller's `className` reaches `Button` unmodified,
 * so the rendered `className` is byte-identical to the explicit triple *by
 * construction* (the same `buttonVariants({...})` call receives the same
 * arguments). Contract: `docs/design/design-system/composites.md`.
 *
 * The triple's meaning is mechanical, not iconographic: "a `Button` that
 * imposes no box and no hover — a neutral canvas the call site styles entirely
 * — and keeps its tooltip while disabled." The cohort it replaces spans icon
 * glyphs, full-width text rows, bordered chips, form-control rows, floating
 * action buttons, tabs and a `role="switch"` toggle.
 *
 * - **Anatomy**: a single `Button` with `variant="ghostStatic"`, `size="bare"`
 *   and `tooltipOnDisabled` pinned AFTER the prop spread. No wrapper element,
 *   no own classes, no `className` default.
 * - **Props / API**: `Omit<ButtonProps, "variant" | "size" | "tooltipOnDisabled"
 *   | "asChild">`. `className` is passed through unmodified; `ref` is forwarded
 *   to the `HTMLButtonElement`; `type`, `onClick`, `onMouseDown`, `disabled`,
 *   `title`, `role`, `aria-*`, `data-*` and `children` are forwarded unchanged.
 *   `type` is deliberately NOT defaulted — the migrated sites that omit it keep
 *   omitting it, so the rendered DOM stays byte-for-byte what the triple gave.
 * - **Composes**: the `Button` primitive only.
 * - **States**: rest · disabled (native) · disabled + truthy `title`
 *   (focusable-but-inert, see A11y). Hover is inert by design (`ghostStatic`).
 * - **A11y**: native `<button>` semantics. The disabled-tooltip affordance is
 *   DELEGATED to `Button`'s `tooltipOnDisabled` prop, never inlined as literal
 *   classes, so #3462's landed c1 auto-upgrade (`button.tsx`, the `inert` guard)
 *   flows through without touching this file: with `disabled` AND a truthy
 *   `title`, `Button` renders the control focusable-but-inert
 *   (`aria-disabled="true"`, no `disabled`/`title` attributes, `type` forced
 *   `"button"`, consumer `onClick` not attached) as a `HoverTooltipButton`. With
 *   a falsy `title` it falls back to native `disabled` exactly as the raw triple
 *   does — this shorthand cannot enforce the truthy-`title` condition; keeping
 *   `title` alongside `disabled` stays the caller's job.
 * - **Tokens**: inherited from `ghostStatic` (`--app-hint` rest text) and the
 *   `Button` base focus ring (`--app-link`). The composite adds none.
 * - **Placement**: entirely caller-supplied via `className` (the call site owns
 *   the whole box — size, radius, border, color overrides).
 * - **Exemplar**: `web/src/components/AssistantChat/StatusBar.tsx` (the densest
 *   consumer).
 *
 * Do NOT "simplify" any of the following — each is load-bearing:
 * 1. No `cn(...)`, no base classes, no `className` default (R1/R2 byte-identity).
 * 2. The three props are pinned AFTER `{...props}` so a stray spread cannot
 *    override them; the `Omit` makes that a type error as well.
 * 3. `forwardRef` is mandatory — `EmojiPickerPopover` passes a trigger `ref`.
 * 4. `type="button"` is NOT defaulted (DOM parity at the sites that omit it).
 * 5. `asChild` is omitted too: `Button` skips the #3462 inert path for `asChild`,
 *    so an `asChild` caller would compile and silently lose the upgrade the
 *    third leg exists for.
 */
export const BareButton = React.forwardRef<HTMLButtonElement, BareButtonProps>(
  (props, ref) => (
    <Button
      {...props}
      ref={ref}
      variant="ghostStatic"
      size="bare"
      tooltipOnDisabled
    />
  )
);
BareButton.displayName = "BareButton";
