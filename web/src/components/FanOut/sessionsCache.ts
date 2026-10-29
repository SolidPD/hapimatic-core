// SPDX-License-Identifier: AGPL-3.0-only
/**
 * This hub's session list, read from the query cache without fetching (#4469).
 *
 * The list page (`SessionsPage`) and the session page (`SessionRouteComponent`)
 * each keep `queryKeys.sessions` live through `useSessions`. A `useSessions`
 * per session card would refetch on every mount (its staleTime is 0) and split
 * its backoff state across rows, so the kebab's fan-out entries read the cache
 * instead.
 *
 * They subscribe to the query cache rather than call `useQuery`: every
 * `useQuery` observer writes its options (its `queryFn` included) onto the
 * shared query on each render, so a reader with no fetch function that
 * re-rendered on its own would leave the owner's next refetch failing with
 * "Missing queryFn". A row re-renders only when its own value changes.
 */
import { useCallback, useSyncExternalStore } from "react";
import { hashKey, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import type { SessionSummary, SessionsResponse } from "@/types/api";
import { isSpawnChildOf } from "./experiment";

const EMPTY_SESSIONS: readonly SessionSummary[] = [];
const SESSIONS_HASH = hashKey(queryKeys.sessions);

/** Subscribe to changes of the sessions query only; read its data. */
function useSessionsSnapshot<T>(
  read: (data: SessionsResponse | undefined) => T
): T {
  const queryClient = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) =>
      queryClient.getQueryCache().subscribe(event => {
        if (event.query.queryHash === SESSIONS_HASH) onChange();
      }),
    [queryClient]
  );
  const getSnapshot = () =>
    read(queryClient.getQueryData<SessionsResponse>(queryKeys.sessions));
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** How many `spawn` children `parentId` has in this hub's session list. */
export function useSpawnChildCount(parentId: string): number {
  return useSessionsSnapshot(data =>
    data ? data.sessions.filter(s => isSpawnChildOf(parentId, s)).length : 0
  );
}

/** This hub's session list; empty until a page has loaded it. */
export function useCachedSessions(): readonly SessionSummary[] {
  return useSessionsSnapshot(data => data?.sessions ?? EMPTY_SESSIONS);
}
