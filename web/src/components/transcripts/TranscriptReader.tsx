// SPDX-License-Identifier: AGPL-3.0-only
import { memo, useMemo, useState, type ToggleEventHandler } from "react";
import type { ApiClient } from "@/api/client";
import type { DecryptedMessage } from "@/types/api";
import type { ChatBlock, NormalizedMessage, ToolCallBlock } from "@/chat/types";
import { normalizeDecryptedMessage } from "@/chat/normalize";
import { reduceChatBlocks } from "@/chat/reducer";
import { isLocalCommandOutputText } from "@/chat/reducerCliOutput";
import { getEventPresentation } from "@/chat/presentation";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { CliOutputBlock } from "@/components/CliOutputBlock";
import { CodeBlock } from "@/components/CodeBlock";
import { Button } from "@/components/ui/button";
import { getToolPresentation } from "@/components/ToolCard/knownTools";
import {
  useFullToolResult,
  useTranscriptMessages,
  type ToolResultSource,
} from "@/hooks/queries/useTranscripts";
import { commandEnvelopeText } from "@/lib/commandEnvelope";
import {
  leadingHtmlCommentMarker,
  stripLeadingHtmlComments,
} from "@/lib/htmlCommentMarker";
import { UserMarkerChip } from "@/components/UserMarkerChip";

/**
 * TranscriptReader — a read-only, in-place view of one archived transcript
 * (issue #3839, R3).
 *
 * Pipeline: server-adapted `DecryptedMessage[]` (scrubbed, R6) →
 * `normalizeDecryptedMessage` → `reduceChatBlocks(normalized, null)` → one
 * renderer per `ChatBlock` kind. Deliberately NOT `SessionChat` / `HappyThread`
 * and NOT a second `@assistant-ui` `ThreadPrimitive` runtime (operator ruling):
 * those are bound to a live session (api + sessionId + bookmarks + SSE).
 *
 * Consequence (measured on wt-3011, 2026-09-23): assistant-ui's
 * `MarkdownTextPrimitive` calls `useSmooth`, which unconditionally reads
 * `message.id` from the message scope — so `MarkdownRenderer`, and `ToolCard`
 * (it renders Task prompts / plans / markdown results through it), throw
 * "Message is only available inside <ThreadPrimitive.Messages />" outside a
 * thread. The reader therefore renders text with `SimpleMarkdown` (the
 * documented out-of-thread markdown, web/CLAUDE.md) and each tool call as an
 * archived card built from the tool card's own `getToolPresentation` +
 * `CodeBlock`. No assistant-ui context hook is reachable from this component.
 *
 * #4110: the bodies of collapsed tool cards, reasoning blocks and hidden-context
 * chips mount on first open, and `isMeta` text renders as the live chat's plain
 * chip rather than markdown — a 0.5 MB injected-context block otherwise costs
 * seconds of markdown parsing before the first page appears.
 */

type Props = {
  api: ApiClient;
  ccSessionId: string;
};

export function transcriptBlocks(messages: DecryptedMessage[]): ChatBlock[] {
  const normalized = messages
    .map(m => normalizeDecryptedMessage(m))
    .filter((m): m is NormalizedMessage => m !== null)
    // #4149: the server adapter turns a string user entry into
    // `{role:"user", content:{type:"text"}}` with NO meta (transcripts.ts:150-151),
    // dropping the `sentFrom:"cli"` the live CLI stamps (apiSession.ts:472). So a
    // user turn that is a whole `<local-command-stdout|stderr>` envelope would
    // reduce to a raw user-text bubble. Re-supply the stamp BEFORE reduceChatBlocks
    // — segment classification then matches live chat, and the shared
    // isCliOutputText / createCliOutputBlock / mergeCliOutputBlocks run unchanged.
    // Stamp ONLY whole envelopes: #4044's command bubble (R3) and prose quoting a
    // tag (R2) do not pass the predicate and are untouched. The adapter supplies no
    // meta on user entries, so the spread is a defensive no-op today.
    .map(m =>
      m.role === "user" && isLocalCommandOutputText(m.content.text)
        ? {
            ...m,
            meta: {
              ...(typeof m.meta === "object" && m.meta !== null ? m.meta : {}),
              sentFrom: "cli",
            },
          }
        : m
    );
  return reduceChatBlocks(normalized, null).blocks;
}

/** SimpleMarkdown that skips re-parsing when its text is unchanged (#4110). */
const ReaderMarkdown = memo(SimpleMarkdown);

/**
 * Whether a `<details>` has ever been opened, for mounting its body lazily
 * (#4110). Set once and never reset: a closed-then-reopened card keeps its
 * body mounted, so an expanded full result survives.
 */
function useOpenedOnce(): [boolean, ToggleEventHandler<HTMLDetailsElement>] {
  const [opened, setOpened] = useState(false);
  const onToggle: ToggleEventHandler<HTMLDetailsElement> = e => {
    if (e.currentTarget.open) setOpened(true);
  };
  return [opened, onToggle];
}

