// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import type { SessionSummary } from "@/types/api";
import { useDirectorySuggestions } from "@/hooks/useDirectorySuggestions";

/** NUL — the one byte a filesystem path can never contain (see `pathsKey`). */
const PATH_KEY_SEPARATOR = String.fromCharCode(0);

/**
 * Directory path-existence tracking for the Create page (extracted from
 * `index.tsx` for #2930). Gathers candidate paths (recents + session/worktree
 * dirs) via {@link useDirectorySuggestions}, checks their existence against the
 * selected local machine OR remote node, and auto-prunes stale entries from the
 * recents list when a check returns false. Returns the `path → exists` map read
 * by the Directory field, `canCreate`, and the section summaries.
 */
export function usePathExistence(opts: {
  api: ApiClient;
  localMachineId: string | null;
  remoteNodeId: string | null;
  sessions: SessionSummary[];
  recentPaths: string[];
  removeRecentPath: (path: string) => void;
}): Record<string, boolean> {
  const {
    api,
    localMachineId,
    remoteNodeId,
    sessions,
    recentPaths,
    removeRecentPath,
  } = opts;

  const [pathExistence, setPathExistence] = useState<Record<string, boolean>>(
    {}
  );

  // Path suggestions — works for both local machines and remote nodes
  const allPaths = useDirectorySuggestions(
    localMachineId,
    sessions,
    recentPaths
  );

  // #3462: key the memo on CONTENT, not array identity. `allPaths` inherits a
  // fresh identity whenever an upstream query is still pending (`sessions ?? []`
  // is a new array per render), which re-ran the effect below on every render and
  // — via the fresh `{}` it wrote — drove a self-sustaining re-render loop. It
  // surfaced as "Maximum update depth exceeded" once a commit-phase state update
  // (the #3462 Radix tooltip trigger) kept the loop from yielding to the event
  // loop. Paths cannot contain NUL, so the NUL-joined key changes exactly when
  // the path list does.
  const pathsKey = allPaths.join(PATH_KEY_SEPARATOR);
  const pathsToCheck = useMemo(
    () => Array.from(new Set(allPaths)).slice(0, 1000),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content (pathsKey), not on the array identity
    [pathsKey]
  );

  // Check path existence — works for both local and remote targets
  useEffect(() => {
    let cancelled = false;
    // Preserve the existing empty object so an already-empty result never
    // produces a new reference (a fresh `{}` re-renders every consumer).
    const clear = () =>
      setPathExistence(prev => (Object.keys(prev).length === 0 ? prev : {}));

    if (pathsToCheck.length === 0) {
      clear();
      return () => {
        cancelled = true;
      };
    }

    if (remoteNodeId) {
      void api
        .checkNodePathsExists(remoteNodeId, pathsToCheck)
        .then(result => {
          if (cancelled) return;
          setPathExistence(result.exists ?? {});
        })
        .catch(() => {
          if (cancelled) return;
          clear();
        });
    } else if (localMachineId) {
      void api
        .checkMachinePathsExists(localMachineId, pathsToCheck)
        .then(result => {
          if (cancelled) return;
          setPathExistence(result.exists ?? {});
        })
        .catch(() => {
          if (cancelled) return;
          clear();
        });
    } else {
      clear();
    }

    return () => {
      cancelled = true;
    };
  }, [localMachineId, remoteNodeId, pathsToCheck, api]);

  // Auto-prune stale paths from recent list when existence check returns false
  const prunedPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (Object.keys(pathExistence).length === 0) return;

    for (const path of recentPaths) {
      if (pathExistence[path] === false && !prunedPathsRef.current.has(path)) {
        prunedPathsRef.current.add(path);
        removeRecentPath(path);
      }
    }
  }, [pathExistence, recentPaths, removeRecentPath]);

  return pathExistence;
}
