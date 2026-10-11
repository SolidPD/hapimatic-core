// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "hapi:lastSeenTimestamp";

/**
 * Get all last-seen timestamps from localStorage
 */
function getLastSeenTimestamps(): Record<string, number> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

/**
 * Save last-seen timestamps to localStorage
 */
function setLastSeenTimestamps(timestamps: Record<string, number>): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(timestamps));
}

/**
 * Hook to track which sessions need user review.
 *
 * A session "needs review" when:
 * 1. It's active
 * 2. It's not thinking (Claude finished)
 * 3. Its updatedAt timestamp is newer than the user's last seen timestamp
 *
 * Uses localStorage for persistence and cross-tab synchronization.
 */
export function useNeedsReview() {
  // Store timestamps in state for reactivity
  const [lastSeenTimestamps, setLastSeenState] = useState<
    Record<string, number>
  >(getLastSeenTimestamps);

  // Track if we've initialized to avoid unnecessary re-renders
  const initializedRef = useRef(false);

  // Subscribe to cross-tab storage events
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY || e.key === null) {
        setLastSeenState(getLastSeenTimestamps());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Initialize once on mount
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      setLastSeenState(getLastSeenTimestamps());
    }
  }, []);

  /**
   * Check if a session needs review
   */
  const checkNeedsReview = useCallback(
    (
      sessionId: string,
      updatedAt: number,
      active: boolean,
      thinking: boolean,
      needsReviewOverride?: "read" | "unread" | null
    ): boolean => {
      // Only active, non-thinking sessions can need review
      if (!active || thinking) return false;

      // Manual override takes precedence over automatic detection
      if (needsReviewOverride === "read") return false;
      if (needsReviewOverride === "unread") return true;

      const lastSeen = lastSeenTimestamps[sessionId] ?? 0;
      return updatedAt > lastSeen;
    },
    [lastSeenTimestamps]
  );

  /**
   * Mark a session as "seen" (clears the needs review indicator)
   */
  const markAsSeen = useCallback(
    (sessionId: string, updatedAt: number): void => {
      setLastSeenState(prev => {
        // Only update if this is newer than what we've seen
        if (updatedAt > (prev[sessionId] ?? 0)) {
          const next = { ...prev, [sessionId]: updatedAt };
          setLastSeenTimestamps(next);
          return next;
        }
        return prev;
      });
    },
    []
  );

  /**
   * Clean up stale entries (call periodically or when sessions are deleted)
   */
  const pruneStaleEntries = useCallback(
    (validSessionIds: Set<string>): void => {
      setLastSeenState(prev => {
        let changed = false;
        const next: Record<string, number> = {};
        for (const [sessionId, timestamp] of Object.entries(prev)) {
          if (validSessionIds.has(sessionId)) {
            next[sessionId] = timestamp;
          } else {
            changed = true;
          }
        }
        if (changed) {
          setLastSeenTimestamps(next);
          return next;
        }
        return prev;
      });
    },
    []
  );

  return {
    checkNeedsReview,
    markAsSeen,
    pruneStaleEntries,
    lastSeenTimestamps,
  };
}
