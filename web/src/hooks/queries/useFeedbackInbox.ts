// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type {
  FeedbackCounts,
  FeedbackInboxFilters,
  FeedbackInboxList,
} from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

// Module-level stable empty fallback (#3508): a pending query must not hand the
// page a fresh array each render.
const EMPTY_INBOX_ITEMS: FeedbackInboxList["items"] = [];

/**
 * The operators' shared feedback inbox (issue #2912, epic #2909 Sub C): one
 * filtered page of the gateway's central store, through this instance's proxy
 * (`api.getFeedbackInbox`, JWT-bearing — never a raw fetch).
 *
 * `options.enabled` is REQUIRED (the #5571 rule for `useFeedbackList`): the
 * page passes `gate === "open"`, so a closed, failed or still-checking gate
 * issues no inbox request (hooks cannot be called conditionally). `retry:
 * false`: a 404 (no gateway credential here) or a 502 (gateway down) is a
 * designed state the page shows at once, not something to retry silently.
 */
export function useFeedbackInbox(
  api: ApiClient | null,
  filters: Partial<FeedbackInboxFilters>,
  options: { enabled: boolean }
) {
  const query = useQuery<FeedbackInboxList | null>({
    queryKey: queryKeys.feedbackInbox(filters),
    queryFn: async () => (api ? await api.getFeedbackInbox(filters) : null),
    enabled: options.enabled && Boolean(api),
    retry: false,
    placeholderData: keepPreviousData,
  });
  return {
    items: query.data?.items ?? EMPTY_INBOX_ITEMS,
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}

/**
 * Per-status totals and the origins list of the shared inbox — the status chip
 * counts and the origin filter's options here, and #2913's badge.
 */
export function useFeedbackInboxCounts(
  api: ApiClient | null,
  options: { enabled: boolean }
) {
  const query = useQuery<FeedbackCounts | null>({
    queryKey: queryKeys.feedbackInboxCounts,
    queryFn: async () => (api ? await api.getFeedbackInboxCounts() : null),
    enabled: options.enabled && Boolean(api),
    retry: false,
  });
  return {
    counts: query.data ?? null,
    isError: query.isError,
  };
}
