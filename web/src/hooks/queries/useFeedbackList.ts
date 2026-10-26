// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { FeedbackListResponse } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

// #3508: module-level stable empty fallback — keeps the pending-query array
// identity constant across renders (the #3462 render-loop fuel). Pattern:
// useMessages.ts EMPTY_BUBBLES.
const EMPTY_FEEDBACK_ITEMS: FeedbackListResponse["items"] = [];

/**
 * Consumer hook for the #2666 admin Feedback viewer's `GET /api/feedback`
 * (epic #2663 Sub C). Fetches one page of persisted feedback rows newest-first
 * plus the pagination `total`.
 *
 * MUST go through the authed `ApiClient` (`api.getFeedbackList` → `this.request`,
 * JWT-bearing) — NOT a raw `fetch("/api/feedback")`, which would 401 permanently
 * because the endpoint mounts behind the JWT gate (mirrors `useAbout`).
 *
 * `retry: false` plus a null-on-null-api fallback means an unreachable endpoint
 * renders the page's empty/error state rather than crashing. `keepPreviousData`
 * keeps the current page visible while the next one loads, so paging does not
 * flash the whole list back to the loading state.
 */
export function useFeedbackList(
  api: ApiClient | null,
  params: { limit: number; offset: number },
  // #2910: the page passes the operator-instance preflight verdict here, so a
  // closed instance never requests rows (hooks cannot be called conditionally).
  // #5571: required, so a caller cannot fetch on a closed instance by omission.
  options: { enabled: boolean }
) {
  const query = useQuery<FeedbackListResponse | null>({
    queryKey: queryKeys.feedbackList(params.limit, params.offset),
    queryFn: async () => {
      if (!api) return null;
      return await api.getFeedbackList({
        limit: params.limit,
        offset: params.offset,
      });
    },
    enabled: options.enabled && Boolean(api),
    retry: false,
    placeholderData: keepPreviousData,
  });

  return {
    items: query.data?.items ?? EMPTY_FEEDBACK_ITEMS,
    total: query.data?.total ?? 0,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
