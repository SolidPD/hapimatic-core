// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { TriggerAnalysisResponse } from "@/types/harnessUpdates";

/** `harnessId` names the harness; `range` (`"<from>..<to>"`) is the pending
 *  installed→latest range whose analysis key is invalidated on success so the
 *  `useHarnessAnalysis` poll picks up the freshly-spawned `analyzing` state. */
export type ReviewImpactInput = { harnessId: string; range: string };

/**
 * "Review impact" trigger mutation (epic #1769 Sub-Issue D, issue #1773).
 *
 * Calls `POST /api/harness/:harnessId/analyze` (#1772) to spawn the impact-analysis
 * peer session, then invalidates the analysis query so `useHarnessAnalysis` refetches
 * and enters its while-`analyzing` poll (completion detection lives THERE, not in this
 * one-shot invalidation). The response's `status` (`analyzing` / `at_capacity` /
 * `failed`) + `session_id` drive the panel's in-progress / terminal states (R5). A
 * duplicate in-flight trigger resolves to the existing `session_id` under `analyzing`.
 * The peer spawn/seed/artifact-persistence lives behind the endpoint in #1772 — this
 * hook is only the entry point.
 */
export function useReviewImpact(api: ApiClient | null): {
  reviewImpact: (input: ReviewImpactInput) => Promise<TriggerAnalysisResponse>;
  isPending: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (input: ReviewImpactInput) => {
      if (!api) throw new Error("API unavailable");
      return await api.triggerHarnessAnalysis(input.harnessId);
    },
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.harnessAnalysis(input.harnessId, input.range),
      });
    },
  });

  return {
    reviewImpact: mutation.mutateAsync,
    isPending: mutation.isPending,
    error:
      mutation.error instanceof Error
        ? mutation.error.message
        : mutation.error
          ? "Failed to start impact analysis"
          : null,
  };
}
