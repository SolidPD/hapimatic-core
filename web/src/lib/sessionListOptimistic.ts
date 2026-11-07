// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Optimistic removal of session rows from the two session-list caches
 * (`queryKeys.sessions` and `queryKeys.federationAllSessions`). This is the
 * single-delete recipe from #3516, extracted by #6210 so the Select-mode bulk
 * delete shares it.
 *
 * Every write is a functional update of the CURRENT cache, and a rollback
 * restores rows BY ID, merged into the current cache. Two deletes can run at
 * once (a bulk delete in the background while the user deletes another
 * session), and writing a whole earlier snapshot back would bring the other
 * delete's rows back with it.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  FederationAllSessionsResponse,
  SessionsResponse,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import { markActionPending } from "@/lib/session-action-pending";

/** The two list caches as they were before a removal — what a rollback reads. */
export type SessionListSnapshots = {
  prevSessions: SessionsResponse | undefined;
  prevFederation: FederationAllSessionsResponse | undefined;
};

type SessionList = { sessions: Array<{ id: string }> };

/**
 * Cancel any in-flight list fetch, then read both list caches. Cancel FIRST:
 * a fetch still running when the rows are removed would land its older data
 * over them.
 */
export async function snapshotSessionLists(
  queryClient: QueryClient
): Promise<SessionListSnapshots> {
  await queryClient.cancelQueries({ queryKey: queryKeys.sessions });
  await queryClient.cancelQueries({
    queryKey: queryKeys.federationAllSessions,
  });
  return {
    prevSessions: queryClient.getQueryData<SessionsResponse>(
      queryKeys.sessions
    ),
    prevFederation: queryClient.getQueryData<FederationAllSessionsResponse>(
      queryKeys.federationAllSessions
    ),
  };
}

function withoutIds<T extends SessionList>(
  cur: T | undefined,
  idSet: ReadonlySet<string>
): T | undefined {
  if (!cur) return cur;
  const sessions = cur.sessions.filter(s => !idSet.has(s.id));
  return sessions.length === cur.sessions.length ? cur : { ...cur, sessions };
}

/**
 * Mark every id delete-pending (the route guard, and the list queryFns'
 * refetch filter `withoutDeletePending`), then drop the rows from both list
 * caches. The mark goes first so a refetch that lands between the two steps is
 * already filtered.
 */
export function removeSessionRows(
  queryClient: QueryClient,
  ids: readonly string[]
): void {
  for (const id of ids) markActionPending(id, "delete");
  const idSet = new Set(ids);
  queryClient.setQueryData<SessionsResponse>(queryKeys.sessions, cur =>
    withoutIds(cur, idSet)
  );
  queryClient.setQueryData<FederationAllSessionsResponse>(
    queryKeys.federationAllSessions,
    cur => withoutIds(cur, idSet)
  );
}

function restoreInto<T extends SessionList>(
  queryClient: QueryClient,
  key: QueryKey,
  prev: T | undefined,
  idSet: ReadonlySet<string>
): void {
  const rows = prev?.sessions.filter(s => idSet.has(s.id)) ?? [];
  if (rows.length === 0) return;
  queryClient.setQueryData<T>(key, cur => {
    if (!cur) return cur;
    const have = new Set(cur.sessions.map(s => s.id));
    const add = rows.filter(s => !have.has(s.id));
    return add.length === 0
      ? cur
      : { ...cur, sessions: [...cur.sessions, ...add] };
  });
}

/**
 * Put back exactly the rows of `ids` from the pre-removal snapshot, appended to
 * the current caches where absent. Everything else in the caches is left as it
 * is now.
 */
export function restoreSessionRowsById(
  queryClient: QueryClient,
  snap: SessionListSnapshots,
  ids: readonly string[]
): void {
  const idSet = new Set(ids);
  if (idSet.size === 0) return;
  restoreInto(queryClient, queryKeys.sessions, snap.prevSessions, idSet);
  restoreInto(
    queryClient,
    queryKeys.federationAllSessions,
    snap.prevFederation,
    idSet
  );
}

/** Drop the per-session caches of deleted sessions (#1902; #2556 bubble store). */
export function dropSessionDetailCaches(
  queryClient: QueryClient,
  ids: readonly string[]
): void {
  for (const id of ids) {
    queryClient.removeQueries({ queryKey: queryKeys.session(id) });
    queryClient.removeQueries({ queryKey: queryKeys.messages(id) });
    queryClient.removeQueries({ queryKey: queryKeys.optimisticMessages(id) });
  }
}
