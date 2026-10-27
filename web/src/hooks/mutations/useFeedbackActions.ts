// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, type ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type {
  FeedbackConvertResponse,
  FeedbackInboxItem,
  FeedbackStatus,
} from "@/types/api";

/** Why a row action did not complete, in words the page can show. */
export type FeedbackActionError =
  | { kind: "conflict" }
  | { kind: "gh_unavailable" }
  | { kind: "label_missing" }
  | { kind: "unavailable" }
  | { kind: "failed" };

/** Map a thrown action error to a {@link FeedbackActionError}. */
export function describeFeedbackActionError(err: unknown): FeedbackActionError {
  if (err instanceof ApiError) {
    if (err.status === 409) return { kind: "conflict" };
    if (err.code === "gh_unavailable") return { kind: "gh_unavailable" };
    if (err.code === "label_missing") return { kind: "label_missing" };
    if (err.status >= 502 && err.status <= 504) return { kind: "unavailable" };
  }
  return { kind: "failed" };
}

/**
 * Row actions of the shared feedback inbox (issue #2912): Acknowledge,
 * Dismiss (with a note), Reopen and Convert to GitHub issue. None of them names
 * an actor — the server records who acted. Every settle (success or failure)
 * refreshes the inbox, its counts and the local list, so a 409 ("another
 * operator acted on this row") shows the row as it now is.
 */
export function useFeedbackActions(api: ApiClient | null) {
  const queryClient = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["feedback-inbox"] }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.feedbackInboxCounts,
      }),
      queryClient.invalidateQueries({ queryKey: ["feedback-list"] }),
    ]);
  };
  const need = (): ApiClient => {
    if (!api) throw new Error("API unavailable");
    return api;
  };

  const acknowledge = useMutation<FeedbackInboxItem, unknown, string>({
    mutationFn: id =>
      need().patchFeedbackInboxItem(id, {
        status: "acknowledged",
        expectedStatus: ["new"],
      }),
    onSettled: refresh,
  });

  // Dismiss and Reopen send the row's status as shown (`from`) as the
  // compare-and-set guard. Without it, the gateway treats a dismiss of a row
  // another operator already dismissed as a 200 no-op that drops the new note,
  // and a stale Dismiss or Reopen overrides another operator's claim. With it,
  // either race is the 409 the page shows as "another operator acted".
  const dismiss = useMutation<
    FeedbackInboxItem,
    unknown,
    { id: string; note: string; from: FeedbackStatus }
  >({
    mutationFn: ({ id, note, from }) =>
      need().patchFeedbackInboxItem(id, {
        status: "dismissed",
        note,
        expectedStatus: [from],
      }),
    onSettled: refresh,
  });

  const reopen = useMutation<
    FeedbackInboxItem,
    unknown,
    { id: string; from: FeedbackStatus }
  >({
    mutationFn: ({ id, from }) =>
      need().patchFeedbackInboxItem(id, {
        status: "new",
        expectedStatus: [from],
      }),
    onSettled: refresh,
  });

  const convert = useMutation<FeedbackConvertResponse, unknown, string>({
    mutationFn: id => need().convertFeedbackInboxItem(id),
    onSettled: refresh,
  });

  return { acknowledge, dismiss, reopen, convert };
}
