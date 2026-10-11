// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState, type ReactNode } from "react";
import { useMessage } from "@assistant-ui/react";
import type { ChatBlock } from "@/chat/types";
import type { MessageDetailMode } from "@/chat/presentation";
import { useHappyChatContext } from "@/components/AssistantChat/context";
import {
  MessageDetailOverrideContext,
  useMessageDetailOverride,
} from "@/components/AssistantChat/messages/HiddenToolSummary";
import {
  isToolCallBlock,
  hasPermissionFloor,
} from "@/components/AssistantChat/messages/ToolMessage";
import {
  collectImagesDeep,
  renderHoistedImages,
} from "@/components/AssistantChat/messages/toolImages";
import { CollapsibleSectionRow } from "@/components/AssistantChat/messages/CollapsibleSectionRow";
import { getToolIcon } from "@/components/ToolCard/knownTools";
import { Button } from "@/components/ui/button";

// ─────────────────────────── Task 1: pure helpers ───────────────────────────
// Exported so the colocated unit test can exercise the summary/aggregate logic
// directly, independent of the React slot.

export type ToolRunSummary = {
  total: number;
  byTool: Record<string, number>;
  /** e.g. "13 tool calls — Bash ×9, REPL ×3, Skill" (R2). */
  label: string;
};

/**
 * Semantic summary of a tool run (R2): total count + per-tool breakdown, sorted
 * by frequency (ties broken alphabetically). A count of 1 omits the "×1" suffix,
 * matching the epic's example format. Non-tool blocks in the range are ignored.
 */
export function summarizeToolRun(blocks: ChatBlock[]): ToolRunSummary {
  const byTool: Record<string, number> = {};
  let total = 0;
  for (const b of blocks) {
    if (!isToolCallBlock(b)) continue;
    total += 1;
    byTool[b.tool.name] = (byTool[b.tool.name] ?? 0) + 1;
  }
  const breakdown = Object.entries(byTool)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
    .join(", ");
  const noun = `${total} tool call${total === 1 ? "" : "s"}`;
  return { total, byTool, label: breakdown ? `${noun} — ${breakdown}` : noun };
}

export type ToolRunState = "running" | "complete" | "error";

/**
 * Aggregate run state (R3). "running" wins over everything so a collapsed group
 * NEVER looks finished while a member is in-flight; "error" is surfaced only once
 * nothing is running.
 */
export function aggregateRunState(blocks: ChatBlock[]): ToolRunState {
  let hasError = false;
  for (const b of blocks) {
    if (!isToolCallBlock(b)) continue;
    const state = b.tool.state;
    if (state === "running" || state === "pending") return "running";
    if (state === "error") hasError = true;
  }
  return hasError ? "error" : "complete";
}

function RunStateChip(props: { state: ToolRunState; errorCount?: number }) {
  if (props.state === "running") {
    return (
      <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
        running…
      </span>
    );
  }
  if (props.state === "error") {
    const n = props.errorCount ?? 0;
    const label = n > 0 ? `${n} error${n === 1 ? "" : "s"}` : "error";
    return <span className="shrink-0 text-[11px] text-red-500">{label}</span>;
  }
  return null;
}

// ───────────────────────── Task 2: the ToolGroup slot ────────────────────────

