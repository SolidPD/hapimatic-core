// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient } from "@tanstack/react-query";
import { queryRetry, queryRetryDelay } from "@/lib/nodeAvailability";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      // #5375: a node_offline / node_unreachable error (the session's
      // federation node is restarting) retries quietly — up to ~105 s offline,
      // ~30 s unreachable. TanStack keeps `error` null and the previous data
      // while it retries; every other error keeps the previous single retry.
      retry: queryRetry,
      retryDelay: queryRetryDelay,
    },
    mutations: {
      retry: 0,
    },
  },
});
