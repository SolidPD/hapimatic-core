// SPDX-License-Identifier: AGPL-3.0-only
import {
  useState,
  useEffect,
  useMemo,
  useRef,
  type FC,
  type PropsWithChildren,
} from "react";
import { useAssistantState, useMessage } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useHappyChatContext } from "@/components/AssistantChat/context";
import { getChatSectionRenderHints } from "@/chat/presentation";
import {
  REASONING_HIDDEN_BY_CLAUDE_PREVIEW,
  isHiddenReasoningText,
  isThinkingPlaceholderPart,
  isThinkingPlaceholderText,
  thinkingPlaceholderLabel,
} from "@/chat/reasoningPlaceholder";
import {
  isReasoningGroupCollapsed,
  reasoningGroupKey,
  setReasoningGroupCollapsed,
} from "@/chat/reasoningCollapseMemory";
import { useStalePlaceholderLabel } from "@/hooks/useStalePlaceholderLabel";
import {
  defaultComponents,
  MARKDOWN_PLUGINS,
} from "@/components/assistant-ui/markdown-text";

function ChevronIcon(props: { className?: string; open?: boolean }) {
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
        // `hapi-cat-chevron`: S4 marker (#2991) tinted by `[data-cat] .hapi-cat-chevron`
        // — the reasoning group's chevron picks up `--cat-reasoning`.
        "hapi-cat-chevron transition-transform duration-200",
        props.open ? "rotate-90" : "",
        props.className
      )}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

/**
 * Renders individual reasoning message part content with markdown support.
 */
export const Reasoning: FC = () => {
  // #3177: the activity placeholder has no body. In a group where it follows real
  // reasoning (output-only reveal), render nothing for the placeholder part.
  const partText = useAssistantState(
    ({ part }) => (part as { text?: string }).text
  );
  if (isThinkingPlaceholderText(partText)) return null;
  return (
    <MarkdownTextPrimitive
      remarkPlugins={MARKDOWN_PLUGINS}
      components={defaultComponents}
      className={cn(
        "aui-reasoning-content min-w-0 max-w-full break-words text-sm text-[var(--app-hint)]"
      )}
    />
  );
};

/**
 * #3177: the in-thread activity placeholder — ONE quiet header row (no chevron,
 * no toggle, no preview, no body; KD4/R8). It always carries the teal
 * `reasoning-sweep-active` sweep (D2): the placeholder exists only while the user
 * is waiting and is always the last part, so it can never double-sweep with a
 * real reasoning group. Reduced-motion suppression comes from the same class.
 * Also rendered by the AssistantMessage hide maps, so it shows under every
 * chat-section preference (R6).
 */
export const ThinkingPlaceholderShell: FC<{ label: string }> = ({ label }) => (
  <div
    className="aui-reasoning-group aui-thinking-placeholder my-2"
    data-cat="reasoning"
    data-thinking-placeholder=""
    role="status"
    aria-live="polite"
  >
    <span className="text-xs font-medium reasoning-sweep-active">{label}</span>
  </div>
);

/**
 * Wraps consecutive reasoning parts in a collapsible container.
 * Shows shimmer effect while reasoning is streaming.
 */
export const ReasoningGroup: FC<
  PropsWithChildren<{ startIndex?: number; endIndex?: number }>
