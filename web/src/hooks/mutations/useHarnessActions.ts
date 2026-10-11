// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Harness settings actions (#1775): set the poll cadence + trigger a manual
 * "Check now". Bundles two mutations, à la `useHeartbeatMutations`.
 *
 *  - `setPollConfig` persists a new cadence (R3) and invalidates the config
 *    query. `isSavingConfig` drives the control's saving indicator.
 *  - `checkNow` reuses #1770's `POST /api/harness/check` (KD-4 — zero new
 *    detection logic) and invalidates #1773's harness-status query
 *    (`queryKeys.harnessUpdates`) so the panel + last-checked timestamp refresh
 *    (R4). `isChecking` drives the "checking…" state (R6); `checkCoalesced` is
 *    true when the last check joined an in-flight detection rather than running a
 *    fresh one, so the panel can surface "a check is already running" (R4).
 */
export function useHarnessActions(api: ApiClient | null): {
  setPollConfig: (pollIntervalMs: number) => Promise<unknown>;
  checkNow: () => Promise<unknown>;
  isSavingConfig: boolean;
  isChecking: boolean;
  checkCoalesced: boolean;
} {
  const queryClient = useQueryClient();

  const setPollConfigMutation = useMutation({
    mutationFn: async (pollIntervalMs: number) => {
      if (!api) throw new Error("API unavailable");
      return await api.setHarnessPollConfig(pollIntervalMs);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.harnessPollConfig,
      });
    },
  });

  const checkNowMutation = useMutation({
    mutationFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.triggerHarnessCheck();
    },
    onSuccess: () => {
      // A manual check re-runs #1770's detection → refresh #1773's panel status
      // query (installed/latest/last-checked) so the card + timestamp update (R4).
      void queryClient.invalidateQueries({
        queryKey: queryKeys.harnessUpdates,
      });
    },
  });

  return {
    setPollConfig: setPollConfigMutation.mutateAsync,
    checkNow: checkNowMutation.mutateAsync,
    isSavingConfig: setPollConfigMutation.isPending,
    isChecking: checkNowMutation.isPending,
    checkCoalesced: checkNowMutation.data?.coalesced ?? false,
  };
}
