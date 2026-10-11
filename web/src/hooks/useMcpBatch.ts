// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppContext } from "@/lib/app-context";
import { queryKeys } from "@/lib/query-keys";
import type {
  McpBatchSnapshot,
  McpBatchStateResponse,
  McpSetDesiredResponse,
} from "@/types/api";

/**
 * Server-side MCP batch coordinator hook (issue #989 follow-up).
 *
 * Replaces the previous client-side `runBatch` for-loop in StatusBar.
 * The web client now fires a SINGLE setMcpDesired request and listens
 * for `mcp-batch-progress` SSE events to render progress. The actual
 * iteration runs server-side, so iOS PWA tab suspension no longer
 * pauses the batch.
 *
 * Concurrent batches: a counter-batch (e.g. user enables all, then
 * mid-batch disables all) is reconciled declaratively by the server —
 * it computes pending = (current ≠ desired) on each iteration and
 * naturally drops items already in their new desired state.
 */
export function useMcpBatch(sessionId: string | null | undefined): {
  snapshot: McpBatchSnapshot | null;
  /** True iff there is an in-flight batch (worker active OR mutation pending). */
  isActive: boolean;
  /** Submit a partial desired state. Merges into the server's existing desired. */
  setDesired: (
    desired: Record<string, boolean>
  ) => Promise<McpSetDesiredResponse>;
  /** True while the network request to setDesired is in flight. */
  isSettingDesired: boolean;
  /** True when initial state fetch is in progress. */
  isLoading: boolean;
} {
  const { api } = useAppContext();
  const queryClient = useQueryClient();
  const enabled = sessionId !== null && sessionId !== undefined;

  const { data, isLoading } = useQuery<McpBatchStateResponse>({
    queryKey: enabled
      ? queryKeys.mcpBatchState(sessionId)
      : ["mcp-batch-state", "_disabled"],
    queryFn: () => api.getMcpBatchState(sessionId as string),
    enabled,
    // SSE pushes updates — no need to poll. Keep stale forever; cache is
    // overwritten by the SSE event handler in useSSE.
    staleTime: Infinity,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });

  const setDesiredMutation = useMutation<
    McpSetDesiredResponse,
    Error,
    Record<string, boolean>
  >({
    mutationFn: async desired => {
      if (!enabled) {
        throw new Error("Cannot set desired without a sessionId");
      }
      return await api.setMcpDesired(sessionId as string, desired);
    },
    onSuccess: result => {
      if (result.ok && enabled) {
        // Seed the cache with the immediate snapshot so the UI updates
        // before the first SSE event arrives.
        queryClient.setQueryData<McpBatchStateResponse>(
          queryKeys.mcpBatchState(sessionId),
          { snapshot: result.snapshot }
        );
      }
    },
  });

  const setDesired = useCallback(
    (desired: Record<string, boolean>) =>
      setDesiredMutation.mutateAsync(desired),
    [setDesiredMutation]
  );

  const snapshot = data?.snapshot ?? null;
  return {
    snapshot,
    isActive:
      Boolean(snapshot && (snapshot.isActive || snapshot.processing)) ||
      setDesiredMutation.isPending,
    setDesired,
    isSettingDesired: setDesiredMutation.isPending,
    isLoading,
  };
}
