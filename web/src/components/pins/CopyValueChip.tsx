// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from "react";
import { Check, Copy } from "lucide-react";
import { HoverTooltipButton } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/useCopyToClipboard";

const COPY_ICON: CSSProperties = { width: "12px", height: "12px" };

/**
 * #6449: one tap-to-copy value in a steps pin. It shows the whole value,
 * newlines and all (never truncated), so neither an agent's label nor a cut
 * can disguise what lands on the clipboard — a hidden second line pasted into
 * a terminal would run (the label, if any, sits before it in hint text).
 * One chip per value: `useCopyToClipboard` holds one "copied" flag. `copy`
 * is called synchronously in the click handler because the iOS fallback
 * needs the user gesture (`lib/clipboard.ts`).
 */
export function CopyValueChip(props: { value: string; label?: string }) {
  const { copied, copy } = useCopyToClipboard();
  return (
    <HoverTooltipButton
      type="button"
      content={`Copy ${props.value}`}
      aria-label={`Copy ${props.label ? `${props.label}: ` : ""}${props.value}`}
      onClick={() => {
        void copy(props.value);
      }}
      className="inline-flex max-w-full min-w-0 items-start gap-1 rounded-sm border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-1.5 py-0.5 align-middle text-[length:var(--text-body-dense)] hover:bg-[var(--app-hover)]"
    >
      {props.label ? (
        <span className="shrink-0 text-[var(--app-hint)]">{props.label}</span>
      ) : null}
      <span className="min-w-0 whitespace-pre-wrap break-all text-left font-mono text-[var(--app-fg)]">
        {props.value}
      </span>
      {copied ? (
        <Check
          style={COPY_ICON}
          className="shrink-0 text-[var(--status-ok)]"
          aria-hidden
        />
      ) : (
        <Copy
          style={COPY_ICON}
          className="shrink-0 text-[var(--app-hint)]"
          aria-hidden
        />
      )}
    </HoverTooltipButton>
  );
}
