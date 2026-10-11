// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import type { ChatBlock } from "@/chat/types";
import type { Session } from "@/types/api";
import { useChatSectionPrefs } from "@/hooks/useChatSectionPrefs";
import { STALE_THRESHOLD_MS } from "@/hooks/useSessionStaleness";
import {
  PLACEHOLDER_HOLD_MS,
  appendThinkingPlaceholder,
  classifyTurnTail,
  decidePlaceholder,
} from "@/chat/thinkingPlaceholder";

/**
 * #3177: derives the chat blocks to render, with the in-thread activity
 * placeholder appended at the tail while the user is waiting (decision logic:
 * `@/chat/thinkingPlaceholder`). Also owns the running-tool signals SessionChat
 * previously computed inline, because the placeholder consumes them and they must
 * stay computed on the RAW blocks (computing them on the augmented array would
 * cycle).
 *
 * State that must persist across renders lives here: the localId of this
 * client's latest send (trigger (a) survives the bubble's server echo), and the
 * R3 hide-hold. Both are read and written during render on purpose — the hold
 * must apply in the SAME commit the signal drops, or the placeholder flickers
 * for one frame.
 */
export function useThinkingPlaceholder(args: {
  api: ApiClient | null;
  blocks: ChatBlock[];
  session: Pick<Session, "active" | "thinking" | "metadata">;
}): {
  blocks: ChatBlock[];
  hasRunningTools: boolean;
  runningToolsStartedAt: number | null;
} {
  const { blocks, session } = args;
  // Detect if any tools are currently executing (running or pending approval).
  // Used to keep the session timer running even when session.thinking briefly
  // goes false during tool execution (SDK result messages / keepAlive gaps).
  const hasRunningTools = useMemo(
    () =>
      blocks.some(
        (b: ChatBlock) =>
          b.kind === "tool-call" &&
          (b.tool.state === "running" || b.tool.state === "pending")
      ),
    [blocks]
  );

  // #3505 (ruling D7): the newest running/pending tool block's start time (ms
  // epoch), passed to SessionHeader so it can bound `hasRunningTools` by recency
  // — a running tool keeps the header's "thinking" indicator alive only while it
  // started within STALE_THRESHOLD_MS (60s). null when no tool is running.
  // ToolCallBlock.createdAt is always a number, so the newest is a reliable
  // "how long has this been running" measure for the staleness check.
  const runningToolsStartedAt = useMemo(() => {
    let newest: number | null = null;
    for (const b of blocks) {
      if (
        b.kind === "tool-call" &&
        (b.tool.state === "running" || b.tool.state === "pending")
      ) {
        if (newest == null || b.createdAt > newest) newest = b.createdAt;
      }
    }
    return newest;
  }, [blocks]);

  const { prefs } = useChatSectionPrefs(args.api);
  // Q-A option 1: only the both-hidden (output-only) fold hides a live tail.
  const outputOnlyHidden = !prefs.toolRuns.visible && !prefs.reasoning.visible;
  const tail = useMemo(
    () => classifyTurnTail(blocks, outputOnlyHidden),
    [blocks, outputOnlyHidden]
  );

  // Trigger (a) memory: the localId of this client's latest optimistic send.
  const sendLocalIdRef = useRef<string | null>(null);
  const lastUser = tail.lastUser;
  if (
    lastUser?.localId &&
    (lastUser.status === "sending" || lastUser.status === "sent")
  ) {
    sendLocalIdRef.current = lastUser.localId;
  }

  const [, setTick] = useState(0);
  const nowMs = Date.now();
  // D1 (#3505 recency bound): an orphaned running tool (its tool_result lost) is
  // not a running turn, so it must not pin the placeholder on an idle thread.
  const hasRecentRunningTools =
    hasRunningTools &&
    (runningToolsStartedAt == null ||
      nowMs - runningToolsStartedAt < STALE_THRESHOLD_MS);
  const decision = decidePlaceholder({
    tail,
    thinking: session.thinking,
    active: session.active,
    hasRecentRunningTools,
    pendingSendLocalId: sendLocalIdRef.current,
    flavor: session.metadata?.flavor,
    nowMs,
  });

  // R3 hide-hold: remember when a holdable drop started and what was shown.
  const holdRef = useRef<{ since: number; label: string } | null>(null);
  const shownRef = useRef<string | null>(null);
  let label: string | null = null;
  if (decision.show) {
    label = decision.label;
    holdRef.current = null;
  } else if (decision.holdable && shownRef.current !== null) {
    holdRef.current ??= { since: nowMs, label: shownRef.current };
    if (nowMs - holdRef.current.since < PLACEHOLDER_HOLD_MS) {
      label = holdRef.current.label;
    } else {
      holdRef.current = null;
    }
  } else {
    holdRef.current = null;
  }
  shownRef.current = label;

  // Re-render at the next time-driven change: hold expiry, R7 stall, D1 expiry.
  const deadlines = [
    decision.nextChangeAt,
    holdRef.current ? holdRef.current.since + PLACEHOLDER_HOLD_MS : null,
    hasRecentRunningTools && runningToolsStartedAt != null && !session.thinking
      ? runningToolsStartedAt + STALE_THRESHOLD_MS
      : null,
  ].filter((t): t is number => t !== null);
  const nextAt = deadlines.length ? Math.min(...deadlines) : null;
  useEffect(() => {
    if (nextAt === null) return;
    const timer = setTimeout(
      () => setTick(t => t + 1),
      Math.max(0, nextAt - Date.now()) + 1
    );
    return () => clearTimeout(timer);
  }, [nextAt]);

  const withPlaceholder = useMemo(
    () => (label === null ? blocks : appendThinkingPlaceholder(blocks, label)),
    [blocks, label]
  );
  return { blocks: withPlaceholder, hasRunningTools, runningToolsStartedAt };
}
