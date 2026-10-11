// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { AgentFlavor, HarnessManifest } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * The stock-4 harness capability manifests keyed by canonical agent id — the
 * SAME #3118 registry the Extensions page and projection compiler consume (R3).
 * `Partial` because the empty-fallback (see below) yields `{}` on a transient
 * fetch failure, so consumers must null-check a lookup.
 */
export type HarnessManifestMap = Partial<Record<AgentFlavor, HarnessManifest>>;

interface HarnessManifestsResponse {
  manifests: Record<AgentFlavor, HarnessManifest>;
}

/**
 * Fetch the harness capability-manifest catalog that backs the Create-page
 * capability-disclosure chips (issue #3121, epic #3117 Sub-Issue E).
 *
 * Reads `GET /api/harness-manifests` (JWT-authed), returning the stock-4
 * manifest DATA straight from the server-mounted #3118 registry — NOT a static
 * import, so the chips always reflect the live manifest (R4) with no
 * hand-maintained web-side copy.
 *
 * Modeled on `useExtensionRegistry.ts`: the generic `api.extensionRequest<T>()`
 * passthrough (inherits the Bearer header + 401 auto-refresh), `retry: false`,
 * and a safe empty-`{}` fallback so the chips render nothing rather than
 * crashing the Create page on a transient failure. `staleTime: Infinity` because
 * the manifests are static per server-process lifetime.
 */
export function useHarnessManifests(api: ApiClient | null) {
  return useQuery({
    queryKey: queryKeys.harnessManifests,
    queryFn: async (): Promise<HarnessManifestMap> => {
      if (!api) return {};
      const res = await api.extensionRequest<HarnessManifestsResponse>(
        "/api/harness-manifests"
      );
      return res.manifests ?? {};
    },
    enabled: Boolean(api),
    retry: false,
    staleTime: Infinity,
  });
}
