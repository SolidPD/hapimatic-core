// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { HarnessApplyResponse } from "@/types/harnessUpdates";

/**
 * Apply-update / rollback mutations for the harness self-update panel (issue
 * #1774, Sub-Issue E of epic #1769).
 *
 * Both POST to the privileged, JWT-gated routes (`/api/harness/:id/update` +
 * `/rollback`) — the command is resolved SERVER-SIDE from the code-defined
 * registry and never travels on the wire (R11). On success the server has
 * already re-run detection (R4), so both invalidate the `harnessUpdates` status
 * query: the panel then shows the new installed version and the now-populated
 * rollback slot. Errors surface as thrown `ApiError` (the caller maps
 * `update_in_flight` / `version_mismatch` / `no_prior_version` / `exec_failed`
 * to a message); this hook does NOT swallow them.
 */
export function useUpdateHarness(api: ApiClient | null): {
  updateHarness: (input: {
    harnessId: string;
    version: string;
  }) => Promise<HarnessApplyResponse>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: { harnessId: string; version: string }) => {
      if (!api) throw new Error("API unavailable");
      return await api.updateHarness(input.harnessId, input.version);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.harnessUpdates,
      });
    },
  });
  return { updateHarness: mutation.mutateAsync, isPending: mutation.isPending };
}

export function useRollbackHarness(api: ApiClient | null): {
  rollbackHarness: (input: {
    harnessId: string;
  }) => Promise<HarnessApplyResponse>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: { harnessId: string }) => {
      if (!api) throw new Error("API unavailable");
      return await api.rollbackHarness(input.harnessId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.harnessUpdates,
      });
    },
  });
  return {
    rollbackHarness: mutation.mutateAsync,
    isPending: mutation.isPending,
  };
}
