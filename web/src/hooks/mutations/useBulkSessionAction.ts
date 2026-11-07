// SPDX-License-Identifier: AGPL-3.0-only
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import {
  BULK_SESSION_MAX_IDS,
  type BulkSessionResult,
  type BulkSessionResultItem,
} from "@hapi/protocol/bulkSessionResult";
import type {
  FederationAllSessionsResponse,
  SessionsResponse,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";
import {
  clearActionPending,
  markActionPending,
} from "@/lib/session-action-pending";
import {
  dropSessionDetailCaches,
  restoreSessionRowsById,
  type SessionListSnapshots,
} from "@/lib/sessionListOptimistic";
import {
  bulkFailureLabel,
  summarizeBulkDelete,
  type BulkToastType,
} from "@/lib/bulkSessionToast";

/**
 * Bulk Stop turn / Disconnect / Delete over a selection (#3815, epic #4406).
 * Each action is ONE server-side fan-out route (`/api/sessions/bulk-abort`,
 * `/bulk-archive`, `/bulk-delete`) that runs every session on its owning
 * federation node and answers one result per session.
 */
export type BulkSessionActionKind = "abort" | "archive" | "delete";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function postChunk(
  api: ApiClient,
  action: BulkSessionActionKind,
  ids: string[]
): Promise<BulkSessionResult> {
  if (action === "abort") return (await api.bulkAbortSessions(ids)).results;
  if (action === "archive") return (await api.bulkArchiveSessions(ids)).results;
  return (await api.bulkDeleteSessions(ids)).results;
}

/**
 * Run `action` over `ids` in chunks of the server's 100-id cap ("filter to
 * everything, select all" easily exceeds it) and merge the per-chunk results
 * in request order. A chunk whose request fails as a whole yields one
 * `{ id, ok: false, error }` per id of that chunk; later chunks still run.
 * `beforeChunk` (#6210) runs right before each chunk's request.
 */
export async function executeBulkSessionAction(
  api: ApiClient,
  action: BulkSessionActionKind,
  ids: readonly string[],
  options?: { beforeChunk?: (chunk: readonly string[]) => void }
): Promise<BulkSessionResult> {
  const results: BulkSessionResult = [];
  for (let i = 0; i < ids.length; i += BULK_SESSION_MAX_IDS) {
    const chunk = ids.slice(i, i + BULK_SESSION_MAX_IDS);
    options?.beforeChunk?.(chunk);
    try {
      results.push(...(await postChunk(api, action, chunk)));
    } catch (err) {
      const error = errorMessage(err);
      results.push(...chunk.map(id => ({ id, ok: false, error })));
    }
  }
  return results;
}

/** The toast call a background bulk delete reports through. */
export type BulkDeleteToast = (
  message: string,
  options: { type: BulkToastType }
) => void;

function refreshSessionLists(
  queryClient: QueryClient,
  refetchType: "active" | "all"
): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.sessions,
      refetchType,
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.federationAllSessions,
      refetchType,
    }),
  ]);
}

/**
 * #6210: the Select-mode bulk delete, after its rows were already removed
 * (`removeSessionRows`). It runs on raw `api.*` calls and the app-level query
 * client, so it finishes after the chip row unmounts. It never rejects.
 *
 * 1. Disconnect the connected selection. Only a session that was already
 *    disconnected, or whose disconnect answered `ok` / `session_inactive`, is
 *    sent to delete (#3815-17). A disconnect `not_found` is already gone.
 * 2. Delete. `ok` and `not_found` count as deleted. A result with a `code` is
 *    a definite failure. One with only an error text (a timeout, a failed
 *    request) is UNKNOWN: the server may have deleted it.
 * 3. Settle:
 *    - Definite failures get their rows back by id, and their marks cleared.
 *    - Unknown ones have their marks cleared, then both lists are refetched;
 *      one still listed is a failure, one gone was deleted. If a list's
 *      refetch did not land (offline, failed), none can be decided: all are
 *      failures and their rows come back.
 *    - Ids the server answered as deleted keep their delete-pending marks
 *      until the store's TTL, so stale hub data cannot show them again. Ids
 *      the refetch decided were deleted are not re-marked: their marks were
 *      cleared for that refetch, and the server's list no longer had them.
 * 4. One toast: "Deleted N sessions", or "N sessions could not be deleted:
 *    <reasons>".
 *
 * Every id still outstanding is re-marked before each chunk, so the 90 s mark
 * TTL cannot lapse while a long run is in flight.
 */
