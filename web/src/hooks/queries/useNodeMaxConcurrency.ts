// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * A node's current spawn cap for the Preferences control (issue #1805, R6).
 *
 * Server-backed (NOT localStorage / useAdminPreferences) — the cap is a
 * daemon-enforced operational setting shared by all clients, not a per-browser
 * UI preference. Mirrors `useNodeActiveAccount`'s resilience (30s poll,
 * `retry: false`, safe fallback) so the consuming card never crashes on a
 * transient fetch failure.
 */
export function useNodeMaxConcurrency(
  api: ApiClient | null,
  nodeId: string,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.nodeMaxConcurrency(nodeId),
    queryFn: async () => {
      if (!api || !nodeId) {
        return {
          value: null,
          effective: null,
          recommended: null,
          source: "unknown" as const,
        };
      }
      return await api.getNodeMaxConcurrency(nodeId);
    },
    enabled: (options?.enabled ?? true) && Boolean(api && nodeId),
    refetchInterval: 30_000,
    staleTime: 25_000,
    retry: false,
  });
}
