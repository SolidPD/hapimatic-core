// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useSyncExternalStore } from "react";
import {
  subscribeActionPending,
  getActionPendingSnapshot,
  type PendingActionEntry,
  type SessionAction,
} from "@/lib/session-action-pending";

/**
 * Reactive view of the session-action-pending store (issue #1902).
 * Returns the full list of in-progress entries. Re-renders any subscriber when
 * an action is marked/cleared in EITHER the session header or a list card.
 */
export function usePendingSessionActions(): PendingActionEntry[] {
  return useSyncExternalStore(subscribeActionPending, getActionPendingSnapshot);
}

export type SessionPendingState = {
  archiving: boolean;
  reconnecting: boolean;
  switching: boolean;
  /** True if ANY non-blocking action is pending for this session. */
  any: boolean;
};

/**
 * Per-session pending state. Both SessionHeader and the SessionList card call
 * this with the same sessionId, so a background action started in one surface
 * spins in the other (cross-view persistence). Memoized over the stable
 * snapshot reference so it does not churn between unrelated store updates.
 */
export function useSessionActionPending(
  sessionId: string | null | undefined
): SessionPendingState {
  const all = usePendingSessionActions();
  return useMemo(() => {
    const state: SessionPendingState = {
      archiving: false,
      reconnecting: false,
      switching: false,
      any: false,
    };
    if (!sessionId) return state;
    for (const entry of all) {
      if (entry.sessionId !== sessionId) continue;
      const action: SessionAction = entry.action;
      if (action === "archive") state.archiving = true;
      else if (action === "reconnect") state.reconnecting = true;
      else if (action === "switch") state.switching = true;
      state.any = true;
    }
    return state;
  }, [all, sessionId]);
}
