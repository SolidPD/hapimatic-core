// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

/**
 * `Tooltip` family — a Radix Tooltip wrapper (the hover / keyboard-focus hint
 * bubble) plus two composed helpers, `HoverTooltip` (wraps an arbitrary trigger
 * element) and `HoverTooltipButton` (IS the trigger button), both of which fall
 * back to a tap-to-reveal Radix Popover on coarse pointers. Wraps
 * `@radix-ui/react-tooltip` and `@radix-ui/react-popover`; never reimplements
 * either. Added by #3462 — the a11y-complete approach-B follow-up to #3396's
 * `tooltipOnDisabled` (approach A). Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: `TooltipProvider` · `TooltipRoot` (the Radix Root — deliberately
 *   NOT exported as `Tooltip`, which `NewSession/FormField.tsx` already exports as
 *   its click-to-toggle info bubble) · `TooltipTrigger` · `TooltipContent`
 *   (portal + positioned bubble) · `HoverTooltip` (composed: one child element as
 *   the trigger via `asChild`) · `HoverTooltipButton` (composed: a native button
 *   that is itself the trigger — the shape `Button` consumes for the
 *   disabled+tooltip case).
 * - **Props / API**: Radix props on the split parts. `HoverTooltip` takes `content`
 *   (the bubble text/node), exactly one `children` element (rendered as the trigger
 *   via `asChild`), `side` (default `"top"`), `delayDuration` (hover open delay in ms,
 *   default 300 — tests pass `0`) and `className` (bubble). `HoverTooltipButton`
 *   takes `content` / `side` / `delayDuration` / `tooltipClassName` plus every native
 *   button attribute (+ `ref`), which land on the trigger button itself.
 * - **Variants / sizes**: none — one dense `text-xs` surface; override via `className`.
 * - **States**: open/closed (`data-[state]` — Radix Tooltip reports
 *   `delayed-open` / `instant-open` / `closed`; the Popover branch `open` / `closed`).
 * - **A11y** (APG: Tooltip): reveals on hover AND on keyboard focus, dismisses on
 *   Escape; the trigger carries `aria-describedby` → the tooltip text ONLY while open
 *   (Radix wiring; `role="tooltip"` lives on the visually-hidden clone Radix renders
 *   beside the visible bubble). On a coarse pointer — `(hover: none)`, evaluated once
 *   per mount like `usePlatform()` — hover/focus never fire, so both helpers render a
 *   controlled Radix Popover instead: tap toggles (the opening tap is consumed — it
 *   never activates the trigger), Escape / pointer-down outside / scroll dismiss, focus
 *   never moves (`onOpenAutoFocus` + `onCloseAutoFocus` prevented), the bubble carries
 *   `role="tooltip"` and the trigger gets `aria-describedby` while open.
 * - **Why two helpers (the #3462 render-loop finding)**: Radix `Slot` recomposes the
 *   trigger's ref callback on EVERY render, and Radix Tooltip stores its trigger node
 *   in React STATE (`setTrigger`), so an `asChild` trigger schedules sync
 *   `setTrigger(null)` / `setTrigger(node)` updates from every commit. That churn is
 *   normally absorbed, but it turns any latent effect-driven re-render loop in the
 *   host page into a hard "Maximum update depth exceeded" crash (the New Session page
 *   did exactly that). `HoverTooltipButton` renders the Radix Trigger AS the button —
 *   no `Slot`, a memoized composed ref, no commit-phase state churn — and is what
 *   `Button` uses for all 58 cohort controls. `HoverTooltip` keeps the standard
 *   `asChild` composition for arbitrary children (catalog specimens, ad-hoc use).
 * - **Tokens**: `--app-border`, `--app-secondary-bg`, `--app-fg` (the `dialog.tsx`
 *   surface trio); `z-50` so the bubble stacks above an open `Dialog`.
 * - **Provider**: per-instance — both helpers mount their own `TooltipProvider`, so
 *   no app-root provider is required (and `main.tsx` is untouched).
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const TooltipRoot = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

/** The bubble surface — `dialog.tsx`'s `--app-*` trio, dense `text-xs`, `z-50`. */
const tooltipSurfaceClass =
  "z-50 max-w-xs rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 text-xs text-[var(--app-fg)] shadow-md";

