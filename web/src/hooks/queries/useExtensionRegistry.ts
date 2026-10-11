// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ExtensionSummary } from "@hapi/protocol/ext";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * List every extension composed into the running build, with its metadata and
 * effective enable state — backs the Admin → Extensions page (issue #2329).
 *
 * Reads `GET /api/extension-registry` (authenticated), NOT the pre-auth
 * `GET /api/extension-prefs`. The latter is built from the SERVER registry alone,
 * so it cannot see web-only or CLI-only extensions and carries no
 * `requiredAtBuild` flag — a control plane cannot be built on it.
 *
 * Uses the generic `api.extensionRequest<T>()` passthrough rather than adding a
 * core `ApiClient` method: it delegates to the same private `request`, inheriting
 * the Bearer header and 401 auto-refresh for free.
 *
 * `retry: false` + a safe empty fallback mirror `useApiKeys`, so the page renders
 * an empty list rather than crashing on a transient fetch failure.
 */
export function useExtensionRegistry(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: queryKeys.extensionRegistry,
    queryFn: async (): Promise<ExtensionSummary[]> => {
      if (!api) return [];
      return await api.extensionRequest<ExtensionSummary[]>(
        "/api/extension-registry"
      );
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}
