// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/utils";

/**
 * `ScrollArea` — a Radix ScrollArea wrapper (custom-styled scrollbars).
 * Wraps `@radix-ui/react-scroll-area`; never reimplements it.
 * Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: `ScrollArea` (Root + Viewport + Corner) with `ScrollBar`
 *   (vertical/horizontal thumb).
 * - **Props / API**: Radix props; `ScrollBar` takes `orientation` (default
 *   `vertical`).
 * - **Variants / sizes**: none.
 * - **States**: scrollbar visibility follows Radix hover/scroll state.
 * - **A11y**: native scroll semantics preserved (viewport stays
 *   keyboard-scrollable); scrollbars are presentational.
 * - **Tokens**: `--border` (thumb) — no color hex.
 */
export const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn("relative overflow-hidden", className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

export const ScrollBar = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" &&
        "h-full w-2.5 border-l border-l-transparent p-px",
      orientation === "horizontal" &&
        "h-2.5 flex-col border-t border-t-transparent p-px",
      className
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;
