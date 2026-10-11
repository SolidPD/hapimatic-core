// SPDX-License-Identifier: AGPL-3.0-only
/**
 * In-memory record of reasoning groups the user collapsed by hand (#4045).
 *
 * Operator ruling P2 (#4045): a manual collapse sticks for the rest of the
 * session, so a raw-thinking flap never re-opens it. Scope (#4045 Q1 ruling S1):
 * keyed per session, held in memory for the life of the browser tab. It survives
 * React component unmounts and
 * navigating to another session and back, but not a page reload — the same
 * boundary as the thread scroll position (see scroll-position-cache.ts, #833).
 *
 * A group is identified by `${message.id}:${startIndex}`: assistant-ui keys each
 * reasoning group `reasoning-${startIndex}` inside a message whose id is its first
 * joined output's id, so the pair is stable across appends, flaps and remounts.
 * This relies on real message ids (Hapimatic always sets one); assistant-ui's
 * index fallback for an id-less message would not be stable across remounts.
 */

const collapsed = new Map<string, Set<string>>();

export function reasoningGroupKey(
  messageId: string | undefined,
  startIndex: number | undefined
): string | null {
  if (!messageId) return null;
  return `${messageId}:${startIndex ?? 0}`;
}

export function isReasoningGroupCollapsed(
  sessionId: string | undefined,
  key: string | null
): boolean {
  if (!sessionId || !key) return false;
  return collapsed.get(sessionId)?.has(key) ?? false;
}

export function setReasoningGroupCollapsed(
  sessionId: string | undefined,
  key: string | null,
  isCollapsed: boolean
): void {
  if (!sessionId || !key) return;
  const keys = collapsed.get(sessionId);
  if (isCollapsed) {
    if (keys) keys.add(key);
    else collapsed.set(sessionId, new Set([key]));
    return;
  }
  if (!keys) return;
  keys.delete(key);
  if (keys.size === 0) collapsed.delete(sessionId);
}

export function clearReasoningCollapseMemory(sessionId?: string): void {
  if (sessionId === undefined) collapsed.clear();
  else collapsed.delete(sessionId);
}
