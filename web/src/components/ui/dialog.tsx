// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

/**
 * `Dialog` family — a Radix Dialog wrapper (focus-trapped modal) with
 * iOS-keyboard-aware positioning. Wraps `@radix-ui/react-dialog`; never
 * reimplements it. Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: `Dialog` (Root) · `DialogTrigger` · `DialogContent` (portal +
 *   overlay + panel) · `DialogHeader` / `DialogTitle` / `DialogDescription` ·
 *   `DialogClose`.
 * - **Props / API**: Radix props; `DialogContent` adds `fullscreen`,
 *   `heightVariant="threeQuarter"`, `disableKeyboardReposition`, `hideCloseButton`,
 *   `description` (sr-only convenience).
 * - **Variants / sizes**: centered (default `max-w-lg`) · `threeQuarter`
 *   (`max-w-2xl`, ~75vh) · `fullscreen`.
 * - **States**: open/closed (`data-[state]`); keyboard-aware `top` + height.
 * - **A11y**: Radix focus trap + `Escape` close + `aria-modal`. MUST include a
 *   `DialogTitle` and a description (render one or pass `description`) or Radix
 *   warns; `DialogClose` carries `aria-label="Close"`.
 * - **Tokens**: `--app-secondary-bg`, `--app-border`, `--app-hint`, `--app-fg`,
 *   `--app-subtle-bg`; overlay `bg-black/50`.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

/**
 * Hook that tracks the visual viewport offset caused by the iOS virtual keyboard.
 * Returns a CSS top value that centers the modal within the visible viewport area.
 */
function useKeyboardAwareTop() {
  const [top, setTop] = React.useState("50%");

  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const update = () => {
      const keyboardHeight = window.innerHeight - vv.height;
      if (keyboardHeight > 50) {
        // Keyboard is open — center within the visible area
        // vv.offsetTop accounts for any scroll, vv.height is the visible height
        const visibleCenter = vv.offsetTop + vv.height / 2;
        setTop(`${visibleCenter}px`);
      } else {
        // Keyboard closed — use normal centering
        setTop("50%");
      }
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  return top;
}

/**
 * Hook that returns the visual viewport height as a CSS value.
 * When the iOS keyboard opens, the visual viewport shrinks — this hook
 * tracks that so fullscreen dialogs can stop at the keyboard's top edge
 * instead of extending behind it.
 */
function useVisualViewportHeight() {
  const [height, setHeight] = React.useState("100%");
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  React.useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    // Debounce viewport height updates to avoid re-renders during iOS
    // selection handle drags — minor viewport jitter would otherwise
    // trigger dialog subtree re-renders mid-gesture.
    const update = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const newHeight = `${vv.height}px`;
        setHeight(prev => (prev === newHeight ? prev : newHeight));
      }, 100);
    };

    // Set initial value immediately (no debounce for first render)
    setHeight(`${vv.height}px`);

    vv.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return height;
}

export const DialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    disableKeyboardReposition?: boolean;
    fullscreen?: boolean;
    /**
     * Issue #1617: a centered modal sized to ~75% of the visible viewport
     * height (NOT fullscreen). Widens to `max-w-2xl` and clamps its height to
     * `min(75vh, calc(visualViewportHeight - 24px))` so it stays fully visible
     * above the iOS on-screen keyboard, keeping the keyboard-aware `top`
     * centering. Ignored when `fullscreen` is set.
     */
    heightVariant?: "threeQuarter";
    hideCloseButton?: boolean;
    /**
     * Optional accessibility-only description (issue #3049). When supplied with
     * meaningful content, the wrapper renders a single visually-hidden
     * (`sr-only`) `DialogDescription` after `children`, letting Radix own the
     * generated description id and the content's `aria-describedby` linkage —
     * this clears the `Missing Description for DialogContent` warning without
     * imposing any visible layout. It is a convenience path only: callers who
     * need a *visible* description keep rendering a `DialogDescription`
     * explicitly in their child layout. There is intentionally no automatic
     * fallback — when `description` is absent, the wrapper renders nothing, so
     * a call site must always declare an explicit description policy.
     */
    description?: React.ReactNode;
  }
>(
  (
    {
      className,
      style,
      disableKeyboardReposition,
      fullscreen,
      heightVariant,
      hideCloseButton,
      description,
      children,
      ...props
    },
    ref
  ) => {
    const keyboardTop = useKeyboardAwareTop();
    const top = disableKeyboardReposition ? "50%" : keyboardTop;
    const viewportHeight = useVisualViewportHeight();

    const isThreeQuarter = !fullscreen && heightVariant === "threeQuarter";
    const baseClasses = fullscreen
      ? "fixed left-0 top-0 right-0 z-50 bg-[var(--app-secondary-bg)] shadow-2xl"
      : cn(
          "fixed left-1/2 z-50 w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-4 shadow-2xl transition-[top] duration-200 ease-out",
          isThreeQuarter ? "max-w-2xl" : "max-w-lg"
        );

    const mergedStyle = fullscreen
      ? {
          height: viewportHeight,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          paddingRight: "env(safe-area-inset-right)",
          ...style,
        }
      : isThreeQuarter
        ? {
            top,
            // 75vh normally; clamp to the visible viewport (minus a small
            // margin) when the iOS keyboard shrinks it. `viewportHeight` is a px
            // string, so CSS min() handles the vh/px mix. The keyboard-aware
            // `top` keeps it centered within the visible area (#1617).
            height: `min(75vh, calc(${viewportHeight} - 24px))`,
            ...style,
          }
        : { top, ...style };

    return (
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 bg-black/50" />
        <DialogPrimitive.Content
          ref={ref}
          className={cn(baseClasses, className)}
          style={mergedStyle}
          {...props}
        >
          {children}
          {description ? (
            <DialogDescription className="sr-only">
              {description}
            </DialogDescription>
          ) : null}
          {!fullscreen && !hideCloseButton ? (
            <DialogClose aria-label="Close" />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    );
  }
);
DialogContent.displayName = "DialogContent";

export const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
);

export const DialogTitle = React.forwardRef<
  HTMLHeadingElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-base font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

export const DialogDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-[var(--app-hint)]", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export const DialogClose = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Close>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Close
    ref={ref}
    aria-label="Close"
    className={cn(
      "absolute right-3 top-3 rounded-full p-1.5 text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)] transition-colors",
      className
    )}
    {...props}
  >
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </DialogPrimitive.Close>
));
DialogClose.displayName = "DialogClose";
