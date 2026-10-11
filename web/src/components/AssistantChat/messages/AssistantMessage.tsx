// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, useState } from "react";
import {
  MessagePrimitive,
  useAssistantState,
  useMessage,
  useMessagePartRuntime,
  getExternalStoreMessages,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { MarkdownText } from "@/components/assistant-ui/markdown-text";
import {
  Reasoning,
  ReasoningGroup,
  ThinkingPlaceholderShell,
} from "@/components/assistant-ui/reasoning";
import {
  isThinkingPlaceholderPart,
  thinkingPlaceholderLabel,
} from "@/chat/reasoningPlaceholder";
import { useStalePlaceholderLabel } from "@/hooks/useStalePlaceholderLabel";
import {
  HappyToolMessage,
  isToolCallBlock,
  mustAlwaysRender,
} from "@/components/AssistantChat/messages/ToolMessage";
import {
  collectImagesDeep,
  renderHoistedImages,
} from "@/components/AssistantChat/messages/toolImages";
import { HiddenToolSummary } from "@/components/AssistantChat/messages/HiddenToolSummary";
import { ToolRunGroup } from "@/components/AssistantChat/messages/ToolRunGroup";
import { useHappyChatContext } from "@/components/AssistantChat/context";
import { CliOutputBlock } from "@/components/CliOutputBlock";
import type {
  HappyChatMessageMetadata,
  TurnTokens,
} from "@/lib/assistant-runtime";
import type { AgentEvent, ChatBlock } from "@/chat/types";
import {
  useTurnDuration,
  useTurnStatusText,
  useTurnTokens,
  useTurnWorkflow,
} from "@/lib/assistant-runtime";
import { StopwatchIcon } from "@/components/icons";
import { CopyButton } from "@/components/ui/CopyButton";
import { useToast } from "@/components/Toast";
import { formatMessageTimestamp } from "@/utils/formatMessageTimestamp";
import {
  formatTurnDuration,
  getChatSectionRenderHints,
  getEventPresentation,
  isCollapsedNarration,
  narrationLines,
} from "@/chat/presentation";
import { messagePreview } from "@/chat/messagePreview";
import { CompactChevron } from "@/components/AssistantChat/messages/CompactChevron";
import { BookmarkGutter } from "@/components/AssistantChat/messages/BookmarkGutter";
import { BlockAnchor } from "@/components/AssistantChat/messages/BlockAnchor";
import { EventLabel } from "@/components/AssistantChat/messages/EventLabel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  isStopHookFeedbackBlock,
  STOP_HOOK_BANNER_LABEL,
  AFTER_HOOK_BADGE_LABEL,
} from "@/chat/stopHookFeedback";

const TOOL_COMPONENTS = {
  Fallback: HappyToolMessage,
} as const;

/**
 * Issues #3115 / #3146: wrap the Text/Reasoning parts so each rendered block's DOM
 * carries its source `block.id` as `data-bookmark-anchor` — the gutter's
 * press→offset resolver and `useBookmarkNavigation` use it to place/restore a
 * bookmark at the exact tapped scroll position within a long turn. Only the
 * FULL-render map is anchored — the collapsed maps below hide content, so there is
 * nothing to anchor there.
 */
const AnchoredText = () => (
  <BlockAnchor>
    <MarkdownText />
  </BlockAnchor>
);
const AnchoredReasoning = () => (
  <BlockAnchor>
    <Reasoning />
  </BlockAnchor>
);

/**
 * #3154 (Task 6): narration-aware Text part renderer. Recovers the source
 * `ChatBlock` for THIS text part via the BlockAnchor index idiom — parts↔blocks
 * are the same ordered array (`assistant-runtime.ts` emits one part per block;
 * `BlockAnchor.tsx:40-62`) — and reads `block.category`. A narration-classified
 * block renders inside a slate `data-cat="narration"` collapsible with an N-line
 * preview (soft-collapse parity with reasoning, driven by the `narration` hint +
 * `narration.previewLines`; #3154 KD6); every other text part is the task-final
 * RESPONSE and renders through the unchanged anchored-markdown path (R6). The
 * category is read per-part here (not from message metadata) because the converter
 * concat-joins a turn into ONE message and absorbs metadata only from the FIRST
 * block, so message-level metadata cannot label individual text parts (KD5).
 */
/**
 * Recover the source `ChatBlock` for the CURRENT message part via the parts↔blocks
 * index correlation — `assistant-runtime.ts` emits exactly one content part per
 * block, so the part's `messagePartSelector.index` addresses the same ordered
 * `getExternalStoreMessages` array (`BlockAnchor.tsx:40-62`). Returns undefined on a
 * lookup miss (transient streaming state, or a stubbed test runtime) so callers can
 * degrade safely (#3154 R6 safety floor). Shared by the narration and title-change
 * (#3270) part renderers.
 */
