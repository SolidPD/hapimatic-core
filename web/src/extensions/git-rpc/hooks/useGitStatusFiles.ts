// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import type { GitStatusFiles } from "@/types/api";
import { buildGitStatusFiles } from "@/lib/gitParsers";
import { queryKeys } from "@/lib/query-keys";

export function useGitStatusFiles(
  api: ApiClient | null,
  sessionId: string | null,
  options?: {
    /** Gate the RPC (epic #3285 correction pass 1): the Files page passes
     *  `session.active` so an OFFLINE session never fires git-status RPCs that can
     *  only fail with "RPC handler not registered". */
    enabled?: boolean;
  }
): {
  status: GitStatusFiles | null;
  error: string | null;
  isLoading: boolean;
  /**
   * #6222: no fetch is running or paused, so no newer `status` is on the way. It
   * can still be old: this query does not poll. `isLoading` cannot say this: it is false during a background refetch, while
   * paused with no network, and when disabled. A disabled query is settled too,
   * so a caller that disables the query has to account for that.
   */
  isSettled: boolean;
  refetch: () => Promise<unknown>;
} {
  const resolvedSessionId = sessionId ?? "unknown";
  const query = useQuery({
    queryKey: queryKeys.gitStatusFiles(resolvedSessionId),
    queryFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }

      const statusResult = await api.getGitStatus(sessionId);
      if (!statusResult.success) {
        return {
          status: null,
          error:
            statusResult.error ??
            statusResult.stderr ??
            "Git status unavailable",
        };
      }

      const [unstagedResult, stagedResult] = await Promise.all([
        api.getGitDiffNumstat(sessionId, false),
        api.getGitDiffNumstat(sessionId, true),
      ]);

      const status = buildGitStatusFiles(
        statusResult.stdout ?? "",
        unstagedResult.success ? (unstagedResult.stdout ?? "") : "",
        stagedResult.success ? (stagedResult.stdout ?? "") : ""
      );

      const errors: string[] = [];
      if (!unstagedResult.success) {
        errors.push(
          `Unstaged diff unavailable: ${unstagedResult.error ?? unstagedResult.stderr ?? "unknown error"}`
        );
      }
      if (!stagedResult.success) {
        errors.push(
          `Staged diff unavailable: ${stagedResult.error ?? stagedResult.stderr ?? "unknown error"}`
        );
      }

      return { status, error: errors.length ? errors.join(" ") : null };
    },
    enabled: Boolean(api && sessionId) && (options?.enabled ?? true),
    // #6224: refetch on every mount, so coming back to the tab inside the 5 s
    // staleTime never shows Changes greyed over a status that changed since.
    refetchOnMount: "always",
  });

  const queryError =
    query.error instanceof Error
      ? query.error.message
      : query.error
        ? "Git status unavailable"
        : null;

  return {
    status: query.data?.status ?? null,
    error: queryError ?? query.data?.error ?? null,
    isLoading: query.isLoading,
    isSettled: query.fetchStatus === "idle",
    refetch: query.refetch,
  };
}
