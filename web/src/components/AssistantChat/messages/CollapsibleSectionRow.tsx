// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CompactChevron } from "@/components/AssistantChat/messages/CompactChevron";
import { Button } from "@/components/ui/button";

/**
 * Shared collapsible section-row primitive (#2989, epic #2987 coordination b2/b3).
 *
 * ONE row idiom for every collapsible chat section, so S2 (tool runs), S3
 * (message collapse) and S4 (category tints) do not each fork their own. It owns
 * the chevron + summary button + open/close of the body, and emits the stable
 * `data-cat` attribute S4 styles via `[data-cat=…]` selectors (ruling b3). It
 * deliberately does NOT own the two-stage / reveal semantics — the caller drives
 * `open`/`onToggle`, so tool-run grouping and message collapse can layer their
 * own policy on the same visual row.
 *
 * Body `children` render ONLY while `open`, so a collapsed section unmounts its
 * heavy subtree (the tools-side DOM saving). Reasoning keeps its own mounted
 * CSS-collapse and does not use this row.
 */
export function CollapsibleSectionRow(props: {
  /** Stable per-category hook for S4's `[data-cat=…]` tint pass (ruling b3). */
  cat: string;
  open: boolean;
  onToggle: () => void;
  /** Summary content shown inside the toggle (e.g. the semantic run label). */
  summary: ReactNode;
  /** Optional control aligned to the row end (e.g. an expand-all button). */
  trailing?: ReactNode;
  /** When true the toggle is inert — e.g. a safety-floor group forced open. */
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      data-cat={props.cat}
      className={cn("py-1 min-w-0 max-w-full", props.className)}
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={props.onToggle}
          disabled={props.disabled}
          aria-expanded={props.open}
          className={cn(
            // Epic #3285 round 14: px-0 (was px-2) so the chevron sits at the same
            // x as the reasoning (p-0) / narration (size="bare") / System rows —
            // every collapsible chevron shares one column inside the category gutter.
            "flex h-auto min-w-0 flex-1 items-center justify-start gap-2 rounded px-0 py-1 text-left text-xs font-normal",
            "text-[var(--app-hint)] transition-colors disabled:opacity-100",
            props.disabled
              ? "cursor-default"
              : "cursor-pointer hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
          )}
        >
          <CompactChevron open={props.open} />
          <span className="min-w-0 flex-1 truncate">{props.summary}</span>
        </Button>
        {props.trailing ? (
          <div className="shrink-0">{props.trailing}</div>
        ) : null}
      </div>
      {props.open ? <div className="mt-1">{props.children}</div> : null}
    </div>
  );
}
