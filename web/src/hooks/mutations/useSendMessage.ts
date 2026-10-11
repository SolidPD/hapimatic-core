// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient, SendMessageResult } from "@/api/client";
import type { DecryptedMessage } from "@/types/api";
import {
  makeClientSideId,
  upsertOptimisticBubble,
  setOptimisticBubbleStatus,
  findOptimisticBubble,
} from "@/lib/messages";
import { queryKeys } from "@/lib/query-keys";
import { usePlatform } from "@/hooks/usePlatform";

type SendMessageInput = {
  sessionId: string;
  text: string;
  localId: string;
  createdAt: number;
};

// Issue #2556: optimistic bubbles live in a dedicated client-only store
// (queryKeys.optimisticMessages) rather than the main messages cache, so a poll
// refetch that replaces the server pages cannot wipe an attempted-and-failed
// send. `useMessages` merges this store with the server pages for display.
function makeOptimisticBubble(
  input: SendMessageInput,
  status: DecryptedMessage["status"]
): DecryptedMessage {
  return {
    id: input.localId,
    seq: null,
    localId: input.localId,
    content: { role: "user", content: input.text },
    createdAt: input.createdAt,
    status,
    originalText: input.text,
  };
}

export function useSendMessage(
  api: ApiClient | null,
  sessionId: string | null
): {
  sendMessage: (text: string) => void;
  retryMessage: (localId: string) => void;
  isSending: boolean;
  // #3333 (3333-1): the last send's parsed outcome, so a caller (e.g. an approval
  // card) can distinguish a server denial from a success. `undefined` until the
  // first send settles; a transport failure surfaces via `sendError` instead.
  sendResult: SendMessageResult | undefined;
  sendError: Error | null;
} {
  const queryClient = useQueryClient();
  const { haptic } = usePlatform();

  const mutation = useMutation({
    mutationFn: async (input: SendMessageInput): Promise<SendMessageResult> => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.sendMessage(input.sessionId, input.text, input.localId);
    },
    onMutate: async input => {
      queryClient.setQueryData<DecryptedMessage[]>(
        queryKeys.optimisticMessages(input.sessionId),
        store =>
          upsertOptimisticBubble(store, makeOptimisticBubble(input, "sending"))
      );
    },
    onSuccess: (result, input) => {
      // #3579 (R2): a gate-class denial (HTTP 200 {ok:false}) must NOT present as
      // success — the composer bubble stops lying. Mark it "blocked" (not "sent")
      // and carry the server-resolved outcome as the bubble's copy carrier.
      // mergeMessages only auto-drops "sent" bubbles, so a "blocked" bubble
      // persists client-side until reload (the durable in-thread notice is the
      // other half). Fire the ERROR haptic HERE — not in PromptBlockToastListener,
      // which fires on EVERY connected client and would buzz a second client for
      // someone else's denial.
      if (result?.ok === false) {
        queryClient.setQueryData<DecryptedMessage[]>(
          queryKeys.optimisticMessages(input.sessionId),
          store =>
            upsertOptimisticBubble(store, {
              ...makeOptimisticBubble(input, "blocked"),
              denial: result.denied?.outcome,
            })
        );
        haptic.notification("error");
        return;
      }
      // A real delivery (or a legacy/undefined body): mark "sent" (not removed) so
      // the bubble persists until the server echo arrives; `mergeMessages` in
      // useMessages then de-dupes it and useMessages prunes it from the store —
      // avoiding a flash of the message disappearing before the server-stored copy
      // is delivered. Success haptic as before.
      queryClient.setQueryData<DecryptedMessage[]>(
        queryKeys.optimisticMessages(input.sessionId),
        store => setOptimisticBubbleStatus(store, input.localId, "sent")
      );
      haptic.notification("success");
    },
    onError: (_, input) => {
      queryClient.setQueryData<DecryptedMessage[]>(
        queryKeys.optimisticMessages(input.sessionId),
        store => setOptimisticBubbleStatus(store, input.localId, "failed")
      );
      haptic.notification("error");
    },
  });

  // useCallback keeps these handlers referentially stable across renders —
  // downstream consumers (useHappyRuntime's adapter memo) would otherwise
  // recreate the external-store adapter on every render, and the runtime's
  // setAdapter notifies subscribers even when nothing changed (issue #1636).
  const { mutate, isPending } = mutation;

  const sendMessage = useCallback(
    (text: string) => {
      if (!api || !sessionId) return;
      const localId = makeClientSideId("local");
      const createdAt = Date.now();
      // Issue #2556: a prior mutation is still in flight. Rather than a silent
      // no-op (which drops the user's message with zero HTTP + zero feedback —
      // the incident class), surface it as a visible "failed" bubble the user
      // can retry once the prior send settles. R1: every submit resolves to a
      // visible state.
      //
      // #1487 (R7 decision): KEEP this single-flight guard. It is now bounded by
      // the 30s transport timeout (DEFAULT_TIMEOUT_MS in api/client.ts) — the
      // in-flight send can never hang indefinitely, so the guard auto-releases on
      // timeout→failed. Alternatives considered and rejected: (a) hold the 2nd
      // send as "sending" until the 1st settles — adds a second pending bubble
      // with no clear owner; (b) queue the 2nd send via #1325 — the server queue
      // already covers the thinking/offline cases (HappyComposer routes there),
      // so a 2nd message during a brief active-and-not-thinking in-flight send is
      // an edge case where an immediate retryable-failed bubble is the clearest,
      // lowest-risk outcome.
      if (isPending) {
        queryClient.setQueryData<DecryptedMessage[]>(
          queryKeys.optimisticMessages(sessionId),
          store =>
            upsertOptimisticBubble(
              store,
              makeOptimisticBubble(
                { sessionId, text, localId, createdAt },
                "failed"
              )
            )
        );
        haptic.notification("error");
        return;
      }
      mutate({ sessionId, text, localId, createdAt });
    },
    [api, sessionId, mutate, isPending, queryClient, haptic]
  );

  const retryMessage = useCallback(
    (localId: string) => {
      if (!api || !sessionId) return;
      // Issue #2556: a prior mutation is still in flight. Leave the bubble in
      // its visible "failed" state (the message is NOT lost — it stays on screen
      // with a retry affordance) rather than silently doing nothing; the user
      // can retry again once the in-flight send settles.
      if (isPending) return;

      const store = queryClient.getQueryData<DecryptedMessage[]>(
        queryKeys.optimisticMessages(sessionId)
      );
      const message = findOptimisticBubble(store, localId);
      if (!message?.originalText) return;

      queryClient.setQueryData<DecryptedMessage[]>(
        queryKeys.optimisticMessages(sessionId),
        current => setOptimisticBubbleStatus(current, localId, "sending")
      );

      mutate({
        sessionId,
        text: message.originalText,
        localId,
        createdAt: message.createdAt,
      });
    },
    [api, sessionId, mutate, isPending, queryClient]
  );

  return {
    sendMessage,
    retryMessage,
    isSending: mutation.isPending,
    sendResult: mutation.data,
    sendError: mutation.error,
  };
}
