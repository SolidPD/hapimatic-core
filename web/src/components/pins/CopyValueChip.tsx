// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from "react";
import { Check, Copy } from "lucide-react";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";

const COPY_ICON: CSSProperties = { width: "12px", height: "12px" };
/** #6574: the dense chip is one line, 20 px tall, so it sits in a facts line. */
const DENSE_CHIP: CSSProperties = { height: "20px" };
const DENSE_ICON: CSSProperties = { width: "11px", height: "11px" };

/**
 * #6449: one tap-to-copy value in a steps pin. It shows the whole value,
 * newlines and all (never truncated), so neither an agent's label nor a cut
 * can disguise what lands on the clipboard — a hidden second line pasted into
 * a terminal would run (the label, if any, sits before it in hint text).
 * One chip per value: `useCopyToClipboard` holds one "copied" flag. `copy`
 * is called synchronously in the click handler because the iOS fallback
 * needs the user gesture (`lib/clipboard.ts`).
 *
 * #6574: `tooltip` and `ariaLabel` override the default "Copy <value>" strings, and
 * `dense` is the one-line, 20 px form a pin's ID uses in its facts line. Without
 * them the chip is exactly the steps chip it was.
 */
export function CopyValueChip(props: {
  value: string;
  label?: string;
  tooltip?: string;
  ariaLabel?: string;
  dense?: boolean;
}) {
  const { copied, copy } = useCopyToClipboard();
  const dense = props.dense === true;
  const icon = dense ? DENSE_ICON : COPY_ICON;
  return (
    <HoverTooltipButton
      type="button"
      content={props.tooltip ?? `Copy ${props.value}`}
      aria-label={
        props.ariaLabel ??
        `Copy ${props.label ? `${props.label}: ` : ""}${props.value}`
      }
      onClick={() => {
        void copy(props.value);
      }}
      style={dense ? DENSE_CHIP : undefined}
      className={
        dense
          ? "inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-sm border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-1.5 align-middle text-[length:var(--text-caption)] hover:bg-[var(--app-hover)]"
          : "inline-flex max-w-full min-w-0 items-start gap-1 rounded-sm border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-1.5 py-0.5 align-middle text-[length:var(--text-body-dense)] hover:bg-[var(--app-hover)]"
      }
    >
      {props.label ? (
        <span className="shrink-0 text-[var(--app-hint)]">{props.label}</span>
      ) : null}
      <span
        className={
          dense
            ? "whitespace-nowrap font-mono text-[var(--app-fg)]"
            : "min-w-0 whitespace-pre-wrap break-all text-left font-mono text-[var(--app-fg)]"
        }
      >
        {props.value}
      </span>
      {copied ? (
        <Check
          style={icon}
          className="shrink-0 text-[var(--status-ok)]"
          aria-hidden
        />
      ) : (
        <Copy
          style={icon}
          className="shrink-0 text-[var(--app-hint)]"
          aria-hidden
        />
      )}
    </HoverTooltipButton>
  );
}
