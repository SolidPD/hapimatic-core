// SPDX-License-Identifier: AGPL-3.0-only
import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const inputVariants = cva(
  // Shared across every variant: type ramp, focus ring, transition, placeholder,
  // and disabled treatment. Variant strings own only the surface/border/geometry.
  "text-sm text-[var(--app-fg)] transition-colors placeholder:text-[var(--app-hint)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        // The original bordered full-width control (`h-9`, the `--control-md` step).
        // Byte-identical to the pre-#3338 base so every existing `<Input>` is unchanged.
        default:
          "flex h-9 w-full rounded-md border border-[var(--app-border)] bg-transparent px-3 py-1",
        // #3338 Sub C — the settings borderless-dense number/input treatment
        // (per-node max-concurrency + reasoning/narration preview-line inputs). No
        // border, a filled `--app-secondary-bg` surface, tighter `px-2 py-1`, and
        // content-height (no `h-9`, no `w-full`). Width (`w-16`/`w-20`) and extras
        // (`tabular-nums`) are call-site `className`; the shared focus ring/disabled
        // styling above still applies (an a11y improvement over the hand-rolled input).
        borderlessDense: "rounded-md bg-[var(--app-secondary-bg)] px-2 py-1",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

/**
 * `Input` — the base text-input primitive: a native `<input>` styled with the
 * design tokens (#1977 A1 / #3030 B). Wraps the native accessible element (never
 * reimplements it), so it is keyboard-operable and labelable by construction.
 * Contract: `docs/design/design-system/primitives.md`.
 *
 * - **Anatomy**: a single native `<input>`.
 * - **Props / API**: all native `<input>` attributes + `ref` + `variant`. Supply an
 *   accessible name via `aria-label` or an associated `<label htmlFor>` (this base
 *   primitive is unopinionated about which).
 * - **Variants**: `default` (bordered, `h-9`, the `--control-md` step) ·
 *   `borderlessDense` (borderless, filled `--app-secondary-bg`, `px-2 py-1`,
 *   content-height — the settings inline-number treatment, #3338 Sub C). No size
 *   axis; width/size via `className`.
 * - **States**: default · focus-visible ring (`--app-link`) · disabled
 *   (not-allowed cursor + 50% opacity) · placeholder (`--app-hint`).
 * - **A11y**: native `<input>` keyboard semantics; the CALLER must give it an
 *   accessible name (`aria-label` / `<label>`).
 * - **Tokens**: `--app-border`, `--app-fg`, `--app-hint`, focus `--app-link`;
 *   `borderlessDense` adds `--app-secondary-bg` (surface).
 *
 * Distinct from `SearchInput` (a specialized search composite with a magnifier +
 * clear button). Prefer `Input` for general text entry.
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement> &
  VariantProps<typeof inputVariants>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", variant, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(inputVariants({ variant }), className)}
      {...props}
    />
  )
);
Input.displayName = "Input";