const TOOL_TEXT_CAP = 4000;

function capped(text: string): string {
  return text.length > TOOL_TEXT_CAP
    ? `${text.slice(0, TOOL_TEXT_CAP)}\n… (${text.length - TOOL_TEXT_CAP} more characters)`
    : text;
}

/** A tool result as display text (string, content-block array, or JSON). */
export function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map(part =>
        part && typeof part === "object" && typeof part.text === "string"
          ? part.text
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.content === "string") return r.content;
    if (Array.isArray(r.content)) return toolResultText(r.content);
  }
  return JSON.stringify(result, null, 2);
}

/** Where the server cut a tool result (#4053): the entry's seq + full length. */
type ToolResultCut = { seq: number; chars: number };

/**
 * The result text of `toolUseId` inside one untruncated entry, resolved the way
 * `normalizeAgent` resolves it (`toolUseResult` wins over block content).
 */
export function fullToolResultText(
  message: DecryptedMessage,
  toolUseId: string
): string {
  const data = (
    message.content as { content?: { data?: Record<string, unknown> } }
  )?.content?.data;
  const parts = (data?.message as { content?: unknown } | undefined)?.content;
  const part = Array.isArray(parts)
    ? (parts as Array<Record<string, unknown>>).find(
        p => p?.type === "tool_result" && p.tool_use_id === toolUseId
      )
    : undefined;
  return toolResultText(data?.toolUseResult ?? part?.content);
}

