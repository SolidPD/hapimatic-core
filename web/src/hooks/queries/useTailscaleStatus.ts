// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * This VM's tailnet state (`GET /api/network/tailscale`, #6211). `data` stays
 * undefined until it answers and after a failed read, so a caller can tell "not
 * available here" from "not known yet".
 */
export function useTailscaleStatus(api: ApiClient | null) {
  return useQuery({
    queryKey: queryKeys.tailscaleStatus,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getTailscaleStatus();
    },
    enabled: Boolean(api),
    retry: false,
  });
}
