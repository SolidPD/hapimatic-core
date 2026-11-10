// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { McpCatalogResponse } from "@hapi/protocol/schemas";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

type CatalogQueryData = {
  catalog: McpCatalogResponse | undefined;
  unavailable: boolean;
};

/**
 * Issue #6171: the MCP servers known for a project on the TARGET node — the New
 * Session picker's and the session configuration modal's data source.
 *
 * Read-only on purpose: unlike `useMcpStatus` it never polls and carries no
 * mutations or toasts, so mounting it in the form costs one request per
 * directory. `placeholderData` keeps the previous list while the next one loads,
 * so the rows do not flicker when the directory changes. `unavailable` tells "the
 * node cannot answer" (an older peer, a failure) apart from "still loading", so
 * the field can hide instead of spinning. An `mcp-status-updated` event
 * invalidates every catalog (`useSSE`). A refetch that fails keeps the list it
 * already has: only a key that never loaded reads as unavailable, so a blip
 * after the user has picked servers cannot empty the picker (#6171 review W1).
 *
 * The catalog route is a pure read, so a cold list (`stale: true`) is filled
 * from here: for a local target the hook asks `POST /api/mcp-status/refresh`
 * once, and the refresh's SSE event refetches the list. That route polls this
 * node only, so a remote target waits for its own daemon's poll.
 */
export function useMcpCatalog(options: {
  api: ApiClient | null;
  directory: string;
  nodeId?: string | null;
  enabled?: boolean;
}): {
  catalog: McpCatalogResponse | undefined;
  isLoading: boolean;
  unavailable: boolean;
} {
  const { api, nodeId } = options;
  const directory = options.directory.trim();
  const queryClient = useQueryClient();
  const queryKey = queryKeys.mcpCatalog(directory, nodeId ?? undefined);
  const query = useQuery({
    queryKey,
    queryFn: async (): Promise<CatalogQueryData> => {
      // On failure, keep this key's last good list (a refetch), else report
      // unavailable (nothing ever loaded for this directory and node).
      const failed = (): CatalogQueryData => {
        const previous =
          queryClient.getQueryData<CatalogQueryData>(queryKey)?.catalog;
        return previous
          ? { catalog: previous, unavailable: false }
          : { catalog: undefined, unavailable: true };
      };
      if (!api) return failed();
      try {
        const result = await api.getMcpCatalog(directory, nodeId);
        return result.success
          ? { catalog: result.catalog, unavailable: false }
          : failed();
      } catch {
        // Not rethrown: a throwing queryFn retries and never reports unavailable.
        return failed();
      }
    },
    enabled: (options.enabled ?? true) && Boolean(api && directory),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const stale = query.data?.catalog?.stale ?? false;
  const refreshAsked = useRef(false);
  useEffect(() => {
    if (!stale || nodeId || !api || refreshAsked.current) return;
    refreshAsked.current = true;
    // Best-effort: on failure the list stays stale and still names every server
    // the node has seen; the daemon's next poll fills it.
    void api.refreshMcpStatus().catch(() => undefined);
  }, [stale, nodeId, api]);

  return {
    catalog: query.data?.catalog,
    isLoading: query.isLoading,
    unavailable: query.data?.unavailable ?? false,
  };
}