export async function runBulkDeleteInBackground(params: {
  api: ApiClient;
  queryClient: QueryClient;
  showToast: BulkDeleteToast;
  connectedIds: readonly string[];
  disconnectedIds: readonly string[];
  snapshot: SessionListSnapshots;
}): Promise<void> {
  const {
    api,
    queryClient,
    showToast,
    connectedIds,
    disconnectedIds,
    snapshot,
  } = params;
  const allIds = [...disconnectedIds, ...connectedIds];
  let outstanding: readonly string[] = allIds;
  const remark = (): void => {
    for (const id of outstanding) markActionPending(id, "delete");
  };

  try {
    const deleted: string[] = [];
    const failures: Array<{ id: string; label: string }> = [];
    const deletable: string[] = [...disconnectedIds];

    if (connectedIds.length > 0) {
      const archived = await executeBulkSessionAction(
        api,
        "archive",
        connectedIds,
        { beforeChunk: remark }
      );
      const byId = new Map(archived.map(r => [r.id, r]));
      for (const id of connectedIds) {
        const r = byId.get(id);
        if (!r) {
          failures.push({ id, label: "disconnect failed: no answer" });
        } else if (r.ok || r.code === "session_inactive") {
          deletable.push(id);
        } else if (r.code === "not_found") {
          deleted.push(id);
        } else {
          failures.push({ id, label: bulkFailureLabel(r, "disconnect") });
        }
      }
    }

    const unknown: BulkSessionResultItem[] = [];
    if (deletable.length > 0) {
      outstanding = deletable;
      const results = await executeBulkSessionAction(api, "delete", deletable, {
        beforeChunk: remark,
      });
      const byId = new Map(results.map(r => [r.id, r]));
      for (const id of deletable) {
        const r = byId.get(id);
        if (!r) {
          unknown.push({ id, ok: false, error: "No answer" });
        } else if (r.ok || r.code === "not_found") {
          deleted.push(id);
        } else if (r.code) {
          failures.push({ id, label: bulkFailureLabel(r, "delete") });
        } else {
          unknown.push(r);
        }
      }
    }

    dropSessionDetailCaches(queryClient, deleted);
    const failedIds = failures.map(f => f.id);
    for (const id of failedIds) clearActionPending(id, "delete");
    restoreSessionRowsById(queryClient, snapshot, failedIds);

    if (unknown.length > 0) {
      // Let the server decide: refetch both lists (also one no observer is
      // watching right now) and read what is still there — but only from a
      // list whose refetch actually landed. Offline, or after a failed fetch,
      // the cache still holds this run's own removal and would read "deleted";
      // then nothing can be concluded, and every unknown session is reported
      // as not deleted and put back. "Landed" is read from the update counter,
      // not dataUpdatedAt: a fast refetch can share the removal's millisecond.
      for (const r of unknown) clearActionPending(r.id, "delete");
      const listKeys = [queryKeys.sessions, queryKeys.federationAllSessions];
      const before = listKeys.map(
        key => queryClient.getQueryState(key)?.dataUpdateCount
      );
      await refreshSessionLists(queryClient, "all");
      let decidable = true;
      const present = new Set<string>();
      listKeys.forEach((key, i) => {
        const state = queryClient.getQueryState<
          SessionsResponse | FederationAllSessionsResponse
        >(key);
        // No list at all (e.g. no federation on this node): nothing to read.
        if (state?.data === undefined) return;
        const landed =
          state.status === "success" &&
          state.fetchStatus === "idle" &&
          state.dataUpdateCount !== before[i];
        if (!landed) {
          decidable = false;
          return;
        }
        for (const s of state.data.sessions) present.add(s.id);
      });
      for (const r of unknown) {
        if (!decidable || present.has(r.id)) {
          failures.push({ id: r.id, label: bulkFailureLabel(r, "delete") });
        } else {
          deleted.push(r.id);
          dropSessionDetailCaches(queryClient, [r.id]);
        }
      }
      if (!decidable) {
        restoreSessionRowsById(
          queryClient,
          snapshot,
          unknown.map(r => r.id)
        );
      }
    } else {
      // Optimistic state augments the refetch; it never replaces it.
      void refreshSessionLists(queryClient, "active");
    }

    const { message, type } = summarizeBulkDelete(deleted.length, failures);
    showToast(message, { type });
  } catch (err) {
    console.warn(
      "[useBulkSessionAction] Bulk delete failed:",
      err instanceof Error ? err.message : err
    );
    for (const id of allIds) clearActionPending(id, "delete");
    restoreSessionRowsById(queryClient, snapshot, allIds);
    void refreshSessionLists(queryClient, "active");
    showToast("Failed to delete sessions", { type: "error" });
  }
}

export function useBulkSessionAction(api: ApiClient | null): {
  runBulkAction: (
    action: BulkSessionActionKind,
    ids: readonly string[]
  ) => Promise<BulkSessionResult>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: {
      action: BulkSessionActionKind;
      ids: readonly string[];
    }): Promise<BulkSessionResult> => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return executeBulkSessionAction(api, input.action, input.ids);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
    },
  });

  return {
    runBulkAction: (action, ids) => mutation.mutateAsync({ action, ids }),
    isPending: mutation.isPending,
  };
}
