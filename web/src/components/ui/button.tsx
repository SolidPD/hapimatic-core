// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { HoverTooltipButton } from "@/components/ui/tooltip";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90",
        secondary:
          "bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:opacity-90",
        outline:
          "border border-[var(--app-border)] bg-transparent hover:bg-[var(--app-subtle-bg)]",
        // #3031 Task 3 — token-backed destructive (was raw `bg-red-600 text-white`).
        // `bg-destructive` maps the `--destructive` token via `@theme inline`;
        // `text-foreground` maps `--foreground`, replacing the raw `text-white`.
        destructive: "bg-destructive text-foreground hover:bg-destructive/90",
        // #3337 Sub C — the dense icon-action color treatment. Transparent surface
        // with a hint→fg color transition on hover (the `p-1.5 rounded-full` pattern
        // the SessionList/header icon buttons hand-rolled). Per-state (error/success)
        // and per-surface (branded white-on-header) colors are call-site `className`
        // overrides — `cn`/twMerge resolves them over these base classes.
        ghost:
          "bg-transparent text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)]",
        // #3338 Sub C — the settings accent-fill (Save buttons + the selected state
        // of the settings radio-rows). Mint fill via the `--app-link` token (which
        // resolves through the `--palette-accent` swap chain — never the `#5ae6ab`
        // literal), paired with `--app-button-text`. Matches the SegmentedToggle
        // `accent-filled` selected segment (#3339).
        accent:
          "bg-[var(--app-link)] text-[var(--app-button-text)] hover:opacity-90",
        // #3396 Task 2 — hover-neutral surface for the bare-glyph icon-glyph cohort
        // (expand chevrons, etc.). Ghost's REST colors (`bg-transparent
        // text-[var(--app-hint)]`) with NO hover utilities at all. That cohort relies
        // on ghost's rest text and pins hover back to it (fully hover-inert), so a
        // colors-free bare variant would visibly regress it; omitting hover treatment
        // achieves what those two cancellation classes do today, with nothing to
        // cancel. Compose with `size="bare"` (the box neutralizer) at call sites.
        ghostStatic: "bg-transparent text-[var(--app-hint)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3",
        lg: "h-10 rounded-md px-8",
        // #3337 Sub C — the dense icon button. A square box sized by the
        // `--icon-btn-size` token (32px; `decision-density-sizing.md` `icon-btn` row)
        // and fully rounded. `rounded-full` overrides the base `rounded-md` (twMerge);
        // the base `inline-flex items-center justify-center` centers the icon child.
        // Icon-only — the caller MUST pass `aria-label`.
        icon: "size-[var(--icon-btn-size)] rounded-full p-0",
        // #3338 Sub C — settings-surface dense controls.
        // `dense`: the rectangular Save-style button — `px-2 py-1 text-xs`, content
        //   height (deliberately NO `--control-*` step; the base `rounded-md` stays).
        // `denseSquare`: the fixed 36px square stepper (the A−/A+ text-scale controls).
        //   `size-9` = h-9 w-9; `p-0` drops the default text padding; `font-semibold`
        //   for the glyph. Its `hover:bg-white/10` is the settings brighten-on-hover
        //   — distinct from `secondary`'s dim-on-hover; `hover:opacity-100` cancels the
        //   paired variant's `hover:opacity-90` (twMerge later-wins) so ONLY the
        //   background brightens. Intended with `variant="secondary"`.
        dense: "px-2 py-1 text-xs",
        denseSquare:
          "size-9 p-0 font-semibold hover:bg-white/10 hover:opacity-100",
        // #3396 Task 2 — the box neutralizer for bare-glyph buttons. A SIZE-axis entry
        // (NOT a variant): a variant-axis "bare" is silently defeated by
        // `defaultVariants.size` — cva emits variant classes BEFORE size classes, so the
        // default size's `h-9 px-4 py-2` lands after the neutralizers (twMerge drops the
        // earlier `h-auto`, and the retained `p-0` loses to `.px-4`/`.py-2` in stylesheet
        // order). In the size slot nothing later conflicts: `h-auto` drops the fixed
        // control height, `rounded-none` the corner radius, `p-0` all padding. Keep
        // `justify-start` OUT (layout-specific to full-width toggles — a call-site
        // `className`). Compose with a color variant (e.g. `variant="ghost" size="bare"`;
        // `size="bare"` alone still inherits the default variant's colors).
        bare: "h-auto rounded-none p-0",
      },
      // #3396 Task 3 — tooltip-preserving disabled affordance (RULED D3a: approach A).
      // An ORTHOGONAL opt-in (composable with EVERY variant/size — the disabled+title
      // cohort spans accent/secondary/ghost treatments — so NOT a variant value).
      // The base's `disabled:pointer-events-none` (line 7) suppresses hover, so a
      // disabled `Button` shows no native `title` tooltip. Declared AFTER `size` so its
      // `disabled:pointer-events-auto` emits after the base class → twMerge later-wins,
      // restoring hover (→ the native tooltip) WITHOUT re-enabling activation: a native
      // `<button disabled>` blocks click/focus regardless of pointer-events.
      // `disabled:cursor-not-allowed` keeps the disabled affordance visible. A11y caveat:
      // disabled buttons aren't focusable, so keyboard users still won't get the tooltip
      // — exact parity with the raw-`<button>` cohort's current behavior (lossless, not a
      // regression); touch gets tooltips under neither approach.
      tooltipOnDisabled: {
        true: "disabled:pointer-events-auto disabled:cursor-not-allowed",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * `Button` — the primary action primitive. A `cva`-driven `<button>` (or any
 * element via `asChild`) with variant + size axes, reading all colors from the
 * design tokens (#1977 A1 / #3030 B). Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: one interactive element — `<button>`, or the child element when
 *   `asChild` (Radix `Slot`) is set.
 * - **Props / API**: native `<button>` attributes + `variant`, `size`, `asChild`,
 *   and the orthogonal `tooltipOnDisabled` opt-in (#3396).
 * - **Variants**: `default` (app-button surface) · `secondary` · `outline` ·
 *   `destructive` (token-backed `bg-destructive`, #3031 Task 3) · `ghost`
 *   (transparent surface, `--app-hint`→`--app-fg` hover — the dense icon-action
 *   treatment, #3337 Sub C) · `accent` (mint `--app-link` fill + `--app-button-text`
 *   — the settings Save/primary-action + radio-row-selected treatment, #3338 Sub C) ·
 *   `ghostStatic` (ghost's rest colors `bg-transparent text-[var(--app-hint)]` with NO
 *   hover treatment — the hover-inert surface for the bare-glyph icon cohort; compose
 *   with `size="bare"`; #3396).
 * - **Sizes**: `sm` (h-8) · `default` (h-9) · `lg` (h-10) — the control-height
 *   ladder named by `--control-sm/md/lg` — plus `icon` (square `--icon-btn-size`,
 *   `rounded-full` — the dense icon button, #3337 Sub C), `dense` (`px-2 py-1 text-xs`
 *   rectangular Save-style, content-height), `denseSquare` (36px `size-9` square
 *   stepper with a `hover:bg-white/10` brighten-hover — the A−/A+ text-scale controls,
 *   pair with `variant="secondary"`; #3338 Sub C) and `bare` (`h-auto rounded-none
 *   p-0` — the box neutralizer for bare-glyph buttons; a SIZE-axis entry because a
 *   variant-axis "bare" is defeated by the default size; add `justify-start` at the
 *   call site for full-width toggles; #3396).
 * - **States**: hover (opacity/tint), `focus-visible` ring (`--app-link`),
 *   `disabled` (pointer-events-none + 50% opacity). The `tooltipOnDisabled` opt-in
 *   (#3396) swaps `disabled:pointer-events-auto disabled:cursor-not-allowed` in so a
 *   disabled button still surfaces its tooltip on hover — activation stays blocked,
 *   opacity unchanged. With `tooltipOnDisabled` + `title`, a disabled `Button`
 *   renders focusable-but-inert (`aria-disabled="true"`, no `disabled` attribute)
 *   as a `HoverTooltipButton` — the Slot-free tooltip trigger (#3462, ruling c1) —
 *   so keyboard and touch users get the explanation; every `disabled:*` utility
 *   keeps firing on the `aria-disabled` element via the `@custom-variant disabled`
 *   declared in `web/src/index.css`. Focus survives the inert ⇄ enabled swap.
 * - **A11y**: native `<button>` keyboard semantics (Enter/Space activation, focus
 *   ring). With `asChild`, the child MUST supply role + accessible name; icon-only
 *   buttons (`size="icon"`) MUST pass `aria-label`. `tooltipOnDisabled` (#3396)
 *   restores the disabled-state hover tooltip WITHOUT re-enabling activation. With a
 *   `title` as well (#3462, approach B): the inert button is in the tab order, opens
 *   the accessible tooltip on focus/hover (tap-to-reveal on a coarse pointer, with
 *   `aria-describedby` while open) and never activates — the consumer `onClick` is
 *   not attached, Enter/Space are prevented, `type` is forced to `"button"`, and the
 *   `title` attribute is dropped (the tooltip carries it; an icon-only button keeps
 *   its accessible name through an `aria-label` fallback). Without a `title`, or
 *   with `asChild`, the disabled path is unchanged (native `disabled`, not focusable).
 * - **Tokens**: `--app-button` / `--app-button-text`, `--app-secondary-bg`,
 *   `--app-fg`, `--app-border`, `--app-subtle-bg`, `--destructive` / `--foreground`
 *   (via `bg-destructive` / `text-foreground`), focus `--app-link`; `ghost`/`icon`
 *   add `--app-hint`, `--app-hover`, `--icon-btn-size`; `accent` uses `--app-link`
 *   as the fill (not only focus).
 */
/**
 * Mirrors the accessible-name algorithm's "name from content" step: does the
 * children tree render any text? (Strings/numbers, recursing through element
 * children.) Used by the #3462 inert path to decide whether dropping `title`
 * would leave the button unnamed.
 */
function hasRenderedText(node: React.ReactNode): boolean {
  if (typeof node === "string") return node.trim().length > 0;
  if (typeof node === "number") return true;
  if (Array.isArray(node)) return node.some(hasRenderedText);
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return hasRenderedText(node.props.children);
  }
  return false;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, tooltipOnDisabled, asChild = false, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    const classes = cn(
      buttonVariants({ variant, size, tooltipOnDisabled, className })
    );
    // #3462 (RULED D1c = c1) — the tooltip-preserving disabled path auto-upgrades
    // to approach B: when a NATIVE button is disabled AND opted into
    // `tooltipOnDisabled` AND carries a `title`, render it focusable-but-inert
    // (`aria-disabled`, no `disabled` attribute) as a `HoverTooltipButton` so
    // keyboard and touch users get the explanation. Every other path — not
    // disabled, disabled without the opt-in, disabled + opt-in without a `title`,
    // and `asChild` (the child owns its element) — renders byte-identical DOM to
    // pre-#3462.
    const inert =
      !asChild && Boolean(props.disabled && tooltipOnDisabled && props.title);

    // Focus preservation across the inert ⇄ enabled swap (#3462 review finding):
    // the two branches return different root element types, so React remounts the
    // DOM node whenever `disabled` flips on a `tooltipOnDisabled` button. A native
    // disabled button also drops focus, but the inert one is IN the tab order — so
    // remember whether this control had focus and hand it to the new node. Only
    // `tooltipOnDisabled` buttons can swap, so only they carry the tracking handlers.
    const nodeRef = React.useRef<HTMLButtonElement | null>(null);
    const hadFocusRef = React.useRef(false);
    const composedRef = React.useCallback(
      (node: HTMLButtonElement | null) => {
        nodeRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref]
    );
    React.useLayoutEffect(() => {
      if (hadFocusRef.current && nodeRef.current) nodeRef.current.focus();
    }, [inert]);
    const { onFocus, onBlur } = props;
    const focusTracking = tooltipOnDisabled
      ? {
          onFocus: (event: React.FocusEvent<HTMLButtonElement>) => {
            hadFocusRef.current = true;
            onFocus?.(event);
          },
          onBlur: (event: React.FocusEvent<HTMLButtonElement>) => {
            hadFocusRef.current = false;
            onBlur?.(event);
          },
        }
      : undefined;

    if (!inert) {
      return (
        <Comp
          className={classes}
          ref={composedRef}
          {...props}
          {...focusTracking}
        />
      );
    }
    // The c1 guard contract (directive Task B2, expert finding 3462-4):
    //  1. DOM — `aria-disabled="true"`; `disabled` and `title` are OMITTED (the
    //     tooltip carries the text — no double tooltip on desktop); `type` is
    //     forced to "button" so a stray click can never submit a form. Because the
    //     native name algorithm falls back to `title` when the content has no text,
    //     an icon-only button keeps its name via an `aria-label` fallback (a
    //     consumer `aria-label` / `aria-labelledby` always wins).
    //  2. The consumer `onClick` is never invoked while inert (not attached). Other
    //     handlers (pointer/mouse/focus) pass through unchanged.
    //  3. The click is NOT preventDefault'd and NOT stopPropagation'd — Radix's
    //     Popover trigger composes its `onOpenToggle` AFTER our handler and skips
    //     the toggle on a defaultPrevented event, so preventing here would make the
    //     tap-to-reveal unable to open. Rule 1 + rule 2 already make the click
    //     harmless.
    //  4. keydown Enter/Space and keyup Space are prevented (Space activates on
    //     keyup in browsers — belt and braces); other keys pass through. On a coarse
    //     pointer `HoverTooltipButton` reads that prevented keydown as "toggle the
    //     bubble", so keyboard users on touch devices can still reveal it.
    //  5. Classes unchanged — the `disabled:*` utilities (this base's `opacity-50`,
    //     the opt-in's `pointer-events-auto cursor-not-allowed`, and every call-site
    //     override such as `disabled:opacity-100` / `disabled:opacity-30`) keep
    //     firing on the `aria-disabled` element via the `@custom-variant disabled`
    //     declared in `web/src/index.css` (R11).
    const {
      disabled: _disabled,
      title,
      onClick: _onClick,
      onKeyDown,
      onKeyUp,
      onFocus: _onFocus,
      onBlur: _onBlur,
      type: _type,
      "aria-label": ariaLabel,
      ...inertProps
    } = props;
    const ariaLabelFallback =
      ariaLabel ??
      (props["aria-labelledby"] || hasRenderedText(props.children)
        ? undefined
        : title);
    // `HoverTooltipButton` renders the Radix Trigger AS this button (no `Slot`), so
    // the composed ref stays memoized and no commit-phase state churn reaches the
    // host page — the #3462 render-loop finding (see tooltip.tsx's header note).
    return (
      <HoverTooltipButton
        content={title}
        className={classes}
        ref={composedRef}
        {...inertProps}
        {...focusTracking}
        aria-label={ariaLabelFallback}
        type="button"
        aria-disabled="true"
        onKeyDown={event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            return;
          }
          onKeyDown?.(event);
        }}
        onKeyUp={event => {
          if (event.key === " ") {
            event.preventDefault();
            return;
          }
          onKeyUp?.(event);
        }}
      />
    );
  }
);
Button.displayName = "Button";
