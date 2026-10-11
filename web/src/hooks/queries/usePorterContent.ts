// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { PorterContentResponse } from "@/types/porter";
import { queryKeys } from "@/lib/query-keys";

/** The selected Configuration item whose file the preview pane reads. */
export interface PorterContentSelection {
  dimension: "skills" | "hooks" | "agents" | "mcp";
  /** Dimension-relative name: skill/agent name, hooks-root-relative path, MCP server name. */
  name: string;
}

/**
 * Read the selected installed config file's text + absolute host path
 * (`GET /api/porter/content`, issue #3116) — backs the Admin → Configuration
 * page's preview pane. Lazy: fetches only while a row is selected (`enabled`),
 * so navigating the list costs nothing until the user clicks.
 *
 * `retry: false` mirrors `usePorterInstalled`, so a designed 404 (e.g. an MCP
 * row absent from the host `~/.claude.json`) renders the pane's friendly
 * "not present" state immediately rather than retrying.
 */
export function usePorterContent(
  api: ApiClient | null,
  selected: PorterContentSelection | null
) {
  return useQuery<PorterContentResponse>({
    // Stable, distinct key per selection; a placeholder key when nothing is
    // selected (the query is disabled, so it never runs).
    queryKey: selected
      ? queryKeys.porterContent(selected.dimension, selected.name)
      : queryKeys.porterContent("none", ""),
    queryFn: () => {
      if (!api) throw new Error("No API client");
      if (!selected) throw new Error("No selection");
      return api.getPorterContent(selected.dimension, selected.name);
    },
    enabled: Boolean(api) && Boolean(selected),
    retry: false,
  });
}
