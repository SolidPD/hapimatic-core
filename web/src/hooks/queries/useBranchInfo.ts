// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { parseStatusSummaryV2, getCurrentBranchV2 } from "@/lib/gitParsers";
import { queryKeys } from "@/lib/query-keys";
import {
  getCachedBranch,
  setCachedBranch,
  clearCachedBranch,
} from "@/hooks/useBranchCache";

export type BranchInfo = {
  branch: string | null;
  ahead: number | null;
  behind: number | null;
  upstream: string | null;
  isDetached: boolean;
  isInitial: boolean;
};

/**
 * Fetch branch info for a session with resilience to transient RPC failures.
 *
 * ROOT CAUSE OF PREVIOUS BUG: When the CLI socket temporarily disconnects/reconnects,
 * RPC calls fail with "RPC handler not registered". This was causing the branch to
 * disappear and show "No Git" until the socket reconnected and next poll succeeded.
 *
 * FIX: We now track the "last known good" branch info and continue showing it during
 * transient failures. Only show "No Git" if we've NEVER successfully fetched branch info.
 */
export function useBranchInfo(
  api: ApiClient | null,
  sessionId: string | null,
  options?: { enabled?: boolean; refetchInterval?: number; isActive?: boolean }
): {
  branchInfo: BranchInfo | null;
  isLoading: boolean;
  error: string | null;
  cachedBranch: string | null;
} {
  const resolvedSessionId = sessionId ?? "unknown";
  const defaultRefetchInterval = 10_000; // 10 seconds
  const isActive = options?.isActive ?? true;

  // Get cached branch for this session
  const cachedBranch = getCachedBranch(resolvedSessionId);

  // Track last known good branch info to survive transient RPC failures
  // This ref persists across re-renders and poll cycles
  const lastKnownGoodRef = useRef<BranchInfo | null>(null);

  const query = useQuery({
    queryKey: queryKeys.gitStatus(resolvedSessionId),
    queryFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }

      const statusResult = await api.getGitStatus(sessionId);
      if (!statusResult.success) {
        // RPC failed - this is often transient (socket disconnect/reconnect)
        // Return the error but don't clear the last known good value
        return {
          branchInfo: null,
          error:
            statusResult.error ??
            statusResult.stderr ??
            "Git status unavailable",
          isTransientError: true, // Mark as potentially transient
        };
      }

      const statusSummary = parseStatusSummaryV2(statusResult.stdout ?? "");
      const branchName = getCurrentBranchV2(statusSummary);
      const head = statusSummary.branch.head;

      const branchInfo: BranchInfo = {
        branch: branchName,
        ahead: statusSummary.branch.ahead ?? null,
        behind: statusSummary.branch.behind ?? null,
        upstream: statusSummary.branch.upstream ?? null,
        isDetached: head === "(detached)",
        isInitial: head === "(initial)",
      };

      return { branchInfo, error: null, isTransientError: false };
    },
    // Only fetch for active sessions - inactive sessions use cached branch
    enabled: isActive && (options?.enabled ?? Boolean(api && sessionId)),
    refetchInterval: isActive
      ? (options?.refetchInterval ?? defaultRefetchInterval)
      : false,
    refetchIntervalInBackground: false, // Pause polling when tab is inactive
    staleTime: 5 * 60_000, // Keep data fresh for 5 minutes to prevent flickering during refetch
    gcTime: 10 * 60_000, // Keep in cache for 10 minutes
    // Keep previous data during refetch to prevent UI flicker
    placeholderData: previousData => previousData,
  });

  // Update last known good value when we get a successful result
  useEffect(() => {
    const branchInfo = query.data?.branchInfo;
    if (branchInfo) {
      lastKnownGoodRef.current = branchInfo;
    }
  }, [query.data?.branchInfo]);

  // Cache branch when successfully fetched, or clear cache on detached HEAD
  useEffect(() => {
    const info = query.data?.branchInfo;
    if (info && sessionId) {
      if (info.isDetached) {
        clearCachedBranch(sessionId);
      } else if (info.branch) {
        setCachedBranch(sessionId, info.branch);
      }
    }
  }, [query.data?.branchInfo, sessionId]);

  const queryError =
    query.error instanceof Error
      ? query.error.message
      : query.error
        ? "Git status unavailable"
        : null;

  // Determine which branch info to return:
  // 1. If current query has valid branchInfo, use it
  // 2. If current query failed but we have last known good, use that (transient failure resilience)
  // 3. Otherwise return null (we've never successfully fetched)
  const effectiveBranchInfo =
    query.data?.branchInfo ?? lastKnownGoodRef.current ?? null;

  // Only report error if we have no branch info to show at all
  // (i.e., don't show "No Git" when we have a last known good value)
  const effectiveError = effectiveBranchInfo
    ? null // We have branch info, don't show error
    : (queryError ?? query.data?.error ?? null);

  return {
    branchInfo: effectiveBranchInfo,
    isLoading: query.isLoading && isActive, // Only show loading for active sessions
    error: effectiveError,
    cachedBranch,
  };
}
