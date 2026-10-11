// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiClient } from "@/api/client";
import { getStorageKey } from "@/lib/storage-keys";

const CACHE_KEY = "hapi:recentPaths:cache";
const LAST_MACHINE_ID_KEY = getStorageKey("hapi:lastMachineId");
const LEGACY_KEY = getStorageKey("hapi:recentPaths");
const MIGRATED_KEY = "hapi:recentPaths:migrated";
const MAX_PATHS = 10;

function loadCachedPaths(cacheId: string): string[] {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    if (!stored) return [];
    const data: Record<string, string[]> = JSON.parse(stored);
    return data[cacheId] ?? [];
  } catch {
    return [];
  }
}

function saveCachedPaths(cacheId: string, paths: string[]): void {
  try {
    const stored = localStorage.getItem(CACHE_KEY);
    const data: Record<string, string[]> = stored ? JSON.parse(stored) : {};
    data[cacheId] = paths;
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch {
    // Ignore storage errors
  }
}

function loadLegacyPaths(machineId: string): string[] {
  try {
    const stored = localStorage.getItem(LEGACY_KEY);
    if (!stored) return [];
    const data: Record<string, string[]> = JSON.parse(stored);
    return data[machineId] ?? [];
  } catch {
    return [];
  }
}

function hasLegacyData(): boolean {
  try {
    return localStorage.getItem(LEGACY_KEY) !== null;
  } catch {
    return false;
  }
}

function markMigrated(): void {
  try {
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    // Ignore
  }
}

function isMigrated(): boolean {
  try {
    return localStorage.getItem(MIGRATED_KEY) === "1";
  } catch {
    return false;
  }
}

function clearLegacyData(): void {
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // Ignore
  }
}

/** Strip /.worktrees/<name> suffix to get the project-level directory */
function normalizeWorktreePath(path: string): string {
  const idx = path.indexOf("/.worktrees/");
  return idx !== -1 ? path.slice(0, idx) : path;
}

export function useRecentPaths(
  api: ApiClient,
  machineId: string | null,
  nodeId?: string | null
) {
  // Use node: prefix for remote cache keys to avoid collisions
  const cacheId = nodeId ? `node:${nodeId}` : machineId;
  const targetId = cacheId;

  const [recentPaths, setRecentPaths] = useState<string[]>(() =>
    targetId ? loadCachedPaths(targetId) : []
  );
  const [isLoading, setIsLoading] = useState(false);
  const fetchedTargetRef = useRef<string | null>(null);

  // Fetch from server when target changes
  useEffect(() => {
    if (!targetId) {
      setRecentPaths([]);
      return;
    }

    // Use cached paths immediately (stale-while-revalidate)
    const cached = loadCachedPaths(targetId);
    if (cached.length > 0) {
      setRecentPaths(cached);
    }

    // Skip duplicate fetches for same target
    if (fetchedTargetRef.current === targetId) return;

    let cancelled = false;
    setIsLoading(true);

    void (async () => {
      // Migrate legacy localStorage data on first fetch (local machines only)
      if (machineId && !nodeId && !isMigrated() && hasLegacyData()) {
        const legacy = loadLegacyPaths(machineId);
        if (legacy.length > 0) {
          for (const path of legacy) {
            try {
              await api.addRecentPath(machineId, path);
            } catch {
              // Ignore individual migration failures
            }
          }
        }
        markMigrated();
        clearLegacyData();
      }

      try {
        const paths = nodeId
          ? await api.getNodeRecentPaths(nodeId)
          : machineId
            ? await api.getRecentPaths(machineId)
            : [];
        if (cancelled) return;
        fetchedTargetRef.current = targetId;
        setRecentPaths(paths);
        saveCachedPaths(targetId, paths);
      } catch {
        // Keep using cached data on fetch failure
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, machineId, nodeId, targetId]);

  const addRecentPath = useCallback(
    (path: string): void => {
      if (!targetId) return;
      const trimmed = normalizeWorktreePath(path.trim());
      if (!trimmed) return;

      // Optimistic update: add to front, dedupe, cap at MAX_PATHS
      setRecentPaths(prev => {
        const filtered = prev.filter(p => p !== trimmed);
        const updated = [trimmed, ...filtered].slice(0, MAX_PATHS);
        saveCachedPaths(targetId, updated);
        return updated;
      });

      // Fire-and-forget POST to server
      if (nodeId) {
        void api.addNodeRecentPath(nodeId, trimmed).catch(() => {});
      } else if (machineId) {
        void api.addRecentPath(machineId, trimmed).catch(() => {});
      }
    },
    [api, machineId, nodeId, targetId]
  );

  const removeRecentPath = useCallback(
    (path: string): void => {
      if (!targetId) return;
      const trimmed = path.trim();
      if (!trimmed) return;

      // Optimistic removal from state + cache
      setRecentPaths(prev => {
        const updated = prev.filter(p => p !== trimmed);
        saveCachedPaths(targetId, updated);
        return updated;
      });

      // Fire-and-forget DELETE to server
      if (nodeId) {
        void api
          .removeNodeRecentPath(nodeId, trimmed)
          .catch(err =>
            console.warn("[RecentPaths] Failed to remove path on node:", err)
          );
      } else if (machineId) {
        void api
          .removeRecentPath(machineId, trimmed)
          .catch(err =>
            console.warn("[RecentPaths] Failed to remove path:", err)
          );
      }
    },
    [api, machineId, nodeId, targetId]
  );

  const getLastUsedMachineId = useCallback((): string | null => {
    try {
      return localStorage.getItem(LAST_MACHINE_ID_KEY);
    } catch {
      return null;
    }
  }, []);

  const setLastUsedMachineId = useCallback((id: string): void => {
    try {
      localStorage.setItem(LAST_MACHINE_ID_KEY, id);
    } catch {
      // Ignore storage errors
    }
  }, []);

  return useMemo(
    () => ({
      recentPaths,
      addRecentPath,
      removeRecentPath,
      isLoading,
      getLastUsedMachineId,
      setLastUsedMachineId,
    }),
    [
      recentPaths,
      addRecentPath,
      removeRecentPath,
      isLoading,
      getLastUsedMachineId,
      setLastUsedMachineId,
    ]
  );
}
