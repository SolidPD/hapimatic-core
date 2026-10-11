// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { AboutInfo } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Consumer hook for B3's `GET /api/about` (issue #1983 B2, epic #1981). Supplies
 * the host-descriptor + harness-enumeration fields the About page cannot get from
 * existing app hooks: OS (name/kernel/arch), device model + cores, Tailscale
 * identity, the harness enumeration + versions, the build commit, and THIS
 * instance's process uptime.
 *
 * `staleTime: Infinity` — the payload is static for the server-process lifetime
 * (the `useVersion` idiom); this avoids re-triggering B3's up-to-4 `--version`
 * subprocess probes on every mount. `retry: false` plus a null-on-null-api
 * fallback means a missing / unreachable endpoint renders "—" rather than
 * crashing the page.
 *
 * MUST go through the authed `ApiClient` (`api.getAbout` → `this.request`,
 * JWT-bearing) — NOT a raw `fetch("/api/about")`. `/api/about` mounts AFTER the
 * JWT gate (B3 KD-2), so a raw fetch would 401 permanently and the safe-fallback
 * would mask it as an eternal "—".
 */
export function useAbout(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery<AboutInfo | null>({
    queryKey: queryKeys.about,
    queryFn: async () => {
      if (!api) return null;
      return await api.getAbout();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    staleTime: Infinity,
    retry: false,
  });
}
