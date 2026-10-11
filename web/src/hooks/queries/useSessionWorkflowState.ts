// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SessionWorkflowStateResponse } from "@hapi/protocol";
import { queryKeys } from "@/lib/query-keys";

/**
 * Server-authoritative session workflow-state (issue #1672, epic #1662 Sub J).
 *
 * Reads `GET /api/sessions/:id/workflow-state` — the `v_workflow_state` net
 * checkpoint badge for the session's linked issue (R2) plus the per-turn resolved
 * label events that feed the per-turn workflow chip (R1/R5). All J surfaces are
 * best-effort display (R7): on `isError`/no data the badge and chips simply do
 * not render — nothing load-bearing depends on label inference.
 *
 * A cheap SELECT over a view + an indexed JOIN; `refetchInterval` keeps the badge
 * and chips fresh after a turn finalizes (or the reconcile job updates the view)
 * without ever touching the prompt/reply path. Mirrors `useSessionTokenStats`.
 */
export function useSessionWorkflowState(
  api: ApiClient | null,
  sessionId: string | null
): {
  data: SessionWorkflowStateResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  refetch: () => Promise<unknown>;
} {
  const query = useQuery({
    queryKey: sessionId
      ? queryKeys.sessionWorkflowState(sessionId)
      : (["session-workflow-state", "none"] as const),
    queryFn: async () => {
      if (!api || !sessionId) throw new Error("API/session unavailable");
      return await api.getSessionWorkflowState(sessionId);
    },
    enabled: Boolean(api && sessionId),
    staleTime: 5_000,
    refetchInterval: 15_000,
  });

  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    refetch: query.refetch,
  };
}