/**
 * `ToolGroup` slot for assistant-ui (#2989, epic #2987 Sub-Issue S2). Folds a run
 * of CONSECUTIVE tool-call parts under ONE collapsible summary row (R1), using the
 * shared `CollapsibleSectionRow` idiom (coordination b2) and emitting the stable
 * `data-cat="tools"` hook S4 tints via `[data-cat=…]` (coordination b3).
 *
 * Two-stage expansion via the SINGLE reveal channel widened to tri-state
 * (`MessageDetailOverrideContext`, ruling D1): a plain expand provides
 * `mode:"compact"` so members render as compact single-line rows regardless of
 * prefs (at the shipping `full` default the prefs alone would render full cards —
 * V3); an "Expand all" affordance provides `mode:"full"` so members render full
 * cards. The channel is section-scoped here instead of message-scoped.
 *
 * Safety floor (R5 / KD3): a collapsed group UNMOUNTS its members, so
 * `ToolMessage`'s own `forceFull` path can't keep a pending/errored member
 * visible. Instead the group scans its range and FORCES itself open when any
 * member `mustAlwaysRender`; the member then renders full via ToolMessage's own
 * per-member exemption even inside a stage-1 compact expansion.
 *
 * Fallbacks: a single-tool run (R6/KD2) and an already-open message-level reveal
 * (`mode:"full"`, ruling D5) both pass `children` through unwrapped — no group
 * chrome, no second reveal affordance. If assistant-ui ever drops the
 * experimental/@deprecated `ToolGroup` slot (OR1), the pinned-exact dep keeps it,
 * and its absence degrades to per-tool pass-through (the pre-epic rendering).
 *
 * Terminal split (R10 / Task 8): a `cli-output` bubble between two tool parts is
 * emitted by the converter as a SEPARATE message (metadata, not a tool part), so
 * the native slot naturally ends the run at it. v1 ACCEPTS this split (epic
 * pre-approved) — absorbing it needs a converter rework, deferred.
 */
