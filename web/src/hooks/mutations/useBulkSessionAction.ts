// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import {
  BULK_SESSION_MAX_IDS,
  type BulkSessionResult,
} from "@hapi/protocol/bulkSessionResult";
import { queryKeys } from "@/lib/query-keys";

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
 */
export async function executeBulkSessionAction(
  api: ApiClient,
  action: BulkSessionActionKind,
  ids: readonly string[]
): Promise<BulkSessionResult> {
  const results: BulkSessionResult = [];
  for (let i = 0; i < ids.length; i += BULK_SESSION_MAX_IDS) {
    const chunk = ids.slice(i, i + BULK_SESSION_MAX_IDS);
    try {
      results.push(...(await postChunk(api, action, chunk)));
    } catch (err) {
      const error = errorMessage(err);
      results.push(...chunk.map(id => ({ id, ok: false, error })));
    }
  }
  return results;
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
