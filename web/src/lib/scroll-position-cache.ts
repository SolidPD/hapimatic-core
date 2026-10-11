// SPDX-License-Identifier: AGPL-3.0-only
/**
 * In-memory scroll position cache for chat threads.
 *
 * Stores the scrollTop of each session's chat viewport so it can be
 * restored when the user navigates back. Survives React component
 * unmounts but not page reloads (intentional — per issue #833).
 */

const cache = new Map<string, number>();

export function saveScrollPosition(sessionId: string, scrollTop: number): void {
  if (scrollTop > 0) {
    cache.set(sessionId, scrollTop);
  } else {
    cache.delete(sessionId);
  }
}

export function getScrollPosition(sessionId: string): number | null {
  return cache.get(sessionId) ?? null;
}

export function clearScrollPosition(sessionId: string): void {
  cache.delete(sessionId);
}
