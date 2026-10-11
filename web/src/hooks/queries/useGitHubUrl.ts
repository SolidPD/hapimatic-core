// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

/**
 * Parses a git remote URL and returns a GitHub web URL.
 * Handles both SSH and HTTPS formats:
 * - git@github.com:owner/repo.git
 * - https://github.com/owner/repo.git
 * - https://github.com/owner/repo
 */
function parseGitRemoteToGitHubUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2]}`;
  }

  // HTTPS format: https://github.com/owner/repo.git or https://github.com/owner/repo
  const httpsMatch = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  return null;
}

export function useGitHubUrl(
  api: ApiClient | null,
  sessionId: string | null,
  options?: { enabled?: boolean }
): {
  githubUrl: string | null;
  isLoading: boolean;
  error: string | null;
} {
  const resolvedSessionId = sessionId ?? "unknown";

  const query = useQuery({
    queryKey: queryKeys.gitRemoteUrl(resolvedSessionId),
    queryFn: async () => {
      if (!api || !sessionId) {
        throw new Error("Session unavailable");
      }

      const result = await api.getGitRemoteUrl(sessionId);
      if (!result.success) {
        return {
          githubUrl: null,
          error: result.error ?? "Git remote unavailable",
        };
      }

      const remoteUrl = result.stdout?.trim() ?? "";
      const githubUrl = parseGitRemoteToGitHubUrl(remoteUrl);

      if (!githubUrl && remoteUrl) {
        return { githubUrl: null, error: "Not a GitHub repository" };
      }

      return { githubUrl, error: null };
    },
    enabled: options?.enabled ?? Boolean(api && sessionId),
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes - remote URLs don't change often
    refetchOnWindowFocus: false,
  });

  const queryError =
    query.error instanceof Error
      ? query.error.message
      : query.error
        ? "Git remote unavailable"
        : null;

  return {
    githubUrl: query.data?.githubUrl ?? null,
    isLoading: query.isLoading,
    error: queryError ?? query.data?.error ?? null,
  };
}
