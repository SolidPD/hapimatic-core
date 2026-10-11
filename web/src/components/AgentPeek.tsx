// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronLeft } from "lucide-react";
import type { ApiClient } from "@/api/client";
import type { DecryptedMessage } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Block,
  transcriptBlocks,
} from "@/components/transcripts/TranscriptReader";
import { useAgentTranscript } from "@/hooks/queries/useAgentTranscript";

/**
 * AgentPeek — a READ-ONLY, in-place view of ONE background agent's
 * sub-transcript (issue #4386, R1/R2/R5/R6). Rendered inside the SAME
 * `BackgroundAgentsModal` DialogContent (swapped to `heightVariant="threeQuarter"`),
 * never a second dialog (DD11/DD12).
 *
 * Reuses the transcript-browser pipeline: `transcriptBlocks` + the exported
 * `Block` renderers (SimpleMarkdown + archived tool cards), NEVER the live-thread
 * `ToolCard`/`MarkdownRenderer` primitives (they throw outside a
 * `<ThreadPrimitive.Messages />` scope). A cut tool result's "Show full result"
 * reads the AGENT route via the `{kind:"agent"}` source (TranscriptReader.tsx).
 *
 * Newest-first: the first page is the agent's latest entries; "Load earlier · N
 * more" prepends OLDER pages (R2). No composer (R6).
 */
export type PeekAgent = {
  id: string;
  agentType: string;
  status: "running" | "done" | "error";
  startedAt: number;
  endedAt?: number;
};

