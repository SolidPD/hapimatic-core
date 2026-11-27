// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6778 (Task 16; 7.1): a session's tracking record, read through
 * `GET /api/sessions/:id/tracking`.
 *
 * The route stands behind the billable switch's gate: while the server's
 * billable sessions are off it answers a bare 404, so a caller enables this
 * read only where the switch is shown (`useBillableSwitchMode() !== "off"`).
 * The answer carries no rate or note for an agent; this hook never logs it.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  type ApiClient,
  type SessionTrackingResponse,
} from "@/api/client";

/** The cache key of one session's tracking read. */
export function sessionTrackingKey(sessionId: string) {
  return ["session-tracking", sessionId] as const;
}

/** One session's tracking record, while `enabled`. */
export function useSessionTracking(
  api: ApiClient | null,
  sessionId: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: sessionTrackingKey(sessionId),
    queryFn: async (): Promise<SessionTrackingResponse> => {
      if (!api) throw new Error("API unavailable");
      return await api.getSessionTracking(sessionId);
    },
    enabled: Boolean(api) && enabled,
    staleTime: 30000,
    retry: 1,
  });
}

/**
 * The cache key of the old switch's own read before its choice: its own entry,
 * so a failed read is a null answer there and never the record view's data.
 */
export function switchTrackingKey(sessionId: string) {
  return ["session-tracking", sessionId, "switch"] as const;
}

/**
 * A fresh read for the old switch's choice (rulings PRC-R1, PRC-R7), stored
 * under `switchTrackingKey`, where the dialog reads it. A read that fails
 * answers null (the switch then shows its timer, as before PR-C) with one
 * console line that names no value from the answer.
 */
export async function fetchSwitchTracking(
  queryClient: QueryClient,
  api: ApiClient,
  sessionId: string
): Promise<SessionTrackingResponse | null> {
  return await queryClient.fetchQuery({
    queryKey: switchTrackingKey(sessionId),
    queryFn: async (): Promise<SessionTrackingResponse | null> => {
      try {
        return await api.getSessionTracking(sessionId);
      } catch (err) {
        console.warn(
          "[useSessionTracking] the tracking read failed; the switch shows its timer",
          err instanceof ApiError ? err.status : "no answer"
        );
        return null;
      }
    },
    staleTime: 0,
    retry: false,
    // Offline the default "online" mode pauses the read: it would neither
    // answer nor fail, and run on reconnect as a choice made minutes before.
    // This way it fails at once, and the switch shows its timer (PRC-R7).
    networkMode: "always",
    // No query observes this entry, and the dialog reads its figure from it on
    // every render: the default 5 minutes would end it under an open dialog.
    gcTime: Infinity,
  });
}

/**
 * The read's untracked earlier time as an amount (rulings PRC-R1, PRC-R7):
 * `earlierMs`, which a PR-C node attaches for every live session. Null when the
 * read has no such field (a deleted session, a remote node's summary, an owner
 * before PR-C): the caller then shows its timer, as before PR-C. Which record
 * state uses it is `oldSwitchAmount`'s rule. Nothing is logged until #6204, so
 * `loggedKnown` stays false.
 */
export function trackingSwitchAmount(
  answer: SessionTrackingResponse | null | undefined
): { ms: number; loggedKnown: false } | null {
  const ms = answer?.earlierMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
    ? { ms, loggedKnown: false }
    : null;
}
