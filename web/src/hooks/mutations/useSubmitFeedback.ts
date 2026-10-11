// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { FeedbackRequest } from "@/types/api";

/**
 * Submit user feedback (issue #2664, epic #2663). Mirrors the sibling
 * mutation-hook convention (e.g. useSetNodeMaxConcurrency). No query
 * invalidation — feedback is write-only from the client's perspective; the
 * admin viewer (#2666) is the read surface.
 */
export function useSubmitFeedback(api: ApiClient | null) {
  return useMutation({
    mutationFn: async (payload: FeedbackRequest) => {
      if (!api) throw new Error("API unavailable");
      return await api.submitFeedback(payload);
    },
  });
}
