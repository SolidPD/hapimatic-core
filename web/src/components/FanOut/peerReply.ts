// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Peer reply excerpts and the approval-token neutralizer (#4469 Task 2).
 *
 * The review prompt inlines each peer's final reply. It is read with the
 * web's own JWT through the same normalize + reduce chain the live chat uses,
 * so it works for every harness (claude, codex, gemini, opencode).
 */
import type { DecryptedMessage } from "@/types/api";
import type { AgentTextBlock, NormalizedMessage } from "@/chat/types";
import { normalizeDecryptedMessage } from "@/chat/normalize";
import { reduceChatBlocks } from "@/chat/reducer";

/**
 * The server's approval-token ACCEPTOR pattern (`USER_APPROVAL_ACCEPT_REGEX`,
 * server/src/services/approvalTokens.ts), copied because `web/` cannot import
 * from `server/`. Keep the two in step. A queued message containing a match
 * ANYWHERE is denied by the gate-class message hook and dropped at drain
 * (a queued send carries no origin, so it is always provenance-rejected).
 */
const APPROVAL_TOKEN_PATTERN = /USER-APPROVAL-[A-Z2-9]{4}-[A-Z2-9]{4}/g;

export const APPROVAL_TOKEN_REPLACEMENT = "[approval token removed]";

/** Rewrite every approval-token-shaped string so a queued prompt survives. */
export function neutralizeGateTokens(text: string): string {
  return text.replace(APPROVAL_TOKEN_PATTERN, APPROVAL_TOKEN_REPLACEMENT);
}

/**
 * The agent-text blocks of a transcript, oldest first, without meta chips
 * (#2162 synthetic records). Task notifications and narration are kept so the
 * caller can decide; `isFinalText` tells them apart.
 */
export function agentTextBlocks(
  messages: readonly DecryptedMessage[]
): AgentTextBlock[] {
  return agentTextBlocksAfter(messages, () => false);
}

/**
 * Like `agentTextBlocks`, but only the blocks after the newest user message
 * whose text `isStart` accepts (all of them when none does). The ranking
 * reader uses it to read only the reply to the newest review request.
 */
export function agentTextBlocksAfter(
  messages: readonly DecryptedMessage[],
  isStart: (userText: string) => boolean
): AgentTextBlock[] {
  const normalized = messages
    .map(m => normalizeDecryptedMessage(m))
    .filter((m): m is NormalizedMessage => m !== null);
  const blocks = reduceChatBlocks(normalized, null).blocks;
  let start = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.kind === "user-text" && isStart(block.text)) {
      start = i + 1;
      break;
    }
  }
  return blocks
    .slice(start)
    .filter((b): b is AgentTextBlock => b.kind === "agent-text" && !b.isMeta);
}

/**
 * A turn's final response: not a task notification and not narration (#3154:
 * interstitial text before a tool call).
 */
export function isFinalText(block: AgentTextBlock): boolean {
  return !block.isTaskNotification && block.category !== "narration";
}

/** Keep the END of `text` (where conclusions sit) within `maxChars`. */
export function truncateFromStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const limit = Math.max(0, maxChars);
  const dropped = text.length - limit;
  return `[…truncated ${dropped} chars]\n${text.slice(text.length - limit)}`;
}

/**
 * The peer's last final reply, truncated from the start to `maxChars` and
 * neutralized. Falls back to the last non-meta agent text when the turn has no
 * final response; `null` when the peer wrote no agent text at all.
 */
export function lastAgentReply(
  messages: readonly DecryptedMessage[],
  maxChars: number
): string | null {
  const blocks = agentTextBlocks(messages);
  const finals = blocks.filter(isFinalText);
  const pick = finals[finals.length - 1] ?? blocks[blocks.length - 1];
  if (!pick) return null;
  // Neutralize BEFORE truncating: a suffix of neutralized text cannot hold a
  // token, and the result stays within maxChars plus the marker.
  return truncateFromStart(neutralizeGateTokens(pick.text.trim()), maxChars);
}

/** How many recent messages are fetched per peer for its excerpt. */
export const PEER_REPLY_FETCH_LIMIT = 50;
