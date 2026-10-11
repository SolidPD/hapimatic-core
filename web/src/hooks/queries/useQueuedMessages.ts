// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useMemo, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { QueuedMessage } from "@hapi/protocol/types";
import type { DecryptedMessage } from "@/types/api";
import {
  makeClientSideId,
  upsertOptimisticBubble,
  setOptimisticBubbleStatus,
} from "@/lib/messages";
import { queryKeys } from "@/lib/query-keys";

/**
 * Issue #1325: server-backed queue hook.
 *
 * Replaces the per-tab `sessionStorage`-backed `useMessageQueue`. The queue
 * lives on the owning peer node; the server's `QueueDrainObserver` dispatches
 * the head message when the session's `thinking` falls or `active` rises.
 *
 * This hook keeps the public API surface compatible with the old
 * `useMessageQueue` so `HappyComposer.tsx` (Task 16) needs only an import
 * swap, not a structural rewrite. Read methods (`messages`, `peek`,
 * `getLength`) operate on the cached server response. Mutators
 * (`enqueue`, `clear`, `removeAt`, `updateAt`) call the corresponding
 * REST endpoints; the server emits `queue-changed` SSE events which the
 * SSE handler (Task 15) invalidates `queryKeys.queue(sessionId)`.
 *
 * Semantics changes vs the old hook:
 *
 * - `dequeue()` is a UI-only optimistic helper now. The real dequeue is
 *   server-side via the QueueDrainObserver. The hook exposes `dequeue` to
 *   keep call-site compat: it pops the head locally (and the server-side
 *   SSE event will re-affirm shortly) — but components that need a
 *   guaranteed atomic drain should call the Task 17 manual-drain endpoint
 *   instead (`useDrainQueueHead`, below).
 * - `messages` is `string[]` for compat with the old hook's shape; the
 *   underlying rich `QueuedMessage[]` is exposed via `rawMessages`.
 */
