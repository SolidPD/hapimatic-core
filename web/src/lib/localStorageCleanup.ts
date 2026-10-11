// SPDX-License-Identifier: AGPL-3.0-only
/**
 * localStorage cleanup utilities for TTL expiration, orphan pruning, and LRU eviction.
 *
 * Hapimatic stores per-session and per-project data in localStorage that grows unbounded
 * as sessions are deleted and projects change. This module provides cleanup functions to
 * prevent quota exhaustion and performance degradation.
 *
 * @see https://github.com/MattStarfield/hapimatic-private/issues/237
 */

import { pruneBranchCache } from "@/hooks/useBranchCache";
import { prunePromptDrafts } from "@/hooks/usePromptDraft";
import {
  pruneMutedSessions,
  syncPreferencesToCache,
} from "@/lib/notificationPreferences";
import { pruneSessionOrder } from "@/lib/sessionListManualOrder";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_ENTRIES = 500;

interface TimestampedEntry {
  lastAccessed: number;
  [key: string]: unknown;
}

/**
 * Remove entries older than maxAge from a localStorage object that uses
 * `{ lastAccessed: number }` entries.
 */
export function cleanupStaleEntries(
  key: string,
  maxAgeMs: number = DEFAULT_TTL_MS
): number {
  const raw = localStorage.getItem(key);
  if (!raw) return 0;

  try {
    const data = JSON.parse(raw) as Record<string, TimestampedEntry>;
    const cutoff = Date.now() - maxAgeMs;
    let removedCount = 0;

    const cleaned: Record<string, TimestampedEntry> = {};
    for (const [id, entry] of Object.entries(data)) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "lastAccessed" in entry &&
        entry.lastAccessed > cutoff
      ) {
        cleaned[id] = entry;
      } else {
        removedCount++;
      }
    }

    if (removedCount > 0) {
      localStorage.setItem(key, JSON.stringify(cleaned));
      console.debug(
        `[localStorage] Cleaned ${removedCount} stale entries from ${key}`
      );
    }

    return removedCount;
  } catch {
    return 0;
  }
}

/**
 * Prune all session-scoped localStorage keys against a set of valid session IDs.
 * Centralizes orphan cleanup so callers only need a single function call.
 */
export function pruneOrphanedSessions(validIds: Set<string>): void {
  // Branch cache and prompt drafts have existing prune functions
  pruneBranchCache(validIds);
  prunePromptDrafts(validIds);

  // Expanded sessions stored as string[] — filter in-place
  pruneExpandedSessions(validIds);

  // Issue #466: prune the manual reorder store's per-group root-session order
  // (root ids are a subset of session ids; drop entries for deleted sessions).
  pruneSessionOrder(validIds);

  // Issue #87: muted sessions stored as string[] — drop ids for deleted
  // sessions and, when the set changed, re-sync the SW preferences cache so the
  // service worker sees the pruned set (it never reads localStorage).
  if (pruneMutedSessions(validIds)) {
    void syncPreferencesToCache();
  }
}

/**
 * Prune `hapi:expandedSessions` (stored as string[]) against valid session IDs.
 */
function pruneExpandedSessions(validIds: Set<string>): void {
  const key = "hapi:expandedSessions";
  const raw = localStorage.getItem(key);
  if (!raw) return;

  try {
    const ids = JSON.parse(raw) as string[];
    const filtered = ids.filter(id => validIds.has(id));
    if (filtered.length !== ids.length) {
      localStorage.setItem(key, JSON.stringify(filtered));
      console.debug(
        `[localStorage] Pruned ${ids.length - filtered.length} orphaned entries from ${key}`
      );
    }
  } catch {
    // Ignore parse errors
  }
}

/**
 * Apply LRU eviction if entry count exceeds threshold.
 * Keeps the most recently accessed entries based on `lastAccessed` timestamp.
 */
export function enforceLRULimit(
  key: string,
  maxEntries: number = MAX_ENTRIES
): number {
  const raw = localStorage.getItem(key);
  if (!raw) return 0;

  try {
    const data = JSON.parse(raw) as Record<string, TimestampedEntry>;
    const entries = Object.entries(data);

    if (entries.length <= maxEntries) return 0;

    // Sort by lastAccessed ascending (oldest first), then keep most recent
    entries.sort((a, b) => (a[1].lastAccessed || 0) - (b[1].lastAccessed || 0));
    const toKeep = entries.slice(-maxEntries);
    const cleaned = Object.fromEntries(toKeep);
    const evicted = entries.length - maxEntries;

    localStorage.setItem(key, JSON.stringify(cleaned));
    console.debug(`[localStorage] Evicted ${evicted} LRU entries from ${key}`);

    return evicted;
  } catch {
    return 0;
  }
}

/**
 * Handle QuotaExceededError with aggressive cleanup.
 * Uses a shorter TTL (7 days) and clears ephemeral data like prompt drafts.
 */
export function handleQuotaExceeded(): void {
  console.warn("[localStorage] Quota exceeded, running aggressive cleanup");
  const aggressiveTtl = 7 * 24 * 60 * 60 * 1000; // 7 days

  cleanupStaleEntries("hapi:projectExpandState", aggressiveTtl);

  // Clear all prompt drafts (ephemeral data)
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("hapi:promptDraft:")) {
      localStorage.removeItem(key);
    }
  }
}

/**
 * Safe localStorage write wrapper that catches QuotaExceededError
 * and triggers aggressive cleanup before retrying once.
 */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === "QuotaExceededError") {
      handleQuotaExceeded();
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Run all TTL-based cleanup tasks. Called on app mount and visibility change.
 */
export function runScheduledCleanup(): void {
  cleanupStaleEntries("hapi:projectExpandState", DEFAULT_TTL_MS);
  enforceLRULimit("hapi:projectExpandState", MAX_ENTRIES);
}
