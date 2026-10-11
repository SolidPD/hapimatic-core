// SPDX-License-Identifier: AGPL-3.0-only
import type { InfiniteData } from "@tanstack/react-query";
import type { DecryptedMessage, MessagesResponse } from "@/types/api";

export function makeClientSideId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random()}`;
}

export function isUserMessage(msg: DecryptedMessage): boolean {
  const content = msg.content;
  if (content && typeof content === "object" && "role" in content) {
    return (content as { role: string }).role === "user";
  }
  return false;
}

function extractUserText(msg: DecryptedMessage): string | null {
  const c = msg.content;
  if (!c || typeof c !== "object" || !("content" in c)) return null;
  const content = (c as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && "text" in content) {
    return (content as { text: string }).text;
  }
  return null;
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
  const aSeq = typeof a.seq === "number" ? a.seq : null;
  const bSeq = typeof b.seq === "number" ? b.seq : null;
  if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
    return aSeq - bSeq;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.id.localeCompare(b.id);
}

export function mergeMessages(
  existing: DecryptedMessage[],
  incoming: DecryptedMessage[]
): DecryptedMessage[] {
  if (existing.length === 0) {
    return [...incoming].sort(compareMessages);
  }
  if (incoming.length === 0) {
    return [...existing].sort(compareMessages);
  }

  const byId = new Map<string, DecryptedMessage>();
  for (const msg of existing) {
    byId.set(msg.id, msg);
  }
  for (const msg of incoming) {
    byId.set(msg.id, msg);
  }

  let merged = Array.from(byId.values());

  const incomingLocalIds = new Set<string>();
  for (const msg of incoming) {
    if (msg.localId) {
      incomingLocalIds.add(msg.localId);
    }
  }

  // If we received a stored message with a localId, drop any optimistic bubble with the same localId.
  if (incomingLocalIds.size > 0) {
    merged = merged.filter(msg => {
      if (!msg.localId || !incomingLocalIds.has(msg.localId)) {
        return true;
      }
      return !msg.status;
    });
  }

  // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
  // drop it when a server user message appears close in time.
  const optimisticMessages = merged.filter(m => m.localId && m.status);
  const nonOptimisticMessages = merged.filter(m => !m.localId || !m.status);
  const result: DecryptedMessage[] = [...nonOptimisticMessages];

  // Track which server messages have already been matched to prevent
  // one server message from consuming multiple optimistic bubbles.
  // Issue #916: Without this, rapid-fire identical messages (e.g.,
  // consecutive "/status") cause earlier bubbles to disappear because
  // the same server message matches multiple optimistic bubbles.
  const matchedServerIds = new Set<string>();

  for (const optimistic of optimisticMessages) {
    if (optimistic.status === "sent") {
      const optimisticText = extractUserText(optimistic);
      const matchingServerMsg = nonOptimisticMessages.find(
        m =>
          !m.status &&
          !matchedServerIds.has(m.id) &&
          isUserMessage(m) &&
          Math.abs(m.createdAt - optimistic.createdAt) < 10_000 &&
          extractUserText(m) === optimisticText
      );
      if (matchingServerMsg) {
        matchedServerIds.add(matchingServerMsg.id);
        console.debug(
          "[mergeMessages] Dropping optimistic bubble (content + timestamp match):",
          {
            optimisticId: optimistic.id,
            localId: optimistic.localId,
            status: optimistic.status,
            serverMsgId: matchingServerMsg.id,
            timeDelta: matchingServerMsg.createdAt - optimistic.createdAt,
          }
        );
        continue;
      }
    }
    result.push(optimistic);
  }

  result.sort(compareMessages);
  return result;
}

export function upsertMessagesInCache(
  data: InfiniteData<MessagesResponse> | undefined,
  incoming: DecryptedMessage[]
): InfiniteData<MessagesResponse> {
  const mergedIncoming = mergeMessages([], incoming);

  if (!data || data.pages.length === 0) {
    return {
      pages: [
        {
          messages: mergedIncoming,
          page: {
            limit: 50,
            beforeSeq: null,
            nextBeforeSeq: null,
            hasMore: false,
          },
        },
      ],
      pageParams: [null],
    };
  }

  const pages = data.pages.slice();
  const first = pages[0];
  pages[0] = {
    ...first,
    messages: mergeMessages(first.messages, mergedIncoming),
  };

  return {
    ...data,
    pages,
  };
}

// ── Issue #2556: single-source optimistic-bubble store ──────────────────────
// Optimistic message bubbles (status "sending"/"failed"/"sent") live in a
// dedicated client-only query cache (queryKeys.optimisticMessages), NOT the
// main messages cache, so a poll refetch that replaces the server pages cannot
// wipe an attempted-and-failed send. `useMessages` merges this store with the
// server pages via `reconcileOptimisticStore` below and writes back the pruned
// store. Optimistic bubbles MUST live only here: `mergeMessages` self-drops an
// optimistic bubble that also appears as `incoming` (its own localId matches),
// so a bubble present in BOTH the store and the server pages would delete
// itself. Bubbles are keyed by `id` (== localId, matching the send mutation).

export function upsertOptimisticBubble(
  store: DecryptedMessage[] | undefined,
  bubble: DecryptedMessage
): DecryptedMessage[] {
  const current = store ?? [];
  const idx = current.findIndex(
    m =>
      m.id === bubble.id ||
      (bubble.localId != null && m.localId === bubble.localId)
  );
  if (idx === -1) {
    return [...current, bubble];
  }
  const next = current.slice();
  next[idx] = { ...current[idx], ...bubble };
  return next;
}

export function setOptimisticBubbleStatus(
  store: DecryptedMessage[] | undefined,
  localId: string,
  status: DecryptedMessage["status"]
): DecryptedMessage[] {
  const current = store ?? [];
  return current.map(m => (m.localId === localId ? { ...m, status } : m));
}

export function removeOptimisticBubble(
  store: DecryptedMessage[] | undefined,
  localId: string
): DecryptedMessage[] {
  const current = store ?? [];
  return current.filter(m => m.localId !== localId);
}

export function findOptimisticBubble(
  store: DecryptedMessage[] | undefined,
  localId: string
): DecryptedMessage | null {
  const current = store ?? [];
  return current.find(m => m.localId === localId) ?? null;
}

// Merge the optimistic store with the server messages for display, and derive
// the pruned store. A bubble whose server echo has arrived is dropped from the
// display by `mergeMessages` (localId echo or sent content+time match); we prune
// it from the store so the store stays bounded and cannot resurrect a message
// the server already shows. Failed/sending bubbles with no server echo survive
// (and therefore survive a poll refetch, satisfying #2556 R3).
export function reconcileOptimisticStore(
  store: DecryptedMessage[],
  serverMessages: DecryptedMessage[]
): { merged: DecryptedMessage[]; survivingStore: DecryptedMessage[] } {
  const merged = mergeMessages(store, serverMessages);
  if (store.length === 0) {
    return { merged, survivingStore: store };
  }
  const shownIds = new Set(merged.map(m => m.id));
  const survivingStore = store.filter(b => shownIds.has(b.id));
  return { merged, survivingStore };
}
