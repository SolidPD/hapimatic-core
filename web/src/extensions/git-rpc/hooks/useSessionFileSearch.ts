// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { FileSearchItem } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

// #6224: a tree-wide ripgrep RPC per keystroke is wasted work on a Pi; wait for a
// short pause in typing. The first value is used at once (a search restored
// from the URL must not wait).
export const FILE_SEARCH_DEBOUNCE_MS = 250;

function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === debounced) return;
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, debounced, delayMs]);
  return debounced;
}

export function useSessionFileSearch(
  api: ApiClient | null,
  sessionId: string | null,
  query: string,
  options?: { limit?: number; enabled?: boolean; hidden?: boolean }
): {
  files: FileSearchItem[];
  error: string | null;
  isLoading: boolean;
  /** #6224: the query is waiting for the network (offline), not empty. */
  isPaused: boolean;
  /** #6224: `files` are an earlier query's results, kept up while the new one runs. */
  isStale: boolean;
  /** #6224: more files matched than were returned. */
  truncated: boolean;
  refetch: () => Promise<unknown>;
} {
  const resolvedSessionId = sessionId ?? "unknown";
  const limit = options?.limit ?? 200;
  const hidden = options?.hidden ?? false;
  // #6224: a whitespace-only query used to list 200 arbitrary files.
  const typed = query.trim();
  const trimmed = useDebouncedValue(typed, FILE_SEARCH_DEBOUNCE_MS);
  const callerEnabled = options?.enabled ?? Boolean(api && sessionId);
  const enabled = callerEnabled && trimmed.length > 0;
  // The typed query is ahead of the one being searched while the debounce runs.
  const debouncePending =
    callerEnabled && typed.length > 0 && typed !== trimmed;

  const result = useQuery({
    queryKey: [...queryKeys.sessionFiles(resolvedSessionId, trimmed), hidden],
    queryFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }
      const response = hidden
        ? await api.searchSessionFiles(sessionId, trimmed, limit, { hidden })
        : await api.searchSessionFiles(sessionId, trimmed, limit);
      if (!response.success) {
        return {
          files: [],
          error: response.error ?? "Failed to search files",
          truncated: false,
        };
      }
      return {
        files: response.files ?? [],
        error: null,
        truncated: response.truncated === true,
      };
    },
    enabled,
    // Keep the last results up while the next query loads, so typing does not
    // flash the list empty.
    placeholderData: keepPreviousData,
  });

  const queryError =
    result.error instanceof Error
      ? result.error.message
      : result.error
        ? "Failed to search files"
        : null;

  return {
    files: result.data?.files ?? [],
    error: queryError ?? result.data?.error ?? null,
    // A first query still waiting on the debounce has no results yet; it must
    // not read as "No files match your search."
    isLoading: result.isLoading || (debouncePending && !result.data),
    // isLoading is false while a query is paused with no network, which would
    // read as "No files match your search." (#6222 fixed the same for listings).
    // #6224 review: paused counts only when there is nothing current to show:
    // a first query (isPending) or an earlier query's kept-up results
    // (isPlaceholderData, which report success, so isPending alone missed
    // them). A Refresh of the same query while offline is also "paused", but
    // its results are still this query's, so they stay up.
    isPaused:
      result.fetchStatus === "paused" &&
      (result.isPending || result.isPlaceholderData),
    // The files belong to an earlier query: the new one is loading, waiting
    // for the network, or still behind the debounce.
    isStale: result.isPlaceholderData || debouncePending,
    truncated: result.data?.truncated ?? false,
    refetch: result.refetch,
  };
}
