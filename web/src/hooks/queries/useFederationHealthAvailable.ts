// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { FederationNodesResponse } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/** `GET /api/federation/nodes`; answers 200 on every install, federated or not. */
export function useFederationNodesInfo(api: ApiClient | null) {
  return useQuery({
    queryKey: queryKeys.federationNodes,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getFederationNodes();
    },
    enabled: Boolean(api),
    staleTime: 60000,
    retry: 1,
  });
}

/**
 * Whether the server behind this nodes read runs a health aggregator, i.e.
 * whether `GET /api/federation/health/*` and `/api/federation/alerts` can
 * answer anything but 503. The
 * server says so in `healthAvailable` (#6217: every node runs one, local-only
 * on a standalone install or a spoke). A server older than #6217 sends no
 * field; the fallback keeps the #4468 / #5180 F12 rule (a standalone install or
 * a spoke has none), so that server is never polled into 503s, which the
 * browser logs whether or not the client reports them (#2362). False without
 * data.
 */
export function federationHealthAvailable(
  data: FederationNodesResponse | undefined
): boolean {
  if (!data) return false;
  return data.healthAvailable ?? (data.enabled && data.role !== "node");
}

/**
 * The health pollers' gate (#4468, #5180 F12, #6217). False while the nodes
 * read is loading, so the first paint never sends the request.
 */
export function useFederationHealthAvailable(api: ApiClient | null): boolean {
  const { data } = useFederationNodesInfo(api);
  return federationHealthAvailable(data);
}
