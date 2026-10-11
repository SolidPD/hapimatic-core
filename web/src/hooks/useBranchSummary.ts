// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import type { DecryptedMessage, Session } from "@/types/api";
import type { LinkedIssue } from "@hapi/protocol/types";

export type BranchSummary = {
  parentSessionName: string;
  parentSessionEmoji: string | null;
  projectPath: string;
  branchLabel: string | null;
  lastUserMessage: string | null;
  lastAgentResponse: string | null;
  linkedIssue: LinkedIssue | null;
  messageCount: number;
};

const MAX_TEXT_LENGTH = 120;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + "…";
}

/**
 * Extract the text content from a raw DecryptedMessage.
 * Message content varies in shape — user messages have { role: "user", content: [...] }
 * while assistant messages have { role: "assistant", content: [...] }.
 */
function extractMessageText(msg: DecryptedMessage): string | null {
  const content = msg.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== "object") return null;

  // Check for content array (standard Claude message format)
  if (Array.isArray(content.content)) {
    for (const block of content.content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }
    }
  }

  // Direct text field
  if ("text" in content && typeof content.text === "string") {
    return content.text;
  }

  return null;
}

function getMessageRole(msg: DecryptedMessage): "user" | "assistant" | "other" {
  const content = msg.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== "object") return "other";
  if (content.role === "user") return "user";
  if (content.role === "assistant") return "assistant";
  return "other";
}

/**
 * Extract the parent session's name from a title-changed event in the
 * parent message history. Claude emits these when `mcp__hapi__change_title`
 * or the SDK's built-in title setter fires.
 */
function extractParentName(parentMessages: DecryptedMessage[]): string | null {
  // Walk backwards to find the most recent title-changed event
  for (let i = parentMessages.length - 1; i >= 0; i--) {
    const msg = parentMessages[i];
    const content = msg.content as Record<string, unknown> | undefined;
    if (!content || typeof content !== "object") continue;

    // Agent events have { type: "event", event: { type: "title-changed", title: "..." } }
    if (content.type === "event") {
      const event = content.event as Record<string, unknown> | undefined;
      if (
        event &&
        event.type === "title-changed" &&
        typeof event.title === "string"
      ) {
        return event.title;
      }
    }

    // Alternative format: { role: "assistant", content: [...] } containing
    // a result from mcp__hapi__change_title — not reliable to parse.
  }
  return null;
}

/**
 * Computes a structured summary from the parent session's messages
 * and the current (branch) session's metadata.
 *
 * Returns null for non-branch sessions or when no parent data is available.
 */
export function useBranchSummary(
  session: Session,
  parentMessages: DecryptedMessage[]
): BranchSummary | null {
  return useMemo(() => {
    if (!session.parentSessionId || parentMessages.length === 0) {
      return null;
    }

    // Parent session name: branchLabel > title-changed event > fallback
    const parentName =
      session.branchLabel ??
      extractParentName(parentMessages) ??
      "Parent session";

    // Find last user message (walk backwards)
    let lastUserMessage: string | null = null;
    let lastAgentResponse: string | null = null;

    for (let i = parentMessages.length - 1; i >= 0; i--) {
      const role = getMessageRole(parentMessages[i]);
      if (role === "user" && !lastUserMessage) {
        const text = extractMessageText(parentMessages[i]);
        if (text) lastUserMessage = truncate(text.trim(), MAX_TEXT_LENGTH);
      }
      if (role === "assistant" && !lastAgentResponse) {
        const text = extractMessageText(parentMessages[i]);
        if (text) lastAgentResponse = truncate(text.trim(), MAX_TEXT_LENGTH);
      }
      if (lastUserMessage && lastAgentResponse) break;
    }

    return {
      parentSessionName: parentName,
      parentSessionEmoji: session.emoji ?? null,
      projectPath: session.metadata?.path ?? "",
      branchLabel: session.branchLabel ?? null,
      lastUserMessage,
      lastAgentResponse,
      linkedIssue: session.linkedIssue ?? null,
      messageCount: parentMessages.length,
    };
  }, [session, parentMessages]);
}
