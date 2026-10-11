// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * List stored provider API keys for the admin API Keys page (issue #1955).
 *
 * Server-backed (NOT localStorage / useAdminPreferences) — the key store is
 * node-local operational state shared by all clients, not a per-browser UI
 * preference. Responses are RedactedApiKey (masked) only. Mirrors
 * `useNodeMaxConcurrency`'s resilience (`retry: false` + safe empty fallback) so
 * the page never crashes on a transient fetch failure.
 */
export function useApiKeys(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.apiKeys,
    queryFn: async () => {
      if (!api) return [];
      return await api.listApiKeys();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}
