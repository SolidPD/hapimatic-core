// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

/** Jitter so clients do not hit the hub (and a just-restarted node) in lockstep. */
const RECOVERY_JITTER_MS = 2_000;

/**
 * #5375: recovery refetch for an open session. When the session's federation
 * node comes back — `nodeStatus` changes to "online" from "offline" or
 * "degraded" (useSession polls every 5 s, and the hub's cached summary carries
 * nodeStatus while the node is away) — refetch the session's queries after a
 * 0–2 s jitter, so the thread recovers without a page reload even after the
 * retry budget ran out. `optimistic-messages` (client-only) is never touched.
 */
export function useSessionNodeRecovery(
  sessionId: string | null,
  nodeStatus: string | undefined,
  refetchMessages: () => Promise<unknown>,
  random: () => number = Math.random
): void {
  const queryClient = useQueryClient();
  // Keyed by session: switching to another session's view is not a recovery.
  const previousRef = useRef({ sessionId, nodeStatus });
  useEffect(() => {
    const previous =
      previousRef.current.sessionId === sessionId
        ? previousRef.current.nodeStatus
        : undefined;
    previousRef.current = { sessionId, nodeStatus };
    if (!sessionId || nodeStatus !== "online") return;
    if (previous !== "offline" && previous !== "degraded") return;
    const timer = setTimeout(() => {
      void refetchMessages();
      for (const queryKey of [
        queryKeys.gitStatus(sessionId),
        queryKeys.sessionTokenStats(sessionId),
        queryKeys.sessionWorkflowState(sessionId),
        queryKeys.queue(sessionId),
        queryKeys.mcpBatchState(sessionId),
        queryKeys.slashCommands(sessionId),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    }, random() * RECOVERY_JITTER_MS);
    return () => clearTimeout(timer);
  }, [nodeStatus, sessionId, refetchMessages, queryClient, random]);
}
