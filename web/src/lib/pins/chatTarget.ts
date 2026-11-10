// SPDX-License-Identifier: AGPL-3.0-only
import type { DecryptedMessage, Pin } from "@hapi/protocol";
import { normalizeDecryptedMessage } from "@/chat/normalize";

// #6453 (R11, KD9): where in the chat a pin was posted, from data the pin
// already has. A fence pin carries `anchor.messageId` (the server message id);
// a tool-posted pin carries `postedSeq`, the session's highest seq when it was
// first posted, a lower bound because the tool call can land just after it.
// Pure, so the jump hook only pages and scrolls.

/** What the jump needs of a pin. */
export type PinChatSpot = Pick<Pin, "key" | "anchor" | "postedSeq">;

/**
 * The `?at=` value that opens the chat where the pin was posted, or null when the
 * pin does not know (no fence anchor and no recorded seq).
 */
export function pinChatAt(pin: PinChatSpot): string | null {
  return pin.anchor !== null || pin.postedSeq !== null
    ? `pin:${pin.key}`
    : null;
}

/** The tool names a pin is posted or revised through (PinChatShims' set). */
const PIN_POST_TOOLS = new Set([
  "mcp__hapi__pin_post",
  "mcp__hapi__pin_update",
  "hapi__pin_post",
  "hapi__pin_update",
]);

/** How many messages before the post the fallback walks back through. */
const FALLBACK_MESSAGES = 20;

/** Messages with a seq, oldest first; optimistic local rows have none. */
function bySeq(messages: readonly DecryptedMessage[]): DecryptedMessage[] {
  return messages
    .filter(m => typeof m.seq === "number")
    .sort((a, b) => (a.seq as number) - (b.seq as number));
}

/**
 * True once paging older messages cannot bring the post any closer: the posting
 * message is loaded (a fence pin), the oldest loaded seq is at or before the
 * pin's `postedSeq` (a tool-posted pin), or no older page remains. A pin that
 * knows neither has nothing to page for.
 */
export function pinPostingLoaded(
  pin: PinChatSpot,
  messages: readonly DecryptedMessage[],
  hasMore: boolean
): boolean {
  if (!hasMore) return true;
  if (pin.anchor) return messages.some(m => m.id === pin.anchor?.messageId);
  if (pin.postedSeq !== null) {
    const ordered = bySeq(messages);
    return ordered.length > 0 && (ordered[0].seq as number) <= pin.postedSeq;
  }
  return true;
}

/** A message's block anchors (`BlockAnchor` ids), in order: parts and tool calls. */
function blockAnchors(message: DecryptedMessage): {
  parts: string[];
  pinCalls: { id: string; key: unknown }[];
} {
  const parts: string[] = [];
  const pinCalls: { id: string; key: unknown }[] = [];
  const normalized = normalizeDecryptedMessage(message);
  if (normalized?.role !== "agent") return { parts, pinCalls };
  normalized.content.forEach((content, index) => {
    if (content.type === "text" || content.type === "reasoning") {
      // reducerTimeline.ts names text and reasoning blocks `<id>:<index>`.
      parts.push(`${normalized.id}:${index}`);
    } else if (content.type === "tool-call") {
      parts.push(content.id);
      if (PIN_POST_TOOLS.has(content.name)) {
        const input = content.input as { key?: unknown } | null;
        pinCalls.push({
          id: content.id,
          key: input && typeof input === "object" ? input.key : undefined,
        });
      }
    }
  });
  return { parts, pinCalls };
}

const anchorSelector = (id: string) =>
  `[data-bookmark-anchor="${CSS.escape(id)}"]`;

/** The index of the message the pin was posted in, or -1 when not loaded. */
function postingIndex(
  pin: PinChatSpot,
  ordered: readonly DecryptedMessage[]
): number {
  if (pin.anchor) {
    const id = pin.anchor.messageId;
    return ordered.findIndex(m => m.id === id);
  }
  if (pin.postedSeq !== null) {
    const seq = pin.postedSeq;
    // The first message at or after the recorded seq; the tool call is there
    // or just after it.
    const index = ordered.findIndex(m => (m.seq as number) >= seq);
    return index === -1 ? ordered.length - 1 : index;
  }
  return -1;
}

/**
 * The elements to try, in order (KD9): the first chat card for the pin, which
 * sits exactly where it was posted (a later `pin_update` card comes after it);
 * the `pin_post`/`pin_update` call that names the pin; the posting message's
 * blocks; then the blocks of up to 20 messages before it, nearest first. The
 * caller scrolls to the first that resolves and stays put when none does.
 */
export function pinTargetSelectors(
  pin: PinChatSpot,
  messages: readonly DecryptedMessage[]
): string[] {
  const selectors = [`[data-pin-card="${CSS.escape(pin.key)}"]`];
  const ordered = bySeq(messages);
  const at = postingIndex(pin, ordered);
  if (at === -1) return selectors;

  // The tool call that posted it: at or after the posting message.
  for (let i = at; i < ordered.length; i++) {
    const call = blockAnchors(ordered[i]).pinCalls.find(c => c.key === pin.key);
    if (call) {
      selectors.push(anchorSelector(call.id));
      break;
    }
  }
  for (let i = at; i >= 0 && i > at - 1 - FALLBACK_MESSAGES; i--) {
    for (const id of blockAnchors(ordered[i]).parts) {
      selectors.push(anchorSelector(id));
    }
  }
  return [...new Set(selectors)];
}
