// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
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
 * Whether this install has a federation health aggregator, i.e. whether
 * `GET /api/federation/health/nodes` can answer anything but 503 (#4468, #5180
 * F12). A standalone install (`enabled: false`) and a spoke (`role: "node"`)
 * have none, so the health pollers must not run there: the browser logs every
 * failed request itself, whether or not the client reports it (#2362). False
 * while the nodes read is loading, so the first paint never sends the request.
 */
export function useFederationHealthAvailable(api: ApiClient | null): boolean {
  const { data } = useFederationNodesInfo(api);
  return Boolean(data?.enabled && data.role !== "node");
}
