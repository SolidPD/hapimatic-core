// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { InstalledConfigResponse } from "@/types/porter";
import { queryKeys } from "@/lib/query-keys";

/**
 * Read the currently-installed skills, agents, hooks, and plugins from this
 * instance's `~/.claude` (`GET /api/porter/installed`, #2343) — backs the
 * Admin → Configuration page's Skills / Hooks / Agents tabs (issue #2344 R1).
 *
 * R1's distinguishing word is *installed*, not importable: this is what the
 * instance already has, read server-side. `retry: false` mirrors
 * `useExtensionRegistry`, so a transient fetch failure renders an error state
 * rather than crashing the page.
 */
export function usePorterInstalled(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery<InstalledConfigResponse>({
    queryKey: queryKeys.porterInstalled,
    queryFn: () => {
      if (!api) throw new Error("No API client");
      return api.getPorterInstalled();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    retry: false,
  });
}