/**
 * Enter/exit motion (tw-animate-css). Unconditional `animate-in` on mount because
 * Radix Tooltip's open states are `delayed-open` / `instant-open`, never `open`.
 */
const tooltipMotionClass =
  "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";

export const TooltipContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(tooltipSurfaceClass, tooltipMotionClass, className)}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

type TooltipSide = "top" | "right" | "bottom" | "left";

export interface HoverTooltipProps {
  /** The bubble text/node — becomes the trigger's description while open. */
  content: React.ReactNode;
  /** Exactly one element that accepts a ref + event props (rendered via `asChild`). */
  children: React.ReactElement;
  /** Bubble placement relative to the trigger. */
  side?: TooltipSide;
  /** Hover-open delay in ms (tooltip branch only). Tests pass `0`. */
  delayDuration?: number;
  /** Extra classes merged onto the bubble surface. */
  className?: string;
}

/** Coarse-pointer media query — devices with no hover-capable primary pointer. */
const COARSE_POINTER_QUERY = "(hover: none)";

/**
 * Evaluated once per mount (the `usePlatform()` / `AppShell` `matchMedia`
 * precedent). jsdom's `matchMedia` is stubbed by `src/test/setup.ts`; tests that
 * exercise the touch branch override the stub so this query matches.
 */
function useIsCoarsePointer(): boolean {
  const [isCoarsePointer] = React.useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(COARSE_POINTER_QUERY).matches
  );
  return isCoarsePointer;
}

/**
 * Dismiss the tap-to-reveal bubble on scroll — a capture-phase `window` listener
 * held only while open (Popover lacks the scroll listener Tooltip has).
 */
function useDismissOnScroll(open: boolean, close: () => void): void {
  React.useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [open, close]);
}

/**
 * Controlled open state shared by both tap-to-reveal branches: the bubble's
 * `open` flag, the `aria-describedby` target id, and the scroll dismissal.
 */
function useTapTooltipState() {
  const [open, setOpen] = React.useState(false);
  const descriptionId = React.useId();
  const close = React.useCallback(() => setOpen(false), []);
  useDismissOnScroll(open, close);
  return { open, setOpen, descriptionId };
}

/**
 * A tooltip trigger is not a popup button (APG: Tooltip) — spread AFTER the
 * consumer props to drop the dialog-popover semantics Radix stamps on its
 * Popover Trigger (`aria-haspopup="dialog"`, `aria-expanded`, `aria-controls`).
 */
const tapTriggerAriaOverrides = {
  "aria-haspopup": undefined,
  "aria-expanded": undefined,
  "aria-controls": undefined,
} as const;

/** The Popover-branch bubble: portaled, `role="tooltip"`, never takes focus. */
function TapTooltipContent({
  side,
  className,
  descriptionId,
  children,
}: {
  side: TooltipSide;
  className?: string;
  descriptionId: string;
  children: React.ReactNode;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        role="tooltip"
        side={side}
        sideOffset={4}
        onOpenAutoFocus={event => event.preventDefault()}
        onCloseAutoFocus={event => event.preventDefault()}
        className={cn(tooltipSurfaceClass, tooltipMotionClass, className)}
      >
        <span id={descriptionId}>{children}</span>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

/**
 * `HoverTooltip` — the composed helper for an arbitrary trigger element: a
 * hover/focus Radix Tooltip around one child (`asChild`), swapping to a
 * tap-to-reveal Radix Popover on a coarse pointer. For a trigger that IS a native
 * button (the `Button` integration) prefer `HoverTooltipButton` — see the
 * render-loop note in the file header.
 */
export function HoverTooltip({
  content,
  children,
  side = "top",
  delayDuration = 300,
  className,
}: HoverTooltipProps) {
  const isCoarsePointer = useIsCoarsePointer();
  if (isCoarsePointer) {
    return (
      <TapTooltip content={content} side={side} className={className}>
        {children}
      </TapTooltip>
    );
  }
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <TooltipRoot>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side} className={className}>
          {content}
        </TooltipContent>
      </TooltipRoot>
    </TooltipProvider>
  );
}

