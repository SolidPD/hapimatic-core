// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { removeSessionStaging } from "@/lib/pins/staging";
import type {
  FederationAllSessionsResponse,
  SessionResponse,
  SessionsResponse,
} from "@/types/api";

/**
 * #6449: how the web follows a session's `pin-changed` SSE events (#6447).
 *
 * The event carries no pin content: the changed pin's key, its change,
 * revision and status, and the session's new open-pin count. So a client (a)
 * patches the count into the cached session so the tab badge follows, and
 * (b) hands the changed keys to the
 * mounted Pins page, which fetches just those pins (`GET .../pins/:key`). A's
 * measurement at the caps (`docs/internal/architecture/sync.md`, "For later
 * sub-issues"): refetching the whole list on every event took one owner to 47%
 * of a core with 443 ms stalls. It never invalidates the session lists: #6208
 * measured that at 1878 requests in 30 s.
 */

/** Trailing debounce per session, and the longest a burst can hold a sync. */
export const PIN_REFETCH_DEBOUNCE_MS = 300;
export const PIN_REFETCH_MAX_WAIT_MS = 1_500;

/** Receives one session's changed pin keys, once a burst settles. */
export type PinChangesHandler = (keys: readonly string[]) => void;

const pinChangeHandlers = new Map<string, Set<PinChangesHandler>>();

/**
 * The Pins page subscribes while it is mounted (`usePins`); its handler
 * fetches the changed pins. With no subscriber, the list is only marked stale.
 */
export function subscribePinChanges(
  sessionId: string,
  handler: PinChangesHandler
): () => void {
  let handlers = pinChangeHandlers.get(sessionId);
  if (!handlers) {
    handlers = new Set();
    pinChangeHandlers.set(sessionId, handlers);
  }
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0) pinChangeHandlers.delete(sessionId);
  };
}

/**
 * Mark a session's list and each changed pin's own cache (#6450's chat cards)
 * stale. Only the changed keys: an unrelated card stays fresh.
 */
function markStale(
  queryClient: QueryClient,
  sessionId: string,
  keys: readonly string[],
  refetchType: "none" | "active"
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.pins(sessionId),
    exact: true,
    refetchType,
  });
  for (const key of keys) {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.pin(sessionId, key),
      exact: true,
      refetchType,
    });
  }
}

export type PinRefetchCoalescer = {
  /** A pin of `sessionId` changed: sync it once the burst settles. */
  schedule: (sessionId: string, key: string) => void;
  /** Drop a pending sync (the session was removed). */
  cancel: (sessionId: string) => void;
  /** Clear every pending timer (the SSE hook unmounted). */
  dispose: () => void;
};

/**
 * Coalesce a burst of `pin-changed` frames per session (300 ms trailing,
 * 1.5 s at most), then hand the distinct changed keys to the mounted Pins
 * page. With no page mounted, the cached list (if any) is marked stale
 * without a fetch, so the next visit loads it fresh.
 */
export function createPinRefetchCoalescer(
  queryClient: QueryClient,
  debounceMs: number = PIN_REFETCH_DEBOUNCE_MS,
  maxWaitMs: number = PIN_REFETCH_MAX_WAIT_MS
): PinRefetchCoalescer {
  const pending = new Map<
    string,
    {
      timer: ReturnType<typeof setTimeout>;
      firstAt: number;
      keys: Set<string>;
    }
  >();

  const fire = (sessionId: string) => {
    const entry = pending.get(sessionId);
    pending.delete(sessionId);
    const keys = entry ? [...entry.keys] : [];
    const handlers = pinChangeHandlers.get(sessionId);
    if (handlers && handlers.size > 0) {
      for (const handler of [...handlers]) handler(keys);
      return;
    }
    markStale(queryClient, sessionId, keys, "none");
  };

  return {
    schedule(sessionId, key) {
      const now = Date.now();
      const prev = pending.get(sessionId);
      if (prev) clearTimeout(prev.timer);
      const firstAt = prev?.firstAt ?? now;
      const keys = prev?.keys ?? new Set<string>();
      keys.add(key);
      const wait = Math.max(0, Math.min(debounceMs, firstAt + maxWaitMs - now));
      pending.set(sessionId, {
        timer: setTimeout(() => fire(sessionId), wait),
        firstAt,
        keys,
      });
    },
    cancel(sessionId) {
      const prev = pending.get(sessionId);
      if (prev) clearTimeout(prev.timer);
      pending.delete(sessionId);
    },
    dispose() {
      // The changes these timers carried are dropped with them, so mark each
      // session's list stale: an open Pins page refetches it, a later visit
      // loads it fresh.
      for (const [sessionId, { timer, keys }] of pending) {
        clearTimeout(timer);
        markStale(queryClient, sessionId, [...keys], "active");
      }
      pending.clear();
    },
  };
}

function patchListCount<
  T extends { sessions: { id: string; openPinCount?: number }[] },
>(data: T | undefined, sessionId: string, openPinCount: number): T | undefined {
  if (!data) return data;
  const index = data.sessions.findIndex(session => session.id === sessionId);
  if (index === -1) return data;
  const row = data.sessions[index];
  if (row.openPinCount === openPinCount) return data;
  const sessions = data.sessions.slice();
  sessions[index] = { ...row, openPinCount };
  return { ...data, sessions };
}

/**
 * Write a session's new open-pin count into the detail cache (top-level
 * `openPinCount`) and its rows in both session lists, only where it changed.
 * It patches `data` alone (`setState`, the `applyKeepaliveIfUnchanged` route
 * in useSSE.ts), so fetch status and poll timing are untouched, and an
 * unchanged cache is not written at all: the list rows are not memoized, so a
 * needless write would re-render every row.
 */
export function patchOpenPinCount(
  queryClient: QueryClient,
  sessionId: string,
  openPinCount: number
): void {
  const patch = <T>(queryKey: readonly unknown[], prev: T, next: T) => {
    if (next === prev) return;
    queryClient
      .getQueryCache()
      .find({ queryKey, exact: true })
      ?.setState({ data: next });
  };

  const detailKey = queryKeys.session(sessionId);
  const detail = queryClient.getQueryData<SessionResponse>(detailKey);
  if (detail && detail.openPinCount !== openPinCount) {
    patch(detailKey, detail, { ...detail, openPinCount });
  }

  const local = queryClient.getQueryData<SessionsResponse>(queryKeys.sessions);
  patch(
    queryKeys.sessions,
    local,
    patchListCount(local, sessionId, openPinCount)
  );

  const federation = queryClient.getQueryData<FederationAllSessionsResponse>(
    queryKeys.federationAllSessions
  );
  patch(
    queryKeys.federationAllSessions,
    federation,
    patchListCount(federation, sessionId, openPinCount)
  );
}

/** Drop a removed session's pins caches, and its staged answers (#6450). */
export function removePinQueries(
  queryClient: QueryClient,
  sessionId: string
): void {
  queryClient.removeQueries({ queryKey: queryKeys.pins(sessionId) });
  queryClient.removeQueries({ queryKey: ["pin-evidence", sessionId] });
  removeSessionStaging(sessionId);
}
