// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import type { SessionSummary } from "@/types/api";

export function useDirectorySuggestions(
  machineId: string | null,
  sessions: SessionSummary[],
  recentPaths: string[]
): string[] {
  return useMemo(() => {
    const machineSessions = machineId
      ? sessions.filter(session => session.metadata?.machineId === machineId)
      : sessions;

    const sessionPaths = machineSessions
      .filter(session => !session.metadata?.worktree)
      .map(session => session.metadata?.path)
      .filter((path): path is string => Boolean(path));

    const worktreePaths = machineSessions
      .map(session => session.metadata?.worktree?.basePath)
      .filter((path): path is string => Boolean(path));

    const dedupedRecent = [...new Set(recentPaths)];
    const recentSet = new Set(dedupedRecent);

    const otherPaths = [...new Set([...sessionPaths, ...worktreePaths])]
      .filter(path => !recentSet.has(path))
      .sort((a, b) => a.localeCompare(b));

    return [...dedupedRecent, ...otherPaths];
  }, [machineId, sessions, recentPaths]);
}