/** Compact elapsed: `45s`, `2m 03s`, `1h 04m` (mirrors BackgroundAgentsModal). */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function AgentPeek({
  api,
  sessionId,
  agent,
  now,
  onBack,
}: {
  api: ApiClient;
  sessionId: string;
  agent: PeekAgent;
  now: number;
  onBack: () => void;
}) {
  // #4388 R1: "running" comes from the tracker's status in the session record
  // (passed down as `agent.status`), never from the file — a completion the CLI
  // saw stops the live-tail even if the file's last line hasn't settled.
  const live = agent.status === "running";
  const {
    data,
    isLoading,
    isError,
    hasMore,
    loadMore,
    isLoadingMore,
    loadMoreError,
  } = useAgentTranscript(api, sessionId, agent.id, true, live);

  const blocks = useMemo(
    () => (data ? transcriptBlocks(data.messages as DecryptedMessage[]) : []),
    [data]
  );

  const source = useMemo(
    () => ({ kind: "agent" as const, sessionId, agentId: agent.id }),
    [sessionId, agent.id]
  );

  const color =
    agent.status === "running"
      ? "text-[var(--app-badge-success-text)]"
      : agent.status === "error"
        ? "text-[var(--app-badge-error-text)]"
        : "text-[var(--app-hint)]";
  const end = agent.status === "running" ? now : (agent.endedAt ?? now);
  const elapsed = formatElapsed(Math.max(0, end - agent.startedAt));
  const tokens = data?.tokens;

  // #4388 R1 (A1 pick): auto-follow the tail + a "Jump to latest" pill when
  // scrolled up. The scroll container is the reader; `atBottom` tracks whether
  // the user is following. In jsdom every scroll metric is 0, so `dist` is 0 →
  // `atBottom` stays true and these effects are inert there (the append/merge
  // logic is what the component tests exercise).
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const msgCount = data?.messages.length ?? 0;

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Within ~24px of the bottom counts as "following".
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = dist <= 24;
    atBottomRef.current = next;
    setAtBottom(next);
  }, []);

  // Keep the newest line in view while following (and pin to the bottom on the
  // first render so the peek opens on the agent's latest entries). Reading
  // `atBottomRef` (not the state) avoids re-pinning after the user scrolls up.
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom();
  }, [msgCount, scrollToBottom]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid={`agent-peek-${agent.id}`}
    >
      {/* Header — `pr-12` clears the dialog's absolute close button (✕). */}
      <div className="flex items-center gap-2 border-b border-[var(--app-border)] px-2 py-2 pr-12">
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0 gap-1 px-2"
          data-testid="agent-peek-back"
          onClick={onBack}
        >
          <ChevronLeft className="h-4 w-4" />
          Agents
        </Button>
        <span className="min-w-0 flex-1 truncate font-semibold text-[length:var(--text-body)] text-[var(--app-fg)]">
          {agent.agentType}
        </span>
      </div>

      {/* META line: agent type · status · elapsed · READ-ONLY (clips at 393px). */}
      <div
        className="flex items-center gap-1.5 overflow-hidden border-b border-[var(--app-border)] px-3 py-1.5 text-[length:var(--text-caption-xs)] tabular-nums text-[var(--app-hint)]"
        data-testid={`agent-peek-meta-${agent.id}`}
      >
        {/* #4388 A1: a pulsing green dot leads the line while the agent runs. */}
        {live ? (
          <span
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--app-badge-success-text)]"
            data-testid={`agent-peek-live-dot-${agent.id}`}
            aria-hidden="true"
          />
        ) : null}
        <span className="truncate">{agent.agentType}</span>
        <span>·</span>
        <span className={color}>{agent.status}</span>
        <span>·</span>
        <span>{elapsed}</span>
        <span>·</span>
        {/* #4388 A1: "LIVE" while running (the peek is still read-only — no
            composer, R6); the label returns to "Read-only" once the agent ends. */}
        {live ? (
          <span className="font-medium uppercase tracking-wide text-[var(--app-badge-success-text)]">
            Live
          </span>
        ) : (
          <span className="font-medium uppercase tracking-wide text-[var(--app-hint)]">
            Read-only
          </span>
        )}
      </div>

      {/* Token row: in · out · cache read · cache write (R5). */}
      {tokens ? (
        <div
          className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-[var(--app-border)] px-3 py-1.5 text-[length:var(--text-caption-xs)] tabular-nums text-[var(--app-hint)]"
          data-testid={`agent-peek-tokens-${agent.id}`}
        >
          <span>in {tokens.in.toLocaleString()}</span>
          <span>out {tokens.out.toLocaleString()}</span>
          <span>cache read {tokens.cacheRead.toLocaleString()}</span>
          <span>cache write {tokens.cacheWrite.toLocaleString()}</span>
        </div>
      ) : null}

      {/* Body: read-only transcript, oldest-above-newest. The `relative` wrapper
          lets the #4388 "Jump to latest" pill float over (not scroll with) the
          reader; the inner div is the scroll container the auto-follow reads. */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="h-full overflow-y-auto px-3 py-3"
        >
          {isLoading ? (
            <p className="py-6 text-sm text-[var(--app-hint)]">
              Loading transcript…
            </p>
          ) : isError || !data ? (
            // Issue #4387 (R5, mixed-version UX): a federated session whose owning
            // node is older (no peek route) answers 404 / not-supported. Render a
            // calm "may need updating" sentinel rather than a raw error loop — the
            // query retries at most once (global retry:1) and the badge/list simply
            // stay absent when a peer omits the field.
            <p
              className="py-6 text-sm text-[var(--app-hint)]"
              data-testid="agent-peek-error"
            >
              This transcript isn&rsquo;t available. If this session runs on
              another node, that node may need updating.
            </p>
          ) : (
            <div
              className="flex flex-col gap-3"
              data-testid="agent-peek-reader"
            >
              {hasMore ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-center"
                  data-testid="agent-peek-load-earlier"
                  disabled={isLoadingMore}
                  onClick={loadMore}
                >
                  {isLoadingMore
                    ? "Loading…"
                    : loadMoreError
                      ? `Could not load earlier — retry (${data.remaining} more)`
                      : `Load earlier · ${data.remaining} more`}
                </Button>
              ) : null}
              {blocks.map(block => (
                <Block
                  key={block.id}
                  api={api}
                  source={source}
                  block={block}
                  cuts={data.truncatedToolResults}
                />
              ))}
            </div>
          )}
        </div>
        {/* #4388 A1: the "Jump to latest" pill appears when the user has scrolled
            up off the tail; tapping it re-follows the newest entries. */}
        {data && !atBottom ? (
          <Button
            type="button"
            variant="ghostStatic"
            size="bare"
            data-testid={`agent-peek-jump-latest-${agent.id}`}
            onClick={() => {
              atBottomRef.current = true;
              setAtBottom(true);
              scrollToBottom();
            }}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-[var(--app-accent)] px-3 py-1 text-[length:var(--text-caption)] font-semibold text-[var(--app-bg)] shadow-md hover:opacity-90"
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </Button>
        ) : null}
      </div>
    </div>
  );
}