/**
 * The coarse-pointer branch of `HoverTooltip` (ruling D1b = b1): a CONTROLLED
 * Radix Popover whose trigger is the child. Tap toggles — Radix composes the
 * trigger's `onClick` with `onOpenToggle` and skips the toggle when the event is
 * `defaultPrevented`, which is why `Button`'s inert guard must never
 * `preventDefault` the click. Escape and pointer-down outside dismiss via Radix's
 * `DismissableLayer`; scroll dismisses via `useDismissOnScroll`.
 */
function TapTooltip({
  content,
  children,
  side = "top",
  className,
}: Omit<HoverTooltipProps, "delayDuration">) {
  const { open, setOpen, descriptionId } = useTapTooltipState();
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        asChild
        {...tapTriggerAriaOverrides}
        aria-describedby={open ? descriptionId : undefined}
      >
        {children}
      </PopoverPrimitive.Trigger>
      <TapTooltipContent
        side={side}
        className={className}
        descriptionId={descriptionId}
      >
        {content}
      </TapTooltipContent>
    </PopoverPrimitive.Root>
  );
}

export interface HoverTooltipButtonProps
  // `content` is also a (string) HTML attribute — omit it so the bubble prop wins.
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "content"> {
  /** The bubble text/node — becomes the button's description while open. */
  content: React.ReactNode;
  /** Bubble placement relative to the button. */
  side?: TooltipSide;
  /** Hover-open delay in ms (tooltip branch only). Tests pass `0`. */
  delayDuration?: number;
  /** Extra classes merged onto the bubble surface (NOT the button). */
  tooltipClassName?: string;
}

/**
 * `HoverTooltipButton` — a native button that IS the tooltip trigger. Renders the
 * Radix Trigger directly (no `Slot`), so the composed ref is memoized and no
 * commit-phase state churn reaches the host page (the #3462 render-loop finding).
 * Every native button attribute (+ `ref`) lands on the button; `Button` consumes
 * this for the disabled + `tooltipOnDisabled` + `title` case (ruling c1).
 */
export const HoverTooltipButton = React.forwardRef<
  HTMLButtonElement,
  HoverTooltipButtonProps
>(
  (
    { content, side = "top", delayDuration = 300, tooltipClassName, ...button },
    ref
  ) => {
    const isCoarsePointer = useIsCoarsePointer();
    if (isCoarsePointer) {
      return (
        <TapTooltipButton
          ref={ref}
          content={content}
          side={side}
          tooltipClassName={tooltipClassName}
          {...button}
        />
      );
    }
    return (
      <TooltipProvider delayDuration={delayDuration}>
        <TooltipRoot>
          <TooltipPrimitive.Trigger ref={ref} {...button} />
          <TooltipContent side={side} className={tooltipClassName}>
            {content}
          </TooltipContent>
        </TooltipRoot>
      </TooltipProvider>
    );
  }
);
HoverTooltipButton.displayName = "HoverTooltipButton";

/** The coarse-pointer branch of `HoverTooltipButton` — the Popover Trigger IS the button. */
const TapTooltipButton = React.forwardRef<
  HTMLButtonElement,
  Omit<HoverTooltipButtonProps, "delayDuration">
>(({ content, side = "top", tooltipClassName, ...button }, ref) => {
  const { open, setOpen, descriptionId } = useTapTooltipState();
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger
        ref={ref}
        {...button}
        {...tapTriggerAriaOverrides}
        aria-describedby={open ? descriptionId : undefined}
        onKeyDown={event => {
          button.onKeyDown?.(event);
          // Keyboard reveal on a coarse pointer: an enabled button lets Enter/Space
          // produce a native click that Radix toggles on. `Button`'s inert guard
          // prevents that click — so when the consumer handler prevented the key,
          // toggle the bubble here instead (a keyboard user on iPad + keyboard, or
          // switch access, can still read why the control is disabled).
          if (
            (event.key === "Enter" || event.key === " ") &&
            event.defaultPrevented
          ) {
            setOpen(previous => !previous);
          }
        }}
      />
      <TapTooltipContent
        side={side}
        className={tooltipClassName}
        descriptionId={descriptionId}
      >
        {content}
      </TapTooltipContent>
    </PopoverPrimitive.Root>
  );
});
TapTooltipButton.displayName = "TapTooltipButton";
