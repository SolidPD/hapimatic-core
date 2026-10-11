// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { MessageDetailMode } from "@/chat/presentation";

/**
 * Per-message detail-level override (#2625, epic #2622 Sub-Issue C).
 *
 * `HiddenToolSummary` is the SINGLE reveal channel (ruling D1) for the
 * `output-only` hide on the message path: it owns the per-message expansion
 * state, renders the reveal affordance ("N tool calls ▸"), and provides this
 * context so every deep renderer within the revealed subtree (tool cards,
 * nested Task children) un-gates to `full` while the affordance is open. Without
 * this single channel, per-renderer null-returns would leave the affordance
 * unable to reveal what it hid.
 */
// #2989 (S2): widened from the pre-S2 `{ revealed: boolean }` to a tri-state
// `{ mode }` — still ONE reveal channel (ruling D1), but section-scoped
// expansion (`ToolRunGroup`) needs a `"compact"` force the boolean lacked. The
// message-level reveal provides `"full"` where it once provided `revealed:true`.
export type MessageDetailOverride = { mode: MessageDetailMode };

export const MessageDetailOverrideContext =
  createContext<MessageDetailOverride>({
    mode: "inherit",
  });

export function useMessageDetailOverride(): MessageDetailOverride {
  return useContext(MessageDetailOverrideContext);
}

/**
 * Build the affordance label from the hidden-part inventory. At least one of
 * `toolCount`/`hasReasoning` is non-empty whenever the affordance renders (the
 * caller only mounts it when there is something to hide).
 */
export function buildHiddenSummaryLabel(
  toolCount: number,
  hasNarration: boolean,
  hasReasoning: boolean
): string {
  const parts: string[] = [];
  if (toolCount > 0) {
    parts.push(`${toolCount} tool call${toolCount === 1 ? "" : "s"}`);
  }
  // #3154: narration sits between tools and reasoning ("N tool calls · narration
  // · reasoning ▸") so the both-hidden fold names the narration content it covers.
  if (hasNarration) {
    parts.push("narration");
  }
  if (hasReasoning) {
    parts.push("reasoning");
  }
  if (parts.length === 0) {
    // Defensive: never render an empty affordance.
    return "detail";
  }
  return parts.join(" · ");
}

function ChevronIcon(props: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "transition-transform duration-200",
        props.open ? "rotate-90" : ""
      )}
      aria-hidden="true"
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/**
 * `output-only` per-message reveal affordance + override provider.
 *
 * The content is passed as a render-prop `children(revealed)` so the caller can
 * swap the assistant-ui components map (collapsed vs full) based on the reveal
 * state, while this component owns the state and provides the override context
 * to the revealed subtree. Keeping this component free of assistant-ui imports
 * lets `ToolMessage.tsx` consume `useMessageDetailOverride()` without pulling the
 * chat runtime into its own module graph.
 */
export function HiddenToolSummary(props: {
  toolCount: number;
  hasNarration: boolean;
  hasReasoning: boolean;
  children: (revealed: boolean) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = buildHiddenSummaryLabel(
    props.toolCount,
    props.hasNarration,
    props.hasReasoning
  );

  return (
    <div className="py-1">
      <MessageDetailOverrideContext.Provider
        value={{ mode: expanded ? "full" : "inherit" }}
      >
        {props.children(expanded)}
      </MessageDetailOverrideContext.Provider>
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className={cn(
          "mt-1 flex items-center justify-start gap-1.5 text-xs font-medium",
          "text-[var(--app-hint)] hover:text-[var(--app-fg)]",
          "transition-colors cursor-pointer select-none"
        )}
      >
        <ChevronIcon open={expanded} />
        <span>{expanded ? "Hide detail" : label}</span>
      </Button>
    </div>
  );
}