function ArchivedToolCall(props: {
  block: ToolCallBlock;
  api: ApiClient;
  source: ToolResultSource;
  cut?: ToolResultCut;
}) {
  const { tool } = props.block;
  const [expanded, setExpanded] = useState(false);
  const full = useFullToolResult(
    props.api,
    props.source,
    props.cut?.seq ?? 0,
    expanded && props.cut !== undefined
  );
  const presentation = getToolPresentation({
    toolName: tool.name,
    input: tool.input,
    result: tool.result,
    childrenCount: props.block.children.length,
    description: tool.description,
    metadata: null,
  });
  // #4110: build the body (input/result CodeBlocks) only once the card is opened.
  const [opened, onToggle] = useOpenedOnce();
  const fullResult =
    opened && expanded && full.message
      ? fullToolResultText(full.message, tool.id)
      : null;
  const result = opened ? (fullResult ?? toolResultText(tool.result)) : "";
  return (
    <details
      className="rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-3 py-2"
      data-testid="transcript-tool-card"
      onToggle={onToggle}
    >
      <summary className="flex min-w-0 cursor-pointer items-center gap-2 text-sm">
        {presentation.icon}
        <span className="min-w-0 shrink truncate font-medium text-[var(--app-fg)]">
          {presentation.title}
        </span>
        {presentation.subtitle ? (
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--app-hint)]">
            {presentation.subtitle}
          </span>
        ) : null}
        {tool.state === "error" ? (
          <span className="text-xs text-[var(--app-badge-error-text)]">
            error
          </span>
        ) : null}
      </summary>
      {opened ? (
        <div className="mt-2 flex flex-col gap-2">
          <CodeBlock
            code={capped(JSON.stringify(tool.input ?? {}, null, 2))}
            language="json"
          />
          {result ? (
            <CodeBlock code={fullResult !== null ? result : capped(result)} />
          ) : null}
          {props.cut && fullResult === null ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              data-testid="transcript-tool-expand"
              disabled={full.isLoading}
              onClick={() => (expanded ? full.retry() : setExpanded(true))}
            >
              {full.isLoading
                ? "Loading the full result…"
                : full.isError
                  ? "Could not load the full result — retry"
                  : `Show full result (${props.cut.chars.toLocaleString()} characters)`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}

/** A reasoning block whose markdown mounts on first open (#4110). */
function ArchivedReasoning(props: { text: string }) {
  const [opened, onToggle] = useOpenedOnce();
  return (
    <details
      className="text-[var(--app-hint)]"
      data-testid="transcript-reasoning"
      onToggle={onToggle}
    >
      <summary className="cursor-pointer text-xs">Reasoning</summary>
      {opened ? <ReaderMarkdown content={props.text} /> : null}
    </details>
  );
}

/**
 * An `isMeta` block (injected hidden context, stop-hook feedback) as the live
 * chat's collapsed chip — same label rule and plain pre-wrapped body as
 * `AssistantMessage.tsx` (#2162), never markdown. Its body mounts on first
 * open, because it can be half a megabyte (#4110).
 */
function ArchivedMetaChip(props: { text: string }) {
  const [opened, onToggle] = useOpenedOnce();
  const label = props.text.startsWith("Stop hook feedback")
    ? "Stop hook feedback"
    : "Hidden context";
  return (
    <details
      className="text-xs opacity-40 transition-opacity hover:opacity-60"
      data-testid="transcript-meta"
      onToggle={onToggle}
    >
      <summary className="cursor-pointer select-none py-0.5 text-[var(--app-hint)]">
        {label}
      </summary>
      {opened ? (
        <div className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-[var(--app-subtle-bg)]/50 px-3 py-2 text-[var(--app-fg)]/60">
          {props.text}
        </div>
      ) : null}
    </details>
  );
}

export function Block(props: {
  api: ApiClient;
  source: ToolResultSource;
  block: ChatBlock;
  cuts: Record<string, ToolResultCut>;
}) {
  const { block } = props;
  switch (block.kind) {
    case "user-text": {
      // #4086: hide a leading machine-marker comment, then #4044's envelope.
      // #4150: show the same marker chip live chat does (UserMessage.tsx) in its
      // place, from the one shared UserMarkerChip, so the two views cannot drift.
      const stripped = stripLeadingHtmlComments(block.text);
      const text = stripped ?? block.text;
      const marker =
        stripped !== null ? leadingHtmlCommentMarker(block.text) : null;
      return (
        <div
          className="ml-auto max-w-[85%] rounded-xl bg-[var(--app-hover)] px-3 py-2"
          data-testid="transcript-user"
        >
          {marker ? <UserMarkerChip marker={marker} /> : null}
          <ReaderMarkdown content={commandEnvelopeText(text) ?? text} />
        </div>
      );
    }
    case "agent-text":
      if (block.isMeta === true) return <ArchivedMetaChip text={block.text} />;
      return (
        <div data-testid="transcript-agent">
          <ReaderMarkdown content={block.text} />
        </div>
      );
    case "agent-reasoning":
      return <ArchivedReasoning text={block.text} />;
    case "cli-output":
      // #4149: a user-side CLI card is right-aligned like live chat
      // (UserMessage.tsx:318); an agent-side card renders full-width. Both carry
      // the same data-testid so the reader test can locate either.
      return (
        <div
          className={
            block.source === "user" ? "ml-auto w-full max-w-[92%]" : undefined
          }
          data-testid="transcript-cli-output"
        >
          <CliOutputBlock text={block.text} />
        </div>
      );
    case "tool-call":
      return (
        <div className="flex flex-col gap-2" data-testid="transcript-tool">
          <ArchivedToolCall
            block={block}
            api={props.api}
            source={props.source}
            cut={props.cuts[block.tool.id]}
          />
          {block.children.length > 0 ? (
            <div className="ml-4 flex flex-col gap-2 border-l border-[var(--app-hover)] pl-3">
              {block.children.map(child => (
                <Block
                  key={child.id}
                  api={props.api}
                  source={props.source}
                  block={child}
                  cuts={props.cuts}
                />
              ))}
            </div>
          ) : null}
        </div>
      );
    case "agent-event": {
      const presentation = getEventPresentation(block.event);
      return (
        <p
          className="text-center text-xs text-[var(--app-hint)]"
          data-testid="transcript-event"
        >
          {presentation.icon ? `${presentation.icon} ` : ""}
          {presentation.text}
        </p>
      );
    }
    default:
      return null;
  }
}

const NO_CUTS: Record<string, ToolResultCut> = {};

export function TranscriptReader(props: Props) {
  const {
    data,
    isLoading,
    isError,
    hasMore,
    loadMore,
    isLoadingMore,
    loadMoreError,
  } = useTranscriptMessages(props.api, props.ccSessionId);
  const blocks = useMemo(
    () => (data ? transcriptBlocks(data.messages as DecryptedMessage[]) : []),
    [data]
  );

  if (isLoading) {
    return (
      <p className="py-6 text-sm text-[var(--app-hint)]">Loading transcript…</p>
    );
  }
  if (isError || !data) {
    return (
      <p
        className="py-6 text-sm text-[var(--app-hint)]"
        data-testid="transcript-reader-error"
      >
        This transcript could not be opened.
      </p>
    );
  }
  const source: ToolResultSource = {
    kind: "transcript",
    ccSessionId: props.ccSessionId,
  };
  return (
    <div className="flex flex-col gap-3" data-testid="transcript-reader">
      {blocks.map(block => (
        <Block
          key={block.id}
          api={props.api}
          source={source}
          block={block}
          cuts={data.truncatedToolResults ?? NO_CUTS}
        />
      ))}
      {hasMore ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-center"
          data-testid="transcript-load-more"
          disabled={isLoadingMore}
          onClick={loadMore}
        >
          {isLoadingMore
            ? "Loading…"
            : loadMoreError
              ? `Could not load more — retry (${data.messages.length} messages shown)`
              : `Load more (${data.messages.length} messages shown)`}
        </Button>
      ) : null}
    </div>
  );
}
