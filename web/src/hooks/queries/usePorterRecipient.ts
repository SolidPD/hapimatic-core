// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { PorterRecipientResponse } from "@/types/porter";
import { queryKeys } from "@/lib/query-keys";

/**
 * Fetch this instance's public recipient plus the fully-rendered extraction
 * prompt (`GET /api/porter/recipient`, #2341 + #2342) — backs the Admin →
 * Configuration page's extraction-prompt panel (issue #2344 R3).
 *
 * The `prompt` field is built SERVER-SIDE (`buildExtractionPrompt`, #2342). The
 * page displays it verbatim and NEVER rebuilds it client-side (directive D3):
 * a second construction path for a security-critical instruction would drift.
 * The prompt is static per instance, so `staleTime: Infinity`.
 */
export function usePorterRecipient(
  api: ApiClient | null,
  options?: { enabled?: boolean }
) {
  return useQuery<PorterRecipientResponse>({
    queryKey: queryKeys.porterRecipient,
    queryFn: () => {
      if (!api) throw new Error("No API client");
      return api.getPorterRecipient();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    staleTime: Infinity,
    retry: false,
  });
}