export function ToolRunGroup(props: {
  startIndex: number;
  endIndex: number;
  children?: ReactNode;
}) {
  const { startIndex, endIndex, children } = props;
  const override = useMessageDetailOverride();
  const { chatSections, metadata } = useHappyChatContext();
  const message = useMessage();

  // `endIndex` is INCLUSIVE (verified against @assistant-ui/react
  // MessageParts.js: `Array.from({ length: endIndex - startIndex + 1 })`).
  const memberBlocks = useMemo<ChatBlock[]>(() => {
    const parts = message.content.slice(startIndex, endIndex + 1);
    const blocks: ChatBlock[] = [];
    for (const part of parts) {
      const artifact = (part as { artifact?: unknown }).artifact;
      if (isToolCallBlock(artifact)) blocks.push(artifact);
    }
    return blocks;
  }, [message.content, startIndex, endIndex]);

  const summary = useMemo(() => summarizeToolRun(memberBlocks), [memberBlocks]);
  const runState = useMemo(
    () => aggregateRunState(memberBlocks),
    [memberBlocks]
  );
  const hasFloor = useMemo(
    () => memberBlocks.some(hasPermissionFloor),
    [memberBlocks]
  );
  const errorCount = useMemo(
    () =>
      memberBlocks.filter(b => isToolCallBlock(b) && b.tool.state === "error")
        .length,
    [memberBlocks]
  );
  // #3269: a collapsed group UNMOUNTS its members (CollapsibleSectionRow renders its
  // children only while open), so a member's — or a member's sub-tool's — hoisted
  // image never mounts. Deep-collect them here (recursive, finding 3269-4) and render
  // an images-only strip while collapsed (below). Only the image is surfaced; the tool
  // cards stay collapsed (R3 — NOT the hasPermissionFloor force-open, which would expand
  // non-image members). Cheap + null-safe: a no-image group yields [] → renders nothing.
  // Lives above the early returns per the hook-discipline convention.
  const memberImages = useMemo(
    () => memberBlocks.flatMap(collectImagesDeep),
    [memberBlocks]
  );

  const { visible, defaultState } = chatSections.toolRuns;
  // A hidden section starts as a collapsed ghost (reveal affordance) regardless
  // of `defaultState`; a visible section honors `defaultState`.
  const [open, setOpen] = useState(visible && defaultState === "expanded");
  const [expandAll, setExpandAll] = useState(false);

  // ── all hooks above; conditional returns below ──

  // D5: inside a message-level reveal, the reveal owns this surface — render
  // children directly, never a second group ghost.
  if (override.mode === "full") {
    return <>{children}</>;
  }

  // R6/KD2: a single-tool run renders as a plain row — no group wrapper.
  if (endIndex === startIndex) {
    return <>{children}</>;
  }

  // R5: force open so a pending/errored member is never buried in a collapse.
  const effectiveOpen = open || hasFloor;
  const memberMode: MessageDetailMode =
    visible && expandAll ? "full" : "compact";

  const expandAllBtn =
    visible && effectiveOpen ? (
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpandAll(v => !v)}
        aria-pressed={expandAll}
        className="h-auto shrink-0 rounded px-1.5 py-0.5 text-[11px] font-normal text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] transition-colors cursor-pointer select-none"
      >
        {expandAll ? "Compact" : "Expand all"}
      </Button>
    ) : null;

  // `<RunStateChip/>` is always a truthy element even when it renders null, so
  // gate on the run-state itself — a complete run contributes no chip.
  const runChip =
    runState === "complete" ? null : (
      <RunStateChip state={runState} errorCount={errorCount} />
    );
  const trailing =
    runChip || expandAllBtn ? (
      <div className="flex items-center gap-2">
        {runChip}
        {expandAllBtn}
      </div>
    ) : null;

  // #2991 (S4/R4/V4): a compact icon strip of the DISTINCT tools in the run,
  // rendered before the semantic summary label. Icons reuse getToolPresentation
  // (KD2) and are aria-hidden — the label carries the accessible text. Same sort
  // as summarizeToolRun's breakdown (frequency desc, alpha tiebreak); capped so a
  // large run does not overflow the summary row.
  const distinctTools = Object.entries(summary.byTool)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);
  // #3018 (R3, D1 option 1): a hidden tool-run section renders as a collapsed
  // ghost. Its only pre-#3018 signal was `opacity-70` (a colour/opacity-only cue).
  // Surface a compact, explicit `Hidden` badge whose visible text IS the
  // accessibility contract — assistive tech reads the literal "Hidden", never a
  // tint/opacity/title/icon. The row's opacity stays a supplemental cue. Shown
  // ONLY for hidden sections (`!visible`); ordinary/visible collapsed runs never
  // show it.
  const hiddenBadge = !visible ? (
    <span className="mr-1.5 inline-flex shrink-0 items-center rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-hint)]">
      Hidden
    </span>
  ) : null;
  const summaryNode = (
    <>
      {hiddenBadge}
      {distinctTools.slice(0, 6).map(name => (
        <span
          key={name}
          aria-hidden="true"
          className="mr-1 inline-flex align-[-0.15em] text-[var(--app-hint)]"
        >
          {getToolIcon(name, metadata)}
        </span>
      ))}
      {summary.label}
    </>
  );

  return (
    <>
      <CollapsibleSectionRow
        cat="tools"
        className={!visible ? "opacity-70" : undefined}
        open={effectiveOpen}
        onToggle={() => setOpen(v => !v)}
        disabled={hasFloor}
        summary={summaryNode}
        trailing={trailing}
      >
        <MessageDetailOverrideContext.Provider value={{ mode: memberMode }}>
          {children}
        </MessageDetailOverrideContext.Provider>
      </CollapsibleSectionRow>
      {/* #3269: images-only strip for a COLLAPSED group. The unmounted members can't
          render their own screenshots, so surface them here — ONLY while collapsed
          (`!effectiveOpen`); when the group is open the members render their own
          images, so rendering the strip too would double them (V4). Its own
          `data-cat="tools"` container keeps it inside the tools border + 8px gutter
          (ruling D5): CollapsibleSectionRow's root already carries `data-cat="tools"`,
          so a bare sibling would escape the border (the continuity defect #3270 fixes
          elsewhere). */}
      {!effectiveOpen && memberImages.length > 0 ? (
        <div data-cat="tools" className="py-1">
          {renderHoistedImages(memberImages)}
        </div>
      ) : null}
    </>
  );
}