export function useQueuedMessages(
  api: ApiClient | null,
  sessionId: string | null
): {
  messages: string[];
  rawMessages: QueuedMessage[];
  length: number;
  enqueue: (message: string) => Promise<void>;
  dequeue: () => string | undefined;
  getLength: () => number;
  clear: () => Promise<void>;
  peek: () => string | undefined;
  removeAt: (index: number) => Promise<void>;
  updateAt: (index: number, newMessage: string) => Promise<void>;
  isLoading: boolean;
  error: Error | null;
} {
  const queryClient = useQueryClient();
  const resolvedSessionId = sessionId ?? "unknown";

  const query = useQuery({
    queryKey: queryKeys.queue(resolvedSessionId),
    queryFn: async () => {
      if (!api || !sessionId) {
        return [] as QueuedMessage[];
      }
      const result = await api.getQueue(sessionId);
      return result.messages;
    },
    enabled: Boolean(api && sessionId),
    // Server is the source of truth; SSE event drives refetch via invalidation.
    // Use a small staleTime so concurrent reads within a render pass coalesce.
    staleTime: 200,
  });

  // #3508 (Task 2, non-target): already stable — while pending the dep
  // `query.data` stays `undefined`, so this useMemo returns the same `[]`
  // instance across renders. No module-level constant needed.
  const rawMessages = useMemo(() => query.data ?? [], [query.data]);
  const messages = useMemo(() => rawMessages.map(m => m.body), [rawMessages]);

  // Ref mirror — keeps dequeue/peek/getLength synchronous and free from
  // the stale-closure trap the old useMessageQueue solved with the same trick.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.queue(resolvedSessionId),
    });
  }, [queryClient, resolvedSessionId]);

  const enqueueMutation = useMutation({
    mutationFn: async (body: string) => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      const trimmed = body.trim();
      if (!trimmed) throw new Error("Empty message");
      return await api.enqueueQueuedMessage(sessionId, trimmed);
    },
    // #1487 (H1): a message enqueued while the session is thinking (or offline)
    // was invisible in-thread until the server drained it — only a queue badge
    // showed, and on low connectivity a stale-true `thinking` state routes a
    // normal send here, so the message appeared to vanish (R6 low-connectivity
    // display gap). Insert an optimistic "sending" bubble into the shared
    // optimistic store so the user sees their message INSTANTLY (R1/R6), keyed by
    // a client id. Client-side only — no server change (correction 1487-2).
    onMutate: (body: string): { localId: string } | undefined => {
      if (!sessionId) return undefined;
      const trimmed = body.trim();
      if (!trimmed) return undefined;
      const localId = makeClientSideId("queued");
      queryClient.setQueryData<DecryptedMessage[]>(
        queryKeys.optimisticMessages(sessionId),
        store =>
          upsertOptimisticBubble(store, {
            id: localId,
            seq: null,
            localId,
            content: { role: "user", content: trimmed },
            // Date.now() sorts the bubble AFTER a live turn's assistant blocks
            // (whose createdAt is earlier), so it lands at the bottom rather than
            // splitting a concat-joined assistant message (#2767 gate).
            createdAt: Date.now(),
            status: "sending",
            originalText: trimmed,
          })
      );
      return { localId };
    },
    onSuccess: (data, _body, context) => {
      // Re-key the optimistic bubble from its client id to the server queue row
      // id. The queue drain dispatches the delivered message with
      // `localId = row.id` (queueDrainObserver / syncEngine), so mergeMessages
      // then de-dupes this bubble against the drain echo — no duplicate. Match by
      // the stable client `id`; overwrite `localId` only.
      const rowId = data?.row?.id;
      const clientId = context?.localId;
      if (sessionId && clientId && rowId) {
        queryClient.setQueryData<DecryptedMessage[]>(
          queryKeys.optimisticMessages(sessionId),
          store =>
            (store ?? []).map(m =>
              m.id === clientId ? { ...m, localId: rowId } : m
            )
        );
      }
      invalidate();
    },
    onError: (_err, _body, context) => {
      // The enqueue POST failed — surface the message as a retryable "failed"
      // bubble instead of a silent drop (#2556 R1). Retry re-sends via the
      // optimistic send path (useSendMessage.retryMessage, keyed by this localId).
      const clientId = context?.localId;
      if (sessionId && clientId) {
        queryClient.setQueryData<DecryptedMessage[]>(
          queryKeys.optimisticMessages(sessionId),
          store => setOptimisticBubbleStatus(store, clientId, "failed")
        );
      }
    },
  });

  const clearMutation = useMutation({
    mutationFn: async () => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      return await api.clearQueue(sessionId);
    },
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async (position: number) => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      return await api.removeQueuedMessage(sessionId, position);
    },
    onSuccess: invalidate,
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      position,
      body,
    }: {
      position: number;
      body: string;
    }) => {
      if (!api || !sessionId) throw new Error("Session unavailable");
      const trimmed = body.trim();
      if (!trimmed) throw new Error("Empty message");
      return await api.updateQueuedMessage(sessionId, position, trimmed);
    },
    onSuccess: invalidate,
  });

  const enqueue = useCallback(
    async (message: string) => {
      if (!message.trim()) return;
      await enqueueMutation.mutateAsync(message);
    },
    [enqueueMutation]
  );

  const clear = useCallback(async () => {
    await clearMutation.mutateAsync();
  }, [clearMutation]);

  const removeAt = useCallback(
    async (index: number) => {
      // Position-based — translate UI index → server position.
      const target = rawMessages[index];
      if (!target) return;
      await removeMutation.mutateAsync(target.position);
    },
    [rawMessages, removeMutation]
  );

  const updateAt = useCallback(
    async (index: number, newMessage: string) => {
      const target = rawMessages[index];
      if (!target) return;
      const trimmed = newMessage.trim();
      if (!trimmed) return;
      await updateMutation.mutateAsync({
        position: target.position,
        body: trimmed,
      });
    },
    [rawMessages, updateMutation]
  );

  /**
   * Local-optimistic head pop. The real drain runs on the server via
   * QueueDrainObserver on idle. This is a UI-only helper for components that
   * need to render an immediate "popped" state — the server's queue-changed
   * SSE event will reaffirm shortly.
   *
   * Returns the head body (or undefined) and DOES NOT mutate the server.
   * For an authoritative atomic drain, use Task 17's drain endpoint.
   */
  const dequeue = useCallback((): string | undefined => {
    return messagesRef.current[0];
  }, []);

  const peek = useCallback(
    (): string | undefined => messagesRef.current[0],
    []
  );

  const getLength = useCallback((): number => messagesRef.current.length, []);

  return {
    messages,
    rawMessages,
    length: messages.length,
    enqueue,
    dequeue,
    getLength,
    clear,
    peek,
    removeAt,
    updateAt,
    isLoading: query.isLoading,
    error: (query.error as Error) ?? null,
  };
}
