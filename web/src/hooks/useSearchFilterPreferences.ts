// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { SearchFilterPreferences } from "@hapi/protocol/schemas";
import { queryKeys } from "@/lib/query-keys";

const DEFAULTS: SearchFilterPreferences = {
  searchText: "",
  filters: {
    status: "all",
    type: "all",
    project: "all",
    node: "all",
    harness: "all",
    account: "all",
    provider: "all",
    review: "all",
    linkedIssue: "all",
  },
  sort: "updated",
  sortDirection: "desc",
};

/**
 * Server-synced search/filter/sort bar preferences.
 *
 * Reads preferences from the server on mount. Text/selection changes are
 * debounced; sort-direction and clear-all apply immediately. (issue #942)
 */
export function useSearchFilterPreferences(api: ApiClient | null) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery({
    queryKey: queryKeys.searchFilterPreferences,
    queryFn: async () => {
      if (!api) throw new Error("API unavailable");
      return await api.getSearchFilterPreferences();
    },
    enabled: Boolean(api),
    staleTime: 60_000, // Preferences don't change often
  });

  const prefs = query.data ?? DEFAULTS;

  // Optimistic mutation for immediate feedback
  const mutation = useMutation({
    mutationFn: async (newPrefs: SearchFilterPreferences) => {
      if (!api) throw new Error("API unavailable");
      return await api.setSearchFilterPreferences(newPrefs);
    },
    onMutate: async (newPrefs: SearchFilterPreferences) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.searchFilterPreferences,
      });
      const snapshot = queryClient.getQueryData<SearchFilterPreferences>(
        queryKeys.searchFilterPreferences
      );
      queryClient.setQueryData(queryKeys.searchFilterPreferences, newPrefs);
      return { snapshot };
    },
    onError: (_err, _newPrefs, context) => {
      if (context?.snapshot) {
        queryClient.setQueryData(
          queryKeys.searchFilterPreferences,
          context.snapshot
        );
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.searchFilterPreferences,
      });
    },
  });

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Immediate update (for sort direction, clear-all)
  const updateImmediate = useCallback(
    (partial: Partial<SearchFilterPreferences>) => {
      const merged = { ...prefs, ...partial };
      if (partial.filters) {
        merged.filters = { ...prefs.filters, ...partial.filters };
      }
      mutation.mutate(merged);
    },
    [prefs, mutation]
  );

  // Debounced update (for text input, selection changes)
  const updateDebounced = useCallback(
    (partial: Partial<SearchFilterPreferences>) => {
      const merged = { ...prefs, ...partial };
      if (partial.filters) {
        merged.filters = { ...prefs.filters, ...partial.filters };
      }
      // Optimistic local update immediately
      queryClient.setQueryData(queryKeys.searchFilterPreferences, merged);
      // Debounce the server write
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        mutation.mutate(merged);
      }, 500);
    },
    [prefs, mutation, queryClient]
  );

  const setSearchText = useCallback(
    (searchText: string) => {
      updateDebounced({ searchText });
    },
    [updateDebounced]
  );

  const setFilterStatus = useCallback(
    (status: SearchFilterPreferences["filters"]["status"]) => {
      updateDebounced({ filters: { ...prefs.filters, status } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterType = useCallback(
    (type: SearchFilterPreferences["filters"]["type"]) => {
      updateDebounced({ filters: { ...prefs.filters, type } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterProject = useCallback(
    (project: SearchFilterPreferences["filters"]["project"]) => {
      updateDebounced({ filters: { ...prefs.filters, project } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterNode = useCallback(
    (node: SearchFilterPreferences["filters"]["node"]) => {
      updateDebounced({ filters: { ...prefs.filters, node } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterHarness = useCallback(
    (harness: SearchFilterPreferences["filters"]["harness"]) => {
      updateDebounced({ filters: { ...prefs.filters, harness } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterAccount = useCallback(
    (account: SearchFilterPreferences["filters"]["account"]) => {
      updateDebounced({ filters: { ...prefs.filters, account } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterProvider = useCallback(
    (provider: SearchFilterPreferences["filters"]["provider"]) => {
      updateDebounced({ filters: { ...prefs.filters, provider } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterReview = useCallback(
    (review: SearchFilterPreferences["filters"]["review"]) => {
      updateDebounced({ filters: { ...prefs.filters, review } });
    },
    [prefs.filters, updateDebounced]
  );

  const setFilterLinkedIssue = useCallback(
    (linkedIssue: SearchFilterPreferences["filters"]["linkedIssue"]) => {
      updateDebounced({ filters: { ...prefs.filters, linkedIssue } });
    },
    [prefs.filters, updateDebounced]
  );

  const setSort = useCallback(
    (sort: SearchFilterPreferences["sort"]) => {
      updateImmediate({ sort });
    },
    [updateImmediate]
  );

  const setSortDirection = useCallback(
    (sortDirection: SearchFilterPreferences["sortDirection"]) => {
      updateImmediate({ sortDirection });
    },
    [updateImmediate]
  );

  const clearAll = useCallback(() => {
    updateImmediate(DEFAULTS);
  }, [updateImmediate]);

  // Per-menu clears: reset just the filter groups (leaving sort + search) or
  // just the sort (leaving filters + search). Atomic single writes — composing
  // these from the per-field setters would race on a stale `prefs` closure
  // (each setter closes over the same snapshot, so only the last would land).
  // (post-#942)
  const clearFilters = useCallback(() => {
    updateImmediate({ filters: DEFAULTS.filters });
  }, [updateImmediate]);

  const clearSort = useCallback(() => {
    updateImmediate({
      sort: DEFAULTS.sort,
      sortDirection: DEFAULTS.sortDirection,
    });
  }, [updateImmediate]);

  return {
    prefs,
    isLoading: query.isLoading,
    setSearchText,
    setFilterStatus,
    setFilterType,
    setFilterProject,
    setFilterNode,
    setFilterHarness,
    setFilterAccount,
    setFilterProvider,
    setFilterReview,
    setFilterLinkedIssue,
    setSort,
    setSortDirection,
    clearAll,
    clearFilters,
    clearSort,
  };
}
