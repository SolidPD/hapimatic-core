// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import { FALLBACK_CLAUDE_MODELS, type ClaudeModelInfo } from "@hapi/protocol";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * The LIVE Claude model catalog (issue #2456), fetched from
 * `GET /api/claude/models` (which proxies Anthropic's `/v1/models`, server-cached
 * with graceful fallback). Backs the "More models" pickers and the create-page
 * model dropdown, so a new Anthropic model appears with no code change.
 *
 * Resilient: the server route already degrades to a static catalog and never
 * errors, but `retry: false` + a `FALLBACK_CLAUDE_MODELS` default keeps the
 * picker populated even if the request itself fails (offline / auth blip). Long
 * `staleTime` — the catalog barely changes within a session.
 */
export function useClaudeModels(
  api: ApiClient | null,
  options?: { enabled?: boolean }
): { models: ClaudeModelInfo[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: queryKeys.claudeModels,
    queryFn: async () => {
      if (!api) return { models: FALLBACK_CLAUDE_MODELS, source: "fallback" };
      return await api.listClaudeModels();
    },
    enabled: (options?.enabled ?? true) && Boolean(api),
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  return {
    models: query.data?.models ?? FALLBACK_CLAUDE_MODELS,
    isLoading: query.isLoading,
  };
}
