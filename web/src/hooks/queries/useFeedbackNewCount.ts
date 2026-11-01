// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { FeedbackCounts } from "@/types/api";
import { queryKeys } from "@/lib/query-keys";

/**
 * The count of `status = new` items in the operators' shared feedback inbox,
 * for the footer envelope's unread badge (issue #2913, epic #2909 Sub D).
 *
 * `options.enabled` is REQUIRED (the #5571 rule for `useFeedbackList` /
 * `useFeedbackInbox`): the caller passes the operator gate
 * (`useFeedbackPreflight(api).data?.enabled === true`), so no caller can poll a
 * closed instance by omission. BrandedFrame mounts this on every page, so a
 * closed, failed or still-checking gate must issue NO counts request.
 *
 * Polls every 30 s (`useNodeActiveAccount` pattern); TanStack pauses the
 * interval while the tab is hidden. `retry: false`: 404 (no gateway credential
 * here) and 502–504 (gateway down) are declared designed states, and the badge
 * just stays hidden until the next poll.
 *
 * Shares `queryKeys.feedbackInboxCounts` with `useFeedbackInboxCounts`, so the
 * inbox page's row actions (which invalidate that key) refresh the badge at
 * once. The query function returns the same `FeedbackCounts | null` shape as
 * that hook, because both observers read one cache entry.
 *
 * `newCount` is `null` while loading, on any error, or for a malformed payload
 * (the client runtime-parses it) — the caller renders no badge for `null`.
 */
export function useFeedbackNewCount(
  api: ApiClient | null,
  options: { enabled: boolean }
): { newCount: number | null } {
  const query = useQuery<FeedbackCounts | null, Error, number | null>({
    queryKey: queryKeys.feedbackInboxCounts,
    queryFn: async () => (api ? await api.getFeedbackInboxCounts() : null),
    select: counts => counts?.new ?? null,
    enabled: options.enabled && Boolean(api),
    refetchInterval: 30_000,
    retry: false,
  });
  return { newCount: query.isError ? null : (query.data ?? null) };
}
