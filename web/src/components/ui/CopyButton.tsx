// SPDX-License-Identifier: AGPL-3.0-only
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";
import { CopyIcon, CheckIcon } from "@/components/icons";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CopyButtonProps extends Omit<
  ButtonProps,
  "onClick" | "children"
> {
  /** The string copied to the clipboard on click (required). */
  text: string;
  /** Class for the Copy/Check glyph. Defaults to the shared `h-3.5 w-3.5`. */
  iconClassName?: string;
  /**
   * Class applied ONLY to the copied-state `CheckIcon`. Defaults to
   * `iconClassName`, so by default the rest and copied glyphs share one class; a
   * caller can pass e.g. `text-[var(--app-success)]` to tint the check without
   * tinting the rest-state `CopyIcon`.
   */
  copiedIconClassName?: string;
  /**
   * `title` presented while in the copied state. Defaults to the rest-state
   * `title`. Swaps the `title` ONLY — the accessible name (`aria-label`, when a
   * caller passes one) stays static across the copy.
   */
  copiedTitle?: string;
  /**
   * Called after each copy attempt with the result. `useCopyToClipboard` toasts on
   * FAILURE only, so a caller that wants a success toast passes
   * `onCopied={ok => ok && showToast("Copied!")}`.
   */
  onCopied?: (ok: boolean) => void;
}

/**
 * `CopyButton` — the shared copy control: a ghost `Button` (variant overridable)
 * wrapping `useCopyToClipboard()`, showing the `CopyIcon` glyph that swaps to
 * `CheckIcon` on a successful copy. Unifies the four byte-identical inline copy
 * buttons (CodeBlock, markdown CodeHeader, UserMessage, AssistantMessage) that all
 * shared the same hook, glyphs, and `h-auto rounded p-1 hover:bg-[var(--app-subtle-bg)]`
 * base (#3430). Contract: `docs/design/design-system/composites.md`.
 *
 * - **Anatomy**: a `Button` (`variant` — default `ghost`, overridable;
 *   `type="button"`) → `CopyIcon` / `CheckIcon` (from `@/components/icons` — NOT
 *   `components/ui/icons.tsx`, whose same-named glyphs differ), sized by
 *   `iconClassName` (copied glyph by `copiedIconClassName`, defaulting to it).
 * - **Props / API**: `text` (required, the copied string) · `iconClassName?`
 *   (default `h-3.5 w-3.5`) · `copiedIconClassName?` (default = `iconClassName`,
 *   copied glyph only) · `copiedTitle?` (default = `title`, swaps title only) ·
 *   `onCopied?(ok)` (post-copy callback) + the forwarded subset of `ButtonProps`
 *   (`Omit<ButtonProps, "onClick" | "children">`): `variant` (default `"ghost"`
 *   via `variant ?? "ghost"`, overridable — pass `variant="ghostStatic" size="bare"
 *   tooltipOnDisabled` for the icon-cohort triple), `size`, `tooltipOnDisabled`,
 *   `title` (default `"Copy"`), `aria-label`, `data-testid`, `disabled`, etc. spread
 *   onto the `Button`; `className` merged AFTER the base for placement (R3).
 * - **Composes**: the `Button` primitive + the `CopyIcon`/`CheckIcon` glyphs.
 * - **States**: rest (`CopyIcon`) · copied (`CheckIcon`, hook-timed reset) — the
 *   copied state can carry its own `title` (`copiedTitle`) and glyph class
 *   (`copiedIconClassName`).
 * - **A11y**: the accessible name is the caller's `aria-label` (message/file sites)
 *   or the `title` (default `"Copy"` for CodeBlock/CodeHeader); the `Button` gives
 *   native `<button>` keyboard semantics + focus ring.
 * - **Tokens**: `--app-subtle-bg` (hover) via the base class — emitted only for the
 *   `ghost` variant; all other colors from the `Button` variant (`ghost` by
 *   default, overridable). Zero raw hex/px.
 * - **Placement**: passed by the caller via `className` (`absolute right-1.5 top-1.5`
 *   at CodeBlock, `shrink-0` at CodeHeader/git-rpc, none at the message sites),
 *   merged over the base by `cn`/twMerge (later-wins) — the primitive hard-codes no
 *   placement.
 * - **Feedback**: `useCopyToClipboard` centralizes copy + haptic + a FAILURE toast;
 *   success is surfaced via `onCopied` (the message sites add `showToast("Copied!")`).
 * - **Exemplar**: `web/src/components/CodeBlock.tsx` — the absolute-overlay placement.
 */
export function CopyButton({
  text,
  iconClassName = "h-3.5 w-3.5",
  copiedIconClassName,
  copiedTitle,
  onCopied,
  className,
  variant,
  title = "Copy",
  ...rest
}: CopyButtonProps) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <Button
      {...rest}
      type="button"
      variant={variant ?? "ghost"}
      title={copied ? (copiedTitle ?? title) : title}
      onClick={async () => {
        const ok = await copy(text);
        onCopied?.(ok);
      }}
      className={cn(
        "h-auto rounded p-1",
        (variant ?? "ghost") === "ghost" && "hover:bg-[var(--app-subtle-bg)]",
        className
      )}
    >
      {copied ? (
        <CheckIcon className={copiedIconClassName ?? iconClassName} />
      ) : (
        <CopyIcon className={iconClassName} />
      )}
    </Button>
  );
}