> = ({ children, startIndex, endIndex }) => {
  // #2989 (S2, R8/R9): the reasoning section's default collapse state comes from
  // the S1 preference (`reasoning.defaultState` → `hints.reasoning`), not a
  // hardcoded collapsed. `"shown"` (visible + expanded) opens by default;
  // `"collapsed"`/`"hidden"` start closed with an N-line preview. Manual toggle is
  // always available. `ReasoningGroup` still never returns `null` — the fully
  // hidden (both-category) hide is owned by the message-layer wrapper
  // (HiddenToolSummary) — so all hooks below run unconditionally (no hooks-order
  // hazard) and reasoning stays reachable via that one reveal affordance.
  const { chatSections, sessionId } = useHappyChatContext();
  const hints = getChatSectionRenderHints(chatSections);
  const { autoExpandStreamingReasoning } = hints;
  const previewLines = chatSections.reasoning.previewLines;
  const message = useMessage();

  // #4045 (operator ruling P2; scope: per session, tab lifetime): a group the user
  // collapsed by hand stays collapsed for the rest of the session. The choice is
  // keyed per session in a tab-lifetime store so it survives a remount (e.g.
  // navigating away and back). The ref is the per-instance copy the auto-expand
  // effect reads — seeded from the store once at mount, then updated by toggleOpen
  // — and the fallback when no message/session id exists (direct-render tests).
  const groupKey = reasoningGroupKey(message.id, startIndex);
  const userCollapsedRef = useRef(
    isReasoningGroupCollapsed(sessionId, groupKey)
  );
  const [isOpen, setIsOpen] = useState(
    () => !userCollapsedRef.current && hints.reasoning === "shown"
  );
  const toggleOpen = () => {
    const next = !isOpen;
    userCollapsedRef.current = !next;
    setReasoningGroupCollapsed(sessionId, groupKey, !next);
    setIsOpen(next);
  };

  // Check if reasoning is still streaming
  const isStreaming =
    message.status?.type === "running" &&
    message.content.length > 0 &&
    message.content[message.content.length - 1]?.type === "reasoning";

  // #3168: scope the R5-3 sweep to ONLY the reasoning group at the streaming tail.
  // assistant-ui already supplies each ReasoningGroup its part range via `endIndex`
  // (@assistant-ui/react MessageParts renders <ReasoningGroup startIndex endIndex>).
  // Because `isStreaming` already requires the message's LAST part to be reasoning,
  // adding `endIndex === lastPartIndex` makes this true for EXACTLY the tail reasoning
  // group and false for any earlier reasoning group merged into the same turn. The
  // `?? lastPartIndex` fallback keeps direct-render callers (unit tests that omit
  // `endIndex`) tail-active — in production assistant-ui always passes it (KD3/OR1).
  const lastPartIndex = message.content.length - 1;
  const isActiveReasoningTail =
    isStreaming && (endIndex ?? lastPartIndex) === lastPartIndex;

  // #4046 (closes OR2): this group's own part range. assistant-ui passes
  // startIndex/endIndex to every ReasoningGroup (MessageParts); the whole-message
  // fallback keeps direct-render callers (unit tests) byte-identical to before.
  const groupParts = useMemo(
    () =>
      message.content.slice(startIndex ?? 0, (endIndex ?? lastPartIndex) + 1),
    [message.content, startIndex, endIndex, lastPartIndex]
  );
  // #3177: the activity placeholder is not reasoning text — never preview it.
  const groupReasoningParts = useMemo(
    () =>
      groupParts.filter(
        part => part.type === "reasoning" && !isThinkingPlaceholderPart(part)
      ),
    [groupParts]
  );

  // #3156 R5-1 / #4046: this group is the app-generated "hidden by Claude"
  // affordance when every reasoning part in ITS range is the fixed placeholder.
  // Only this case gets the one-line compact preview; real reasoning (Codex
  // thinking) keeps the multi-line preview.
  const isHiddenPlaceholder = useMemo(
    () =>
      groupReasoningParts.length > 0 &&
      groupReasoningParts.every(part =>
        isHiddenReasoningText((part as { text?: string }).text)
      ),
    [groupReasoningParts]
  );

  // R8 / #4046: collapsed reasoning shows a preview of the first `previewLines`
  // non-empty lines of THIS group's thinking text. The preview renders raw text,
  // so the hidden sentinel is swapped for its plain-text form (no `_…_` markers),
  // and a hidden-only group previews it exactly once.
  const previewText = useMemo(() => {
    if (previewLines <= 0) return "";
    if (isHiddenPlaceholder) return REASONING_HIDDEN_BY_CLAUDE_PREVIEW;
    const text = groupReasoningParts
      .map(part => {
        const partText = (part as { text?: string }).text;
        return isHiddenReasoningText(partText)
          ? REASONING_HIDDEN_BY_CLAUDE_PREVIEW
          : (partText ?? "");
      })
      .join("\n");
    return text
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .slice(0, previewLines)
      .join("\n");
  }, [groupReasoningParts, isHiddenPlaceholder, previewLines]);

  // #3177: this group is the activity placeholder when EVERY part in its range is
  // the placeholder sentinel (a mixed group renders as normal reasoning).
  const placeholderLabel = useMemo(() => {
    const last = groupParts[groupParts.length - 1] as
      | { text?: string }
      | undefined;
    return groupParts.length > 0 && groupParts.every(isThinkingPlaceholderPart)
      ? thinkingPlaceholderLabel(last?.text)
      : null;
  }, [groupParts]);
  const isThinkingPlaceholder = placeholderLabel !== null;
  // #3177: keeps the shell through assistant-ui's one stale-range commit (see
  // useStalePlaceholderLabel) instead of flashing a header or blinking the row.
  const shellLabel = useStalePlaceholderLabel(
    placeholderLabel,
    message.content[endIndex ?? message.content.length - 1]
  );

  // Auto-expand while streaming — gated by the detail level (#2625): only `full`
  // force-opens the panel; `compact`/`output-only` leave it collapsed. #3180: gate
  // on `isActiveReasoningTail` (the #3168 tail flag above), NOT the turn-scoped
  // `isStreaming`, so ONLY the streaming tail reasoning group force-opens — earlier
  // reasoning groups merged into the same running turn (reason → tool → reason) no
  // longer ALL force-open. The flag already ANDs `isStreaming`, so the streaming
  // precondition is preserved; the matching dep-array swap stops the effect re-firing
  // turn-scoped on the next `isStreaming` rising edge (and re-opening an earlier group
  // the user manually collapsed). Same tail-scoping the heading sweep `<span>` uses.
  // #3177 (refresh §E): the placeholder never force-opens (it has no body), and
  // `isThinkingPlaceholder` is a dep so that when the REAL reasoning replaces it on
  // this same instance (isActiveReasoningTail stays true) the effect re-fires.
  // #4045 (P2): the tail flag inherits raw `session.thinking` flicker, so a flap
  // re-fires this effect on a false→true edge. A group the user collapsed by hand
  // is never force-opened again; the ref is read here (not a dep) so the #3180 dep
  // array is unchanged and a manual toggle does not re-run the effect.
  useEffect(() => {
    if (
      isActiveReasoningTail &&
      autoExpandStreamingReasoning &&
      !isThinkingPlaceholder &&
      !userCollapsedRef.current
    ) {
      setIsOpen(true);
    }
  }, [
    isActiveReasoningTail,
    autoExpandStreamingReasoning,
    isThinkingPlaceholder,
  ]);

  if (shellLabel !== null) {
    return <ThinkingPlaceholderShell label={shellLabel} />;
  }

  return (
    // #2989 (S2, coordination b3): the stable per-category hook S4 tints via
    // `[data-cat="reasoning"]`.
    <div className="aui-reasoning-group my-2" data-cat="reasoning">
      <Button
        type="button"
        variant="ghostStatic"
        onClick={toggleOpen}
        className={cn(
          // #3464: ghostStatic (hover-inert rest colors) + convert-with-overrides:
          // h-auto/p-0 cancel the base control-height/padding (kept at the call site
          // rather than size="bare" so the base rounded-md focus-ring radius is
          // unchanged), justify-start cancels justify-center, flex cancels
          // inline-flex. The hint→fg hover text shift is pinned explicitly (OQ7b).
          "flex h-auto items-center justify-start gap-1.5 p-0 text-xs font-medium",
          "hover:text-[var(--app-fg)]",
          "cursor-pointer select-none"
        )}
      >
        <ChevronIcon open={isOpen} />
        {/* #3156 R5-3 / #3168: while the reasoning group is the streaming tail, the
            heading label shows a teal (--cat-reasoning) Knight-Rider sweep — the
            "work in progress" indicator (replaces the former shimmer dot). #3168
            scopes it to the tail group only (isActiveReasoningTail), so earlier
            reasoning blocks merged into the same turn stay static. Static once
            complete; suppressed under prefers-reduced-motion (see
            .reasoning-sweep-active in index.css). */}
        <span className={cn(isActiveReasoningTail && "reasoning-sweep-active")}>
          Reasoning
        </span>
      </Button>

      {!isOpen && previewText ? (
        <div
          className={cn(
            "aui-reasoning-preview pl-4 pt-1 text-xs text-[var(--app-hint)] opacity-70 break-words",
            // #3156 R5-1: the app-generated "hidden by Claude" affordance is a single
            // fixed sentence — render it as ONE compact line (no 3-line word-wrap).
            // Real reasoning keeps its multi-line preview.
            isHiddenPlaceholder ? "line-clamp-1" : "whitespace-pre-wrap"
          )}
        >
          {previewText}
        </div>
      ) : null}

      <div
        className={cn(
          "overflow-hidden transition-all duration-200 ease-in-out",
          isOpen
            ? "max-h-[5000px] opacity-100" // design-tokens-allow: collapse-animation max-height sentinel, not a spacing value
            : "max-h-0 opacity-0"
        )}
      >
        <div className="pl-4 pt-2 border-l-2 border-[var(--app-border)] ml-0.5">
          {children}
        </div>
      </div>
    </div>
  );
};
