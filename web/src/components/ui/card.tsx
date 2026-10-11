// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * `Card` family — a surface container and its slots (`CardHeader`, `CardTitle`,
 * `CardDescription`, `CardContent`). Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: `Card` (rounded surface + shadow) wrapping an optional
 *   `CardHeader` (`CardTitle` + `CardDescription`) and `CardContent`.
 * - **Props / API**: each part forwards native `<div>` / heading attributes + `ref`.
 * - **Variants / sizes**: none — layout comes from composition + `className`.
 * - **States**: static (non-interactive container).
 * - **A11y**: presentational; `CardTitle` renders an `<h3>` — callers ensure the
 *   heading level fits the surrounding document outline.
 * - **Tokens**: `--app-secondary-bg` (surface), `--app-hint` (description).
 */
export const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "rounded-lg bg-[var(--app-secondary-bg)] shadow-sm",
      className
    )}
    {...props}
  />
));
Card.displayName = "Card";

export const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("flex flex-col space-y-1.5 p-4", className)}
    {...props}
  />
));
CardHeader.displayName = "CardHeader";

export const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn(
      "text-base font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
));
CardTitle.displayName = "CardTitle";

export const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn("text-sm text-[var(--app-hint)]", className)}
    {...props}
  />
));
CardDescription.displayName = "CardDescription";

export const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn("p-4 pt-0", className)} {...props} />
));
CardContent.displayName = "CardContent";