function usePartBlock(): ChatBlock | undefined {
  const message = useMessage();
  const partRuntime = useMessagePartRuntime({ optional: true });
  const selector = partRuntime?.path.messagePartSelector;
  if (selector && selector.type !== "toolCallId") {
    try {
      return getExternalStoreMessages<ChatBlock>(message)[selector.index];
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** #3270: a title-change agent-event block reaching an assistant Text renderer is
 *  TURN-DERIVED by construction (standalone events keep role:"system" in the
 *  converter and never reach here), so the kind+type check alone identifies it. */
function isTitleChangeBlock(
  block: ChatBlock | undefined
): block is Extract<ChatBlock, { kind: "agent-event" }> {
  return block?.kind === "agent-event" && block.event.type === "title-changed";
}

/**
 * Issue #3270 (ruling D6): the inline title-change bubble. A TURN-DERIVED
 * `title-changed` agent-event is routed to a role:"assistant" text part in the
 * converter (`assistant-runtime.ts`), so it renders HERE — inside the response
 * boundary at its in-flow position — instead of as a standalone centered
 * `HappySystemMessage` bubble that would split the run and cut the
 * `[data-cat="response"]` left border. Both bubbles render their icon + muted
 * text through the shared `EventLabel` (#4043); this one keeps its own
 * left-aligned wrapper (no `mx-auto`/`text-center` centering) and passes the
 * muted text classes onto the label span, so the bubble flows left-aligned like
 * tool/reasoning content. Text is `getEventPresentation(event).text` (== `renderEventLabel(event)`,
 * V3 — unchanged); the icon is null for title-changed today (harmless).
 */
function TitleChangeBubble({ event }: { event: AgentEvent }) {
  const { icon, text } = getEventPresentation(event);
  return (
    <div className="py-1" data-testid="title-change-bubble">
      <EventLabel
        icon={icon}
        text={text}
        className="text-xs text-[var(--app-hint)] opacity-80"
      />
    </div>
  );
}

function NarrationAwareText() {
  const block = usePartBlock();
  const { chatSections } = useHappyChatContext();
  const narrationHint = getChatSectionRenderHints(chatSections).narration;
  const previewLines = chatSections.narration.previewLines;
  // "shown" opens by default; "collapsed"/"hidden" (soft-collapse) start closed.
  const [isOpen, setIsOpen] = useState(narrationHint === "shown");

  // #3270: a turn-derived title-change part renders as its inline bubble inside the
  // response boundary. Placed before the narration/response branches; a correlation
  // miss falls through to the response path below (safety floor), where MarkdownText
  // renders the label text (the converter kept the label IN the part text for exactly
  // this degradation).
  if (isTitleChangeBlock(block)) {
    return <TitleChangeBubble event={block.event} />;
  }
  // #3778 (Task 4, R-B): the Stop-hook feedback PART renders as a dimmed banner between
  // the two responses — NEVER as prose, and NEVER via the message-level chip (that chip
  // is a whole-MESSAGE early return that cannot fire for this joined mid-run message: the
  // converter absorbs the joined message's metadata from resp1, not the hook part). The
  // SAME `isStopHookFeedbackBlock` predicate as the reducer keeps legacy flag-less
  // records on the banner path too (R2).
  if (block?.kind === "agent-text" && isStopHookFeedbackBlock(block)) {
    return (
      <BlockAnchor>
        <details className="opacity-40 hover:opacity-60 transition-opacity text-xs my-1">
          <summary className="cursor-pointer select-none text-[var(--app-hint)] py-0.5">
            {STOP_HOOK_BANNER_LABEL}
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-[var(--app-subtle-bg)]/50 px-3 py-2 text-[var(--app-fg)]/60 text-xs">
            {block.text}
          </div>
        </details>
      </BlockAnchor>
    );
  }

  // #3879: the selector — not `block.category` — decides whether this narration
  // block collapses. A substantial over-threshold interstitial promotes to the
  // response path (isCollapsedNarration → false).
  const isNarration =
    block?.kind === "agent-text" && isCollapsedNarration(block, chatSections);

  if (!isNarration) {
    // Response text (or a transient streaming lookup miss): the always-visible anchored
    // path. #3267 made the classifier fail-open and BIDIRECTIONAL — a block can flip
    // response ⇄ narration across streaming ticks as later tool-separated text arrives
    // (the reducer re-derives `category` each tick from the freshly-built blocks) — so a
    // lookup miss falls back to SHOWING content (the R6 safety floor), never hiding it.
    // #3778 (Task 5): a response that immediately FOLLOWS a Stop-hook boundary carries
    // `afterHookBoundary` — render it with a small inline badge attributing it to the hook.
    if (block?.kind === "agent-text" && block.afterHookBoundary === true) {
      return (
        <div className="flex flex-col gap-0.5">
          <span className="self-start text-[length:var(--text-caption-xs)] font-medium uppercase tracking-wide text-[var(--app-hint)] opacity-70">
            {AFTER_HOOK_BADGE_LABEL}
          </span>
          <AnchoredText />
        </div>
      );
    }
    return <AnchoredText />;
  }

  const narrationText = block && block.kind === "agent-text" ? block.text : "";
  const preview =
    previewLines > 0
      ? // #3879: share the exact line unit the promote guard counts.
        narrationLines(narrationText).slice(0, previewLines).join("\n")
      : "";

  return (
    <div className="aui-narration-group my-2" data-cat="narration">
      <Button
        type="button"
        variant="ghostStatic"
        size="bare"
        onClick={() => setIsOpen(o => !o)}
        aria-expanded={isOpen}
        className={cn(
          "flex items-center justify-start gap-1.5 text-xs font-medium",
          "text-[var(--app-hint)] hover:text-[var(--app-fg)]",
          "transition-colors cursor-pointer select-none"
        )}
      >
        <CompactChevron open={isOpen} />
        <span>Narration</span>
      </Button>
      {!isOpen && preview ? (
        <div className="aui-narration-preview pl-4 pt-1 text-xs text-[var(--app-hint)] opacity-70 break-words whitespace-pre-wrap">
          {preview}
        </div>
      ) : null}
      <div
        className={cn(
          "overflow-hidden transition-all duration-200 ease-in-out",
          isOpen ? "max-h-[5000px] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="pl-4 pt-2">
          <BlockAnchor>
            <MarkdownText />
          </BlockAnchor>
        </div>
      </div>
    </div>
  );
}

const MESSAGE_PART_COMPONENTS = {
  Text: NarrationAwareText,
  Reasoning: AnchoredReasoning,
  ReasoningGroup: ReasoningGroup,
  // #2989 (S2): fold each run of consecutive tool-call parts under one
  // collapsible summary row. Deliberately NOT added to
  // OUTPUT_ONLY_COLLAPSED_COMPONENTS below — when a fully-hidden message is
  // collapsed, HiddenToolSummary owns the message-level reveal, and adding a
  // group ghost there would double the affordance (ruling D5). On reveal the map
  // swaps to this full map inside a `mode:"full"` override, where ToolRunGroup
  // passes children through (no second ghost).
  ToolGroup: ToolRunGroup,
  tools: TOOL_COMPONENTS,
} as const;

/** A message part rendered as nothing (used to hide reasoning in output-only). */
const HiddenPart = () => null;

/**
 * #3177 (R6): the reasoning-group slot of the HIDE maps. The activity placeholder
 * is not reasoning content, so it renders under every preference — as the
 * header-only shell, never the group's children, so real reasoning merged into the
 * same group (output-only: placeholder after a hidden reasoning tail) stays hidden.
 * Anything else renders nothing, exactly like `HiddenPart`.
 */
export function PlaceholderAwareHiddenGroup(props: { endIndex?: number }) {
  const content = useMessage().content;
  const rangeEnd = props.endIndex ?? content.length - 1;
  // A hidden reasoning record that lands above the placeholder merges them into one
  // reasoning run, and the stale range then ends on the real record — so read the
  // END of the contiguous run. The tool/text-replacement stale shape is handled by
  // useStalePlaceholderLabel (shared with ReasoningGroup).
  let runEnd = rangeEnd;
  while (content[runEnd + 1]?.type === "reasoning") runEnd++;
  const endPart = content[runEnd] as
    | { type?: string; text?: string }
    | undefined;
  const shellLabel = useStalePlaceholderLabel(
    isThinkingPlaceholderPart(endPart)
      ? thinkingPlaceholderLabel(endPart?.text)
      : null,
    content[rangeEnd]
  );
  return shellLabel !== null ? (
    <ThinkingPlaceholderShell label={shellLabel} />
  ) : null;
}

/**
 * Output-only collapsed tool part (#2625, R4 safety floor): renders the FULL
 * tool card ONLY for a safety-floor tool (recursive pending/errored permission,
 * or an errored non-block fallback); every other tool part collapses to nothing
 * and is reachable via the message's reveal affordance. This never filters the
 * underlying block — it is pure presentation.
 */
function SafetyFloorToolPart(props: ToolCallMessagePartProps) {
  const artifact = props.artifact;
  if (isToolCallBlock(artifact)) {
    return mustAlwaysRender(artifact) ? <HappyToolMessage {...props} /> : null;
  }
  // Non-block fallback: only an errored fallback is a safety-floor item.
  return props.isError ? <HappyToolMessage {...props} /> : null;
}

/**
 * #3269: OUTPUT-ONLY collapsed tool part. Same safety-floor logic as
 * `SafetyFloorToolPart` (a recursive pending/errored-permission tool, or an errored
 * non-block fallback, renders its FULL card) — but a NON-floor image-bearing tool
 * part renders an images-only strip (deep collect, finding 3269-4) instead of bare
 * null, so an AUTOMATIC output-only hide never swallows a screenshot (R2). A non-image
 * non-floor part stays null (R3 — no phantom rows). Wired into the OUTPUT-ONLY map
 * ONLY; the MANUAL map keeps `SafetyFloorToolPart`, so a deliberate user collapse
 * still hides images (ruling D4 scope cut). No `data-cat` wrapper: a message-level
 * tool part carries no tools border in its normal render (unlike the ToolRunGroup
 * strip's D5 case), so the strip matches it.
 */
function OutputOnlyToolPart(props: ToolCallMessagePartProps) {
  const artifact = props.artifact;
  // The ONLY behavioral difference from SafetyFloorToolPart: a NON-floor image-bearing
  // tool part surfaces an images-only strip instead of collapsing to null (ruling D4).
  if (isToolCallBlock(artifact) && !mustAlwaysRender(artifact)) {
    const images = collectImagesDeep(artifact);
    return images.length ? (
      <div className="py-1">{renderHoistedImages(images)}</div>
    ) : null;
  }
  // Every other case (safety-floor tool, non-block fallback) is byte-identical to the
  // safety-floor part — delegate rather than duplicate.
  return <SafetyFloorToolPart {...props} />;
}

/**
 * #3270: output-only-collapsed Text renderer. In this map the response text renders
 * as bare markdown (narration is hidden), but a title-change part must still render
 * as its inline bubble — NOT the raw "Title changed to …" label styled as response
 * markdown. Everything else falls through to the unchanged `MarkdownText` path.
 */
function OutputOnlyText() {
  const block = usePartBlock();
  if (isTitleChangeBlock(block)) {
    return <TitleChangeBubble event={block.event} />;
  }
  return <MarkdownText />;
}

/**
 * Components map used when an `output-only` message is COLLAPSED (ruling D1: the
 * wrapper owns the hide via a map swap, so `ReasoningGroup`/`HappyToolMessage`
 * never self-hide). Text always renders (safety floor); reasoning is hidden;
 * tools render only when they are a safety-floor exemption. Expanding the reveal
 * affordance swaps back to `MESSAGE_PART_COMPONENTS` (full) inside the override
 * context, so every hidden part shares one reveal channel.
 */
const OUTPUT_ONLY_COLLAPSED_COMPONENTS = {
  Text: OutputOnlyText,
  Reasoning: HiddenPart,
  ReasoningGroup: PlaceholderAwareHiddenGroup,
  // #3269: OutputOnlyToolPart (not SafetyFloorToolPart) — an AUTOMATIC output-only
  // hide surfaces a non-floor tool's image instead of swallowing it (ruling D4).
  tools: { Fallback: OutputOnlyToolPart },
} as const;

/**
 * Components map used when a message is MANUALLY collapsed (#2990, S3, R1/R3).
 * Distinct from the output-only map above: here the TEXT is hidden too, because
 * its first-line preview is shown in the collapse affordance row instead. Tools
 * still route through `SafetyFloorToolPart`, so a pending-permission / errored
 * tool card in a mixed text+tool message stays visible while the message is
 * collapsed (expert-review R5 safety floor) — the reason we SWAP the map on a
 * still-mounted `MessagePrimitive.Content` rather than replacing it wholesale.
 * #3270: an inline title-change part hides here along with the rest of the body —
 * a deliberate decision (ruling D6): a manually-collapsed message shows only its
 * one-line preview, and the title-change label is not part of that preview.
 */
const MANUAL_COLLAPSED_COMPONENTS = {
  Text: HiddenPart,
  Reasoning: HiddenPart,
  ReasoningGroup: PlaceholderAwareHiddenGroup,
  tools: { Fallback: SafetyFloorToolPart },
} as const;

/** Compact token count: 1234 → "1.2k", 1_200_000 → "1.2M" (issue #1671). */
function formatTurnTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Compact per-turn API value: small costs keep 4 dp, larger round to cents. */
function formatTurnCost(usd: number): string {
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/**
 * Fee tooltip breakdown (issue #2540 R3): enumerate the per-turn input / output /
 * cache-read / cache-write token counts. Only non-null classes are listed — a
 * null class is OMITTED rather than coalesced to 0, so the tooltip never asserts
 * a count it does not have.
 */
function formatTurnFeeBreakdown(turnTokens: TurnTokens): string {
  const classes: Array<[string, number | null]> = [
    ["in", turnTokens.tokIn],
    ["out", turnTokens.tokOut],
    ["cache-read", turnTokens.tokCacheRead],
    ["cache-write", turnTokens.tokCacheWrite],
  ];
  const parts: string[] = [];
  for (const [label, value] of classes) {
    if (value != null) parts.push(`${label} ${formatTurnTokenCount(value)}`);
  }
  return `API fee for this turn — ${parts.join(", ")}`;
}

export function HappyAssistantMessage() {
  // Detail level (#2625, ruling D1): this message-layer wrapper is the SINGLE
  // policy owner of the `output-only` hide + reveal affordance for the message
  // path. Read once here (above every early return, so hooks order is stable).
  const { chatSections } = useHappyChatContext();
  // #2990 (S3): manual per-message collapse. Runtime-only, default expanded
  // (epic D5: responses have NO visibility/default preference — only this manual
  // affordance). Kept as LOCAL component state (ruling d3: NOT a second reveal
  // context — `MessageDetailOverrideContext` stays the lone reveal channel).
  // Declared above every early return so hook order is stable. The message id is
  // the stable `assistant:${block.id}` (assistant-runtime.ts:182), so a streaming
  // append re-renders this same instance and the collapse survives it (R9); a
  // thread switch unmounts the instance so collapse resets on reload (R3).
  const [collapsed, setCollapsed] = useState(false);
  const isCliOutput = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.kind === "cli-output";
  });
  const cliText = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    if (custom?.kind !== "cli-output") return "";
    return message.content.find(part => part.type === "text")?.text ?? "";
  });
  const toolOnly = useAssistantState(({ message }) => {
    if (message.role !== "assistant") return false;
    const parts = message.content;
    return parts.length > 0 && parts.every(part => part.type === "tool-call");
  });
  // Output-only gated-part inventory (#2625, ruling D3): count the hideable
  // (non-safety-floor) tool parts and whether reasoning is present, so the reveal
  // affordance can be sized ("N tool calls · reasoning ▸"). Must-render
  // (pending/errored) tools and assistant text are excluded from the hidden count
  // — they always render (safety floor). Covers `toolOnly` AND mixed text+tool
  // messages (the common case under the converter's concat-join).
  const hideableToolCount = useAssistantState(({ message }) => {
    if (message.role !== "assistant") return 0;
    let count = 0;
    for (const part of message.content) {
      if (part.type !== "tool-call") continue;
      const p = part as { artifact?: unknown; isError?: boolean };
      const isMust = isToolCallBlock(p.artifact)
        ? mustAlwaysRender(p.artifact)
        : Boolean(p.isError);
      if (!isMust) count++;
    }
    return count;
  });
  const hasReasoning = useAssistantState(({ message }) => {
    if (message.role !== "assistant") return false;
    // #3177 (R6): the activity placeholder is not reasoning — it must not size the
    // fold's "reasoning ▸" reveal affordance or activate the output-only fold.
    return message.content.some(
      part => part.type === "reasoning" && !isThinkingPlaceholderPart(part)
    );
  });
  // #3154: narration presence for the both-hidden fold's reveal-affordance label.
  // Narration parts are `type: "text"` (indistinguishable at the part level), so
  // this uses the same part→block correlation the render path does (KD5).
  const hasNarration = useAssistantState(({ message }) => {
    if (message.role !== "assistant") return false;
    try {
      return getExternalStoreMessages<ChatBlock>(message).some(
        // #3879: a PROMOTED interstitial is no longer hidden narration — exclude it
        // from the both-hidden fold's reveal-affordance count via the selector.
        b => b.kind === "agent-text" && isCollapsedNarration(b, chatSections)
      );
    } catch {
      return false;
    }
  });
  // Extract RESPONSE text content for the copy button + collapse preview. #3154:
  // narration-classified text is excluded via the part→block index correlation
  // (KD5) — narration is its own category, not the task-final response — so a
  // narration-only turn yields "" and gets NO response chrome (data-cat="response",
  // "System" header, copy button all key off this).
  const textContent = useAssistantState(({ message }) => {
    if (message.role !== "assistant") return "";
    let blocks: ChatBlock[] = [];
    try {
      blocks = getExternalStoreMessages<ChatBlock>(message);
    } catch {
      blocks = [];
    }
    return message.content
      .map((part, i) => {
        if (part.type !== "text") return null;
        const block = blocks[i];
        if (
          block &&
          block.kind === "agent-text" &&
          // #3879: only EXCLUDE a still-collapsed narration block (a promoted
          // interstitial's text joins the response copy). #3778's meta (Stop-hook)
          // exclusion is preserved.
          (isCollapsedNarration(block, chatSections) || block.isMeta === true)
        ) {
          // #3778: exclude meta (Stop-hook feedback) parts from the RESPONSE text
          // consumers (copy button / collapse preview / response chrome) — the hook
          // renders as its own banner in NarrationAwareText, and the standalone-meta
          // chip reads `metaTextContent` instead. Without this, the joined-message copy
          // would splice the hook text between resp1 and resp2.
          return null;
        }
        // #3270 (R4): exclude the inline title-change label from copy / collapsed
        // preview / showCopyButton. A rename-only turn then yields "" here, so
        // showCopyButton stays false and NO response chrome (data-cat="response",
        // "System" header, copy footer) is conjured around the lone bubble.
        if (
          block &&
          block.kind === "agent-event" &&
          block.event.type === "title-changed"
        ) {
          return null;
        }
        return part.text;
      })
      .filter((t): t is string => t != null)
      .join("\n");
  });
  const createdAt = useAssistantState(({ message }) => message.createdAt);
  const messageId = useAssistantState(({ message }) => message.id);
  const turnDurationMs = useTurnDuration(messageId);
  const turnStatusText = useTurnStatusText(messageId);
  // Issue #1671: per-turn tokens + API value for this turn-concluding message,
  // sourced from the DB turn (R2). Only set on turn-concluding agent-text
  // messages, so a tool-only / no-text turn never inherits a misattribution (R6).
  const turnTokens = useTurnTokens(messageId);
  // Issue #1672 (Sub J): per-turn workflow chips (label events this turn did).
  const turnWorkflow = useTurnWorkflow(messageId);
  const isInherited = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.isInherited === true;
  });
  const isTaskNotification = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.isTaskNotification === true;
  });
  // #2162: synthetic/meta record (stop-hook feedback, system-reminder / caveat) —
  // rendered as a dimmed collapsed chip instead of inline assistant prose.
  const isMeta = useAssistantState(({ message }) => {
    const custom = message.metadata.custom as
      | Partial<HappyChatMessageMetadata>
      | undefined;
    return custom?.isMeta === true;
  });
  // #3778 (Task 4): the meta (Stop-hook feedback) text, for the standalone-meta chip's
  // label + body. Kept SEPARATE from `textContent` (which now excludes meta) so the chip
  // is never empty while the response copy/preview never include hook text.
  const metaTextContent = useAssistantState(({ message }) => {
    if (message.role !== "assistant") return "";
    let blocks: ChatBlock[] = [];
    try {
      blocks = getExternalStoreMessages<ChatBlock>(message);
    } catch {
      blocks = [];
    }
    return message.content
      .map((part, i) => {
        if (part.type !== "text") return null;
        const block = blocks[i];
        // A resolved block gates on its meta flag. When the store is unresolved (empty —
        // a transient streaming miss, or a test env), fall back to including the part:
        // metaTextContent is consumed ONLY by the standalone-meta chip branch, where every
        // text part IS the meta content — mirroring textContent's block-undefined fallback.
        if (block && block.kind === "agent-text") {
          return block.isMeta === true ? part.text : null;
        }
        return part.text;
      })
      .filter((t): t is string => t != null)
      .join("\n");
  });
  // #3778 (Task 4): TRUE only for a genuine standalone/all-meta message with no response
  // to swallow — gates the message-level chip so a joined run whose FIRST block is meta
  // ([hook, resp] or [resp1, hook]) no longer collapses the whole run into one chip (the
  // #2162 latent run-swallow bug). Primary signal: every agent-text block is meta (via the
  // resolved store). Fallback when the store is empty (a transient streaming lookup miss):
  // the single-part shape — a lone meta part is the standalone case; a multi-part message
  // with a meta first block is a run we must NOT swallow.
  const isStandaloneMeta = useAssistantState(({ message }) => {
    if (message.role !== "assistant") return false;
    let blocks: ChatBlock[] = [];
    try {
      blocks = getExternalStoreMessages<ChatBlock>(message);
    } catch {
      blocks = [];
    }
    const agentTexts = blocks.filter(b => b.kind === "agent-text");
    if (agentTexts.length > 0) {
      return agentTexts.every(
        b => b.kind === "agent-text" && b.isMeta === true
      );
    }
    return message.content.length === 1;
  });
  const { showToast } = useToast();

  const rootClass = toolOnly
    ? `py-1 flex min-w-0 max-w-full overflow-x-hidden${isInherited ? " opacity-50" : ""}`
    : `group py-1 flex min-w-0 max-w-full overflow-x-hidden${isInherited ? " opacity-50" : ""}`;

  if (isCliOutput) {
    // Terminal/CLI collapse (#2625, R2/R3): `compact` and `output-only` render a
    // collapsed "Terminal output" row (native <details>, same idiom as the
    // task-notification collapse below) that expands on tap; `full` is unchanged.
    // `CliOutputBlock` has no collapse affordance of its own to reuse.
    const terminalHint = getChatSectionRenderHints(chatSections).terminal;
    return (
      <MessagePrimitive.Root
        className={`py-1 flex min-w-0 max-w-full overflow-x-hidden${isInherited ? " opacity-50" : ""}`}
      >
        <BookmarkGutter messageId={messageId} />
        <div className="flex-1 min-w-0">
          {terminalHint === "full" ? (
            <CliOutputBlock text={cliText} />
          ) : (
            <details className="min-w-0 max-w-full">
              <summary className="cursor-pointer select-none py-0.5 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)]">
                Terminal output
              </summary>
              <div className="mt-1">
                <CliOutputBlock text={cliText} />
              </div>
            </details>
          )}
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (isTaskNotification && !toolOnly) {
    return (
      <MessagePrimitive.Root className="py-1 flex min-w-0 max-w-full overflow-x-hidden">
        <BookmarkGutter messageId={messageId} />
        <div className="flex-1 min-w-0">
          <details className="opacity-40 hover:opacity-60 transition-opacity text-xs">
            <summary className="cursor-pointer select-none text-[var(--app-hint)] py-0.5">
              Response to background agent
            </summary>
            <div className="mt-1 rounded-lg bg-[var(--app-subtle-bg)]/50 px-3 py-2 text-[var(--app-fg)]/60 text-xs">
              {textContent}
            </div>
          </details>
        </div>
      </MessagePrimitive.Root>
    );
  }

  if (isMeta && isStandaloneMeta && !toolOnly) {
    // #2162: a standalone synthetic/meta message (stop-hook feedback, system-reminder /
    // caveat) renders as a dimmed, collapsed chip that expands on click — so the thread
    // visually ends on Claude's response, not hook exhaust. This is the isTaskNotification
    // twin above with the flag + label swapped.
    // #3778 (Task 4, ii): GATED on `allAgentTextMeta` so this whole-MESSAGE early return
    // fires ONLY for a genuine all-meta message. A joined run whose FIRST block is meta
    // ([hook, resp] / [resp1, hook]) would otherwise be swallowed into one chip (the
    // #2162 latent run-swallow) — now such a run falls through to per-part rendering, where
    // NarrationAwareText draws the hook banner and the responses render as prose.
    // Label + body read `metaTextContent` (Task 4, iii), NOT `textContent` (which now
    // excludes meta and would leave the chip empty).
    const metaChipLabel = metaTextContent.startsWith("Stop hook feedback")
      ? "Stop hook feedback"
      : "Hidden context";
    return (
      <MessagePrimitive.Root className="py-1 flex min-w-0 max-w-full overflow-x-hidden">
        <BookmarkGutter messageId={messageId} />
        <div className="flex-1 min-w-0">
          <details className="opacity-40 hover:opacity-60 transition-opacity text-xs">
            <summary className="cursor-pointer select-none text-[var(--app-hint)] py-0.5">
              {metaChipLabel}
            </summary>
            <div className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-[var(--app-subtle-bg)]/50 px-3 py-2 text-[var(--app-fg)]/60 text-xs">
              {metaTextContent}
            </div>
          </details>
        </div>
      </MessagePrimitive.Root>
    );
  }

  // Don't show copy button for tool-only messages (no text content)
  const showCopyButton = !toolOnly && textContent.length > 0;

  // Output-only (#2625, R3): when the message has ANY hideable parts (tool cards
  // and/or reasoning), fold them behind ONE per-message reveal affordance. Text
  // and safety-floor tools still render (the collapsed map keeps them visible);
  // expanding swaps to the full map inside the reveal-override context so every
  // hidden part — reasoning included — stays reachable through one channel.
  const outputOnlyActive =
    !chatSections.toolRuns.visible &&
    !chatSections.reasoning.visible &&
    (hideableToolCount > 0 || hasReasoning);

  // #2990 (S3, R1/R5): first-line plain-text preview shown on the collapsed row.
  const responsePreview = collapsed ? messagePreview(textContent) : "";

  return (
    <MessagePrimitive.Root className={rootClass}>
      <BookmarkGutter messageId={messageId} />
      {/* #3017 round-2 feedback: `data-cat="response"` sits on the WHOLE
          section container (heading + body + footer), so the S4 category
          border spans everything the heading would collapse — and its
          padding-left indents nested tool cards, keeping the response border
          unbroken with tool borders inside it. Applied only when the labeled
          heading exists (never tool-only rows). */}
      <div
        className="flex-1 min-w-0"
        {...(showCopyButton ? { "data-cat": "response" } : {})}
      >
        {/* #2990 (S3): manual collapse affordance. Reuses the S2 `CompactChevron`
          row idiom (epic ruling b2) and matches `CollapsibleSectionRow`'s button
          styling. Shown only for messages with collapsible text (never
          tool-only — S2 owns tool-run collapse). Real <button> with
          `aria-expanded` (Task 5). */}
        {showCopyButton ? (
          <div className="min-w-0 max-w-full">
            {/* Epic #3285 round 14: no horizontal padding on the wrapper or the
                button (was px-1 + px-1) so the chevron shares the reasoning /
                narration / tools column inside the category gutter. */}
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCollapsed(c => !c)}
              aria-expanded={!collapsed}
              aria-label={collapsed ? "Expand response" : "Collapse response"}
              className={cn(
                "group flex h-auto min-w-0 max-w-full items-center justify-start gap-2 rounded px-0 py-0.5",
                "text-left text-xs font-normal text-[var(--app-hint)] transition-colors",
                "cursor-pointer hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
              )}
            >
              <CompactChevron open={!collapsed} />
              {/* #3017 feedback: the content-type label is ALWAYS visible —
                  expanded and collapsed alike — and reads "System".
                  Epic #3285 round 14: the expanded-state dimming (opacity-40)
                  moved from the whole button onto this LABEL only — inside the
                  button it multiplied the category-tinted chevron down to 40%,
                  which is why the purple System chevron read darker than its own
                  gutter border. The chevron now keeps the full border color. */}
              <span
                className={cn(
                  "shrink-0 font-medium transition-opacity",
                  collapsed ? "" : "opacity-40 group-hover:opacity-100"
                )}
              >
                System
              </span>
              {collapsed ? (
                <span className="min-w-0 flex-1 truncate">
                  {responsePreview}
                </span>
              ) : null}
            </Button>
          </div>
        ) : null}
        {collapsed ? (
          // Manual collapse: swap the map (text hidden — preview is the row above;
          // tools stay at the safety floor) rather than unmount Content, so a
          // pending-permission tool card survives collapse (expert-review R5).
          <MessagePrimitive.Content components={MANUAL_COLLAPSED_COMPONENTS} />
        ) : outputOnlyActive ? (
          <HiddenToolSummary
            toolCount={hideableToolCount}
            hasNarration={hasNarration}
            hasReasoning={hasReasoning}
          >
            {revealed => (
              <MessagePrimitive.Content
                components={
                  revealed
                    ? MESSAGE_PART_COMPONENTS
                    : OUTPUT_ONLY_COLLAPSED_COMPONENTS
                }
              />
            )}
          </HiddenToolSummary>
        ) : (
          <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />
        )}
        {/* Copy button and timestamp - OUTSIDE content, below it, left-aligned */}
        {/* Hover-to-reveal on desktop, subtle-always on mobile (touch devices) */}
        {/* #2990 (S3, R6/KD2): the metadata footer hides with the body when the
          message is collapsed — a collapsed message is a one-line space-saving
          preview, and copy stays reachable on expand (it copies full textContent,
          never the preview). No dead controls in the collapsed state. */}
        {!collapsed && showCopyButton ? (
          <div className="mt-1 px-1 opacity-40 hover:opacity-100 transition-opacity">
            {/* Row 1: copy + timestamp + duration + status + tokens + cost (issue #1945) */}
            <div className="flex flex-wrap items-center justify-start gap-2">
              <CopyButton
                text={textContent}
                aria-label="Copy message"
                title="Copy message"
                onCopied={ok => ok && showToast("Copied!")}
              />
              <span className="text-[11px] text-[var(--app-hint)]">
                {formatMessageTimestamp(createdAt)}
              </span>
              {turnDurationMs != null ? (
                <>
                  <span className="text-[11px] text-[var(--app-hint)]">•</span>
                  <span className="inline-flex items-center gap-0.5 text-[11px] text-[var(--app-hint)]">
                    (<StopwatchIcon className="inline h-2.5 w-2.5" />
                    {formatTurnDuration(turnDurationMs)})
                  </span>
                </>
              ) : null}
              {turnStatusText ? (
                <>
                  <span className="text-[11px] text-[var(--app-hint)]">•</span>
                  <span className="text-[11px] text-[var(--app-hint)]">
                    {turnStatusText}
                  </span>
                </>
              ) : null}
              {turnTokens != null &&
              (turnTokens.tokOut != null || turnTokens.costTotal != null) ? (
                <>
                  {turnTokens.tokOut != null ? (
                    <>
                      <span className="text-[11px] text-[var(--app-hint)]">
                        •
                      </span>
                      <span
                        className="text-[11px] text-[var(--app-hint)]"
                        title="Output tokens Claude generated this turn"
                      >
                        {formatTurnTokenCount(turnTokens.tokOut)} out
                      </span>
                    </>
                  ) : null}
                  {turnTokens.costTotal != null ? (
                    <>
                      <span className="text-[11px] text-[var(--app-hint)]">
                        •
                      </span>
                      {/* Issue #3353: real-vs-EQ per-turn cost, keyed on
                          turnTokens.costTreatment (the single discriminator — no
                          per-flavor conditional). Issue #4824: that treatment is
                          THIS turn's recorded binding (stamped per turn in
                          assistant-runtime), so a key turn and a subscription
                          turn in one transcript keep their own colours across a
                          switch. Size + color stay in ONE plain
                          template string (never cn()) so twMerge cannot collapse
                          the size against the color (composites.md:246-247). */}
                      <span
                        className={`text-[11px] ${
                          turnTokens.costTreatment === "real"
                            ? "text-[var(--app-accent)]"
                            : turnTokens.costTreatment === "equivalent"
                              ? "text-[var(--cost-equivalent)]"
                              : "text-[var(--app-hint)]"
                        }`}
                        title={
                          turnTokens.costTreatment === "neutral"
                            ? undefined
                            : formatTurnFeeBreakdown(turnTokens)
                        }
                      >
                        {turnTokens.costTreatment === "neutral"
                          ? "—"
                          : formatTurnCost(turnTokens.costTotal)}
                        {turnTokens.costTreatment === "equivalent" ? (
                          <span
                            className={
                              /* design-tokens-allow: 9px "EQ." marker — mirrors the est. sub-floor micro-label exception (#3336) */ "ml-0.5 text-[9px] uppercase tracking-wide text-[var(--cost-equivalent)]"
                            }
                          >
                            EQ.
                          </span>
                        ) : null}
                      </span>
                    </>
                  ) : null}
                </>
              ) : null}
            </div>
            {/* Row 2: workflow chips (issue #1945) — one per phase, only when present */}
            {turnWorkflow && turnWorkflow.length > 0 ? (
              <div className="flex flex-wrap items-center justify-start gap-2 mt-0.5">
                {turnWorkflow.map((chip, i) => (
                  <Fragment key={`wf-${i}-${chip.issueNumber}-${chip.kind}`}>
                    {i > 0 ? (
                      <span className="text-[11px] text-[var(--app-hint)]">
                        •
                      </span>
                    ) : null}
                    <span
                      className={
                        chip.kind === "checkpoint"
                          ? "text-[11px] text-[var(--app-link)]"
                          : "text-[11px] text-[var(--app-hint)]"
                      }
                      title={`Workflow ${
                        chip.kind === "checkpoint"
                          ? "checkpoint reached"
                          : "phase started"
                      } this turn on issue #${chip.issueNumber}`}
                    >
                      {chip.display} #{chip.issueNumber}
                    </span>
                  </Fragment>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </MessagePrimitive.Root>
  );
}
