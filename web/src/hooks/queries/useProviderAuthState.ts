// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { NodeProviderAuthState } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

// Module-level stable empty fallback — keeps the pending-query array identity
// constant across renders (mirrors useAccountUsage EMPTY_USAGE).
const EMPTY_NODES: NodeProviderAuthState[] = [];

/**
 * Query the federation-wide non-Anthropic provider auth state (issue #3806, epic
 * #3345). Mirrors `useAccountUsage` — fetches `GET /api/federation/provider-auth-state`
 * only while `enabled`, returning one row per node (Codex/Gemini DERIVED fields).
 *
 * The response carries NO token/key value (structural guarantee — the server
 * parses the envelope on egress). `staleTime: 0` + a paused-when-backgrounded 60s
 * poll keeps the OpenAI / Gemini sections fresh, matching the account-usage
 * dashboard's freshness model.
 */
export function useProviderAuthState(
  api: ApiClient | null,
  enabled: boolean
): {
  nodes: NodeProviderAuthState[];
  isLoading: boolean;
  error: string | null;
} {
  const query = useQuery({
    queryKey: queryKeys.providerAuthState,
    queryFn: async () => {
      if (!api) {
        throw new Error("API unavailable");
      }
      return await api.getProviderAuthState();
    },
    enabled: Boolean(api && enabled),
    staleTime: 0,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  return {
    nodes: query.data?.nodes ?? EMPTY_NODES,
    isLoading: query.isLoading,
    error:
      query.error instanceof Error
        ? query.error.message
        : query.error
          ? "Failed to load provider auth state"
          : null,
  };
}
