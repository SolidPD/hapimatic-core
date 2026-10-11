// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { FederationPollResult } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { useToast } from "@/components/Toast";
import { queryKeys } from "@/lib/query-keys";

/**
 * Force an immediate federation poll (issue #3456), bypassing per-node backoff,
 * and return the status diff (newly-online / still-offline). Backs the
 * Create-page "Refresh federation" button.
 *
 * On success, invalidate BOTH federation query keys (KD-3): the Create-page
 * dropdown's `remoteNodes` come from `allSessionsQuery.data.nodes`, keyed by
 * `federationAllSessions` (`useFederatedSessions.ts`), so invalidating
 * `federationNodes` alone (which only feeds `localNode`) would NOT refresh the
 * list.
 */
export function usePollFederation(api: ApiClient | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.pollFederation();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.federationAllSessions,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.federationNodes });
    },
  });
}

/** Build the completion toast message from a force-poll diff (R6). */
export function formatPollResult(result: FederationPollResult): string {
  if (result.newlyOnline.length > 0) {
    const labels = result.newlyOnline.map(n => n.label).join(", ");
    const noun = result.newlyOnline.length === 1 ? "node" : "nodes";
    return `Found ${result.newlyOnline.length} ${noun}: ${labels}`;
  }
  if (result.stillOffline.length > 0) {
    const parts = result.stillOffline.map(n =>
      n.lastError ? `${n.label} (${n.lastError})` : n.label
    );
    return `No new nodes. Still offline: ${parts.join(", ")}`;
  }
  return "No new nodes.";
}

/**
 * Presentational adapter for the Federation Node refresh button (ruling A-D6,
 * adapted): bundles `usePollFederation` + `useToast` + `formatPollResult` and
 * returns the `{ onClick, isPending }` shape `MachineSelector`'s
 * `federationRefresh` prop expects. Keeps `MachineSelector` hook-free and keeps
 * the poll/toast wiring out of the (max-lines-capped) `NewSession/index.tsx`.
 * `useToast()` is provider-safe (no-op without a ToastProvider); the wrapped
 * `usePollFederation` needs a QueryClientProvider, so provider-free tests
 * (`index.test.tsx`) mock this hook.
 */
export function usePollFederationRefresh(api: ApiClient | null): {
  onClick: () => void;
  isPending: boolean;
} {
  const { showToast } = useToast();
  const poll = usePollFederation(api);
  const onClick = () => {
    poll.mutate(undefined, {
      onSuccess: result =>
        showToast(formatPollResult(result), {
          type: result.newlyOnline.length > 0 ? "success" : "info",
        }),
      onError: error =>
        showToast(
          "Federation poll failed: " +
            (error instanceof Error ? error.message : String(error)),
          { type: "error" }
        ),
    });
  };
  return { onClick, isPending: poll.isPending };
}
