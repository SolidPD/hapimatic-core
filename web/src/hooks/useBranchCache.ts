// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Local storage cache for session branch names.
 * This allows us to show the last known branch for inactive sessions.
 */

const STORAGE_KEY = "hapi:sessionBranches";

export type BranchCacheEntry = {
  branch: string;
  updatedAt: number;
};

type BranchCache = Record<string, BranchCacheEntry>;

/**
 * Get all cached branches from localStorage
 */
export function getCachedBranches(): BranchCache {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

/**
 * Get cached branch for a specific session
 */
export function getCachedBranch(sessionId: string): string | null {
  const cache = getCachedBranches();
  return cache[sessionId]?.branch ?? null;
}

/**
 * Save branch to cache for a session
 */
export function setCachedBranch(sessionId: string, branch: string): void {
  const cache = getCachedBranches();
  cache[sessionId] = {
    branch,
    updatedAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
}

/**
 * Clear cached branch for a session (e.g., when session is deleted)
 */
export function clearCachedBranch(sessionId: string): void {
  const cache = getCachedBranches();
  delete cache[sessionId];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
}

/**
 * Prune stale entries from cache (sessions that no longer exist)
 */
export function pruneBranchCache(validSessionIds: Set<string>): void {
  const cache = getCachedBranches();
  let changed = false;
  for (const sessionId of Object.keys(cache)) {
    if (!validSessionIds.has(sessionId)) {
      delete cache[sessionId];
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  }
}
