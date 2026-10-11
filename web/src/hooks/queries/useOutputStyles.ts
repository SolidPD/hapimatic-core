// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient, OutputStyleInfo } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Issue #2626 (D): the output-style catalog fetched from `GET /api/output-styles`
 * — the three built-ins plus any hub-local `~/.claude/output-styles/*.md` customs.
 * Backs the Create-page {@link OutputStyleSelector}.
 *
 * Resilient (mirrors {@link useClaudeModels}): the server route degrades to
 * built-ins-only and never errors, but `retry: false` + a `FALLBACK_OUTPUT_STYLES`
 * default keeps the dropdown populated even if the request itself fails (offline /
 * auth blip). Long `staleTime` — the catalog barely changes within a session.
 */
export const FALLBACK_OUTPUT_STYLES: readonly OutputStyleInfo[] = [
  {
    name: "default",
    description: "Claude's standard responses.",
    builtin: true,
  },
  {
    name: "Explanatory",
    description:
      "Claude explains its implementation choices and codebase patterns.",
    builtin: true,
  },
  {
    name: "Learning",
    description:
      "Claude pauses and asks you to write small pieces of code for hands-on practice.",
    builtin: true,
  },
];

export function useOutputStyles(api: ApiClient | null): {
  styles: OutputStyleInfo[];
  isLoading: boolean;
} {
  const query = useQuery({
    queryKey: queryKeys.outputStyles,
    queryFn: async () => {
      if (!api) return { styles: [...FALLBACK_OUTPUT_STYLES] };
      return await api.getOutputStyles();
    },
    enabled: Boolean(api),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  return {
    styles: query.data?.styles ?? [...FALLBACK_OUTPUT_STYLES],
    isLoading: query.isLoading,
  };
}
