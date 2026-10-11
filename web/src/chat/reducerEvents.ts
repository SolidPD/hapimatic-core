// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentEvent,
  AgentEventBlock,
  ChatBlock,
  NormalizedMessage,
} from "@/chat/types";

function parseClaudeUsageLimit(text: string): number | null {
  const match = text.match(/^Claude AI usage limit reached\|(\d+)$/);
  if (!match) return null;
  const timestamp = Number.parseInt(match[1], 10);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp;
}

export function parseMessageAsEvent(msg: NormalizedMessage): AgentEvent | null {
  if (msg.isSidechain) return null;
  if (msg.role !== "agent") return null;

  for (const content of msg.content) {
    if (content.type === "text") {
      const limitReached = parseClaudeUsageLimit(content.text);
      if (limitReached !== null) {
        return { type: "limit-reached", endsAt: limitReached };
      }
    }
  }

  return null;
}

export function dedupeAgentEvents(blocks: ChatBlock[]): ChatBlock[] {
  const result: ChatBlock[] = [];
  let prevEventKey: string | null = null;
  let prevTitleChangedTo: string | null = null;

  for (const block of blocks) {
    if (block.kind !== "agent-event") {
      result.push(block);
      prevEventKey = null;
      prevTitleChangedTo = null;
      continue;
    }

    const event = block.event as { type: string; [key: string]: unknown };
    if (event.type === "title-changed" && typeof event.title === "string") {
      const title = event.title.trim();
      const key = `title-changed:${title}`;
      if (key === prevEventKey) {
        continue;
      }
      result.push(block);
      prevEventKey = key;
      prevTitleChangedTo = title;
      continue;
    }

    // For api-error events, only keep the most recent one in a consecutive run.
    // Each retry tick produces a new event with updated retryAttempt/retryInSeconds
    // but the user only needs to see the current state.
    if (event.type === "api-error") {
      if (prevEventKey?.startsWith("api-error:")) {
        // Replace the previous api-error block with this newer one
        result.pop();
      }
      result.push(block);
      prevEventKey = `api-error:${event.retryAttempt}`;
      prevTitleChangedTo = null;
      continue;
    }

    if (event.type === "message" && typeof event.message === "string") {
      const message = event.message.trim();
      const key = `message:${message}`;
      if (key === prevEventKey) {
        continue;
      }
      if (prevTitleChangedTo && message === prevTitleChangedTo) {
        continue;
      }
      result.push(block);
      prevEventKey = key;
      prevTitleChangedTo = null;
      continue;
    }

    // #3579: NEVER fold consecutive gate-denied notices. A denial is a distinct
    // real event (three identical `replayed` refusals ARE three refusals), not a
    // redundant repaint like a title-changed / retrying api-error tick — the
    // generic JSON.stringify key below would drop a byte-identical repeat. This
    // is the SECOND of two defenses; the first is the required ms-precision `at`
    // that already makes each record byte-distinct.
    // #4936: the same never-fold rule for spend-limit stop notices — each one is
    // a distinct failed turn, not a redundant repaint.
    if (event.type === "gate-denied" || event.type === "spend-limit-reached") {
      result.push(block);
      prevEventKey = null;
      prevTitleChangedTo = null;
      continue;
    }

    let key: string;
    try {
      key = `event:${JSON.stringify(event)}`;
    } catch {
      key = `event:${String(event.type)}`;
    }

    if (key === prevEventKey) {
      continue;
    }

    result.push(block);
    prevEventKey = key;
    prevTitleChangedTo = null;
  }

  return result;
}

/**
 * Fold consecutive api-error events, keeping only the latest state.
 */
export function foldApiErrorEvents(blocks: ChatBlock[]): ChatBlock[] {
  const result: ChatBlock[] = [];

  for (const block of blocks) {
    if (block.kind !== "agent-event") {
      result.push(block);
      continue;
    }

    const event = block.event as { type: string };
    if (event.type !== "api-error") {
      result.push(block);
      continue;
    }

    const prev = result[result.length - 1] as AgentEventBlock | undefined;
    if (
      prev?.kind === "agent-event" &&
      (prev.event as { type: string }).type === "api-error"
    ) {
      result[result.length - 1] = block;
    } else {
      result.push(block);
    }
  }

  return result;
}
