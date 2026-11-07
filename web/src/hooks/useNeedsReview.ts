// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "hapi:lastSeenTimestamp";

/**
 * How long a prune keeps the stamp of a session that is missing from the list
 * (#4536). A list render can be partial — on a federation hub the local sessions
 * arrive before the remote ones, and a peer can be briefly offline — so a missing
 * id alone does not prove the session is gone.
 */
export const LAST_SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

type LastSeen = Record<string, number>;

/**
 * Get all last-seen timestamps from localStorage
 */
function readStored(): LastSeen {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LastSeen)
      : {};
  } catch {
    return {};
  }
}

/**
 * Save last-seen timestamps to localStorage
 */
function writeStored(timestamps: LastSeen): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(timestamps));
  } catch {
    // Quota or disabled storage: the in-memory store still holds the value.
  }
}

/** Per-session maximum of two stamp maps. */
function mergeMax(a: LastSeen, b: LastSeen): LastSeen {
  const merged = { ...a };
  for (const [sessionId, timestamp] of Object.entries(b)) {
    if (typeof timestamp === "number" && timestamp > (merged[sessionId] ?? 0)) {
      merged[sessionId] = timestamp;
    }
  }
  return merged;
}

// Module-level store (#4536): every useNeedsReview() instance in the tab reads
// the same snapshot through useSyncExternalStore, so a mark made in one view (the
// session page, a split pane) re-renders the list rows and the toolbar counts in
// the same update. Per-instance state never resynced, because the `storage` event
// fires only in OTHER tabs.
let current: LastSeen = readStored();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): LastSeen {
  return current;
}

function publish(next: LastSeen): void {
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Re-read module state from localStorage and notify listeners. Tests call this
 * after `localStorage.clear()` so module state does not leak between cases.
 */
export function __resetNeedsReviewForTests(): void {
  publish(readStored());
}

// Cross-tab bridge: another tab's write (or clear, key === null) re-reads the
// store. Registered once per module instance (an HMR re-run of this module adds
// a fresh listener; the old one only re-reads storage, so it is harmless).
let storageBridgeRegistered = false;
function ensureStorageBridge(): void {
  if (storageBridgeRegistered || typeof window === "undefined") return;
  storageBridgeRegistered = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      publish(readStored());
    }
  });
}

ensureStorageBridge();

/**
 * Mark a session as "seen" (clears the needs review indicator)
 */
function markAsSeen(sessionId: string, updatedAt: number): void {
  // Re-read storage so a mark written by another tab is merged, never lost.
  const latest = mergeMax(current, readStored());
  // Only update if this is newer than what we've seen
  if (updatedAt <= (latest[sessionId] ?? 0)) return;
  const next = { ...latest, [sessionId]: updatedAt };
  writeStored(next);
  publish(next);
}

/**
 * Clean up stale entries (call when the session list changes). The prune reads
 * the store fresh instead of a snapshot taken at render time, and drops only an
 * entry that is BOTH absent from `validSessionIds` and older than
 * LAST_SEEN_RETENTION_MS, so a partial list cannot erase a live stamp (#4536).
 */
function pruneStaleEntries(validSessionIds: Set<string>): void {
  const latest = mergeMax(current, readStored());
  const cutoff = Date.now() - LAST_SEEN_RETENTION_MS;
  const next: LastSeen = {};
  let changed = false;
  for (const [sessionId, timestamp] of Object.entries(latest)) {
    if (validSessionIds.has(sessionId) || timestamp > cutoff) {
      next[sessionId] = timestamp;
    } else {
      changed = true;
    }
  }
  if (changed) {
    writeStored(next);
    publish(next);
  }
}

/**
 * Hook to track which sessions need user review.
 *
 * A session "needs review" when:
 * 1. It's active
 * 2. It's not thinking (Claude finished)
 * 3. Its updatedAt timestamp is newer than the user's last seen timestamp
 *
 * Uses localStorage for persistence and cross-tab synchronization, and one
 * module-level store so every instance in the tab stays in sync.
 */
export function useNeedsReview() {
  const lastSeenTimestamps = useSyncExternalStore(subscribe, getSnapshot);

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

  return {
    checkNeedsReview,
    markAsSeen,
    pruneStaleEntries,
    lastSeenTimestamps,
  };
}
