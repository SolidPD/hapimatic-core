// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { LoopCronVerdict } from "@/types/systemJobs";
import { queryKeys } from "@/lib/query-keys";

/**
 * Loop-cron per-loop mutation hook (issue #2453, Task 12 / R5).
 *
 * One `useMutation` per verb mapping to the node-scoped loop-cron routes
 * (`POST/DELETE /api/nodes/:nodeId/system-jobs/loop-cron/:id/...`). Every
 * success invalidates BOTH `queryKeys.systemJobs` (the panel's loop cards) AND
 * `queryKeys.sessionLoopSummaries` (the header badge) — otherwise a panel toggle
 * would leave the badge stale for up to 30s (the invalidation gap the original
 * plan missed).
 */
export function useLoopCronActions(api: ApiClient | null): {
  pause: (nodeId: string, id: string) => Promise<void>;
  resume: (nodeId: string, id: string) => Promise<void>;
  delete: (nodeId: string, id: string) => Promise<void>;
  /** Run a real tick; resolves to the tick verdict (R4) for the UI to display. */
  runNow: (nodeId: string, id: string) => Promise<LoopCronVerdict>;
  reschedule: (nodeId: string, id: string, interval: string) => Promise<void>;
  updateAction: (
    nodeId: string,
    id: string,
    actionText: string
  ) => Promise<void>;
  isPending: boolean;
} {
  const queryClient = useQueryClient();

  // #2453: invalidate BOTH the panel's loop cards AND the header badge summary,
  // so a mutation on either surface refreshes the other immediately.
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.systemJobs });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.sessionLoopSummaries,
    });
  };

  const pauseMutation = useMutation({
    mutationFn: async (v: { nodeId: string; id: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.loopCronPause(v.nodeId, v.id);
    },
    onSuccess: invalidate,
  });

  const resumeMutation = useMutation({
    mutationFn: async (v: { nodeId: string; id: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.loopCronResume(v.nodeId, v.id);
    },
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async (v: { nodeId: string; id: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.loopCronDelete(v.nodeId, v.id);
    },
    onSuccess: invalidate,
  });

  const runMutation = useMutation({
    mutationFn: async (v: { nodeId: string; id: string }) => {
      if (!api) throw new Error("API unavailable");
      const res = await api.loopCronRunNow(v.nodeId, v.id);
      return res.result.verdict;
    },
    onSuccess: invalidate,
  });

  const rescheduleMutation = useMutation({
    mutationFn: async (v: { nodeId: string; id: string; interval: string }) => {
      if (!api) throw new Error("API unavailable");
      await api.loopCronReschedule(v.nodeId, v.id, v.interval);
    },
    onSuccess: invalidate,
  });

  const updateActionMutation = useMutation({
    mutationFn: async (v: {
      nodeId: string;
      id: string;
      actionText: string;
    }) => {
      if (!api) throw new Error("API unavailable");
      await api.loopCronUpdateAction(v.nodeId, v.id, v.actionText);
    },
    onSuccess: invalidate,
  });

  return {
    pause: (nodeId, id) => pauseMutation.mutateAsync({ nodeId, id }),
    resume: (nodeId, id) => resumeMutation.mutateAsync({ nodeId, id }),
    delete: (nodeId, id) => deleteMutation.mutateAsync({ nodeId, id }),
    runNow: (nodeId, id) => runMutation.mutateAsync({ nodeId, id }),
    reschedule: (nodeId, id, interval) =>
      rescheduleMutation.mutateAsync({ nodeId, id, interval }),
    updateAction: (nodeId, id, actionText) =>
      updateActionMutation.mutateAsync({ nodeId, id, actionText }),
    isPending:
      pauseMutation.isPending ||
      resumeMutation.isPending ||
      deleteMutation.isPending ||
      runMutation.isPending ||
      rescheduleMutation.isPending ||
      updateActionMutation.isPending,
  };
}
