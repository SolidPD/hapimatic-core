// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session Action Pending Store
 *
 * Tracks in-progress, non-blocking session actions (archive, reconnect, switch
 * account) so their spinner renders consistently across DISTINCT component
 * instances and survives navigation. `SessionHeader` and each `SessionList`
 * card instantiate their OWN `useSessionActions` hook — so a mutation's
 * per-instance `isPending` does NOT cross views. This module-level store is the
 * shared source of truth that both read, so an action started in the header
 * keeps spinning on the list card after the header unmounts (issue #1902).
 *
 * Pattern mirrors pending-spawns.ts: module-level Map + useSyncExternalStore
 * subscribe/getSnapshot, with a per-entry safety TTL (generalizes the 90s
 * reconnect timeout in SessionHeader) so a silently-failed op can't spin forever.
 *
 * Lifecycle (per entry):
 *   1. markActionPending  — mutation onMutate/start
 *   2a. clearActionPending — mutation onSettled (primary clear)
 *   2b. reconcileActionPending — poll-data driven clear (archive done = inactive,
 *       reconnect done = active); covers the cross-view case where the initiating
 *       hook instance unmounted before onSettled ran
 *   2c. TTL auto-expire (90s) — final backstop for a silently-failed op
 *
 * Delete IS tracked here (issue #3516) — NOT for a spinner (it still uses
 * optimistic row removal, so the row leaves immediately and no persistent
 * spinner is needed) but for the ROUTE GUARD: `sessionRoute`'s `beforeLoad`
 * reads `isActionPending(id, "delete")` to redirect a stale link away from a
 * session whose rows are optimistically gone. Cleared by the mutation's
 * `onSettled` (+ the 90s TTL backstop), exactly like `switch`.
 */

export type SessionAction = "archive" | "reconnect" | "switch" | "delete";

export type PendingActionEntry = {
  /** Stable key: `${sessionId}:${action}`. */
  key: string;
  sessionId: string;
  action: SessionAction;
  startedAt: number;
};

// ── Module-level store ──────────────────────────────────────────────

const pending = new Map<string, PendingActionEntry>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

/**
 * Safety TTL: clear a pending entry after 90s if neither the mutation nor the
 * poll-reconcile cleared it. Generalizes SessionHeader's existing 90s reconnect
 * timeout so a silently-failed background op does not spin forever.
 */
const ACTION_TTL_MS = 90_000;

let snapshot: PendingActionEntry[] = [];

function key(sessionId: string, action: SessionAction): string {
  return `${sessionId}:${action}`;
}

function updateSnapshot(): void {
  snapshot = Array.from(pending.values());
  for (const fn of listeners) fn();
}

function clearTimer(k: string): void {
  const t = timers.get(k);
  if (t) {
    clearTimeout(t);
    timers.delete(k);
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Mark a session action as in progress. Idempotent — re-marking refreshes the
 * TTL timer and updates startedAt. Notifies subscribers.
 */
export function markActionPending(
  sessionId: string,
  action: SessionAction
): void {
  const k = key(sessionId, action);
  pending.set(k, { key: k, sessionId, action, startedAt: Date.now() });

  // Reset the TTL backstop.
  clearTimer(k);
  timers.set(
    k,
    setTimeout(() => {
      pending.delete(k);
      timers.delete(k);
      updateSnapshot();
    }, ACTION_TTL_MS)
  );

  updateSnapshot();
}

/**
 * Clear a pending action (mutation onSettled / error rollback). No-op if absent.
 */
export function clearActionPending(
  sessionId: string,
  action: SessionAction
): void {
  const k = key(sessionId, action);
  if (!pending.has(k)) {
    // Still clear any orphan timer defensively.
    clearTimer(k);
    return;
  }
  pending.delete(k);
  clearTimer(k);
  updateSnapshot();
}

/**
 * Reconcile pending entries against fresh session poll data. Clears entries
 * whose underlying op has demonstrably completed:
 *   - `archive`   → cleared when the session is no longer active
 *   - `reconnect` → cleared when the session is active again
 * `switch` is left to clearActionPending (mutation onSettled) + the TTL, because
 * a per-session "switch done" signal is not derivable from session.active alone.
 *
 * Call this wherever fresh session/federation poll data lands (alongside the
 * existing reconcilePendingSpawns call in SessionList).
 */
export function reconcileActionPending(
  sessions: Array<{ id: string; active?: boolean }>
): void {
  if (pending.size === 0) return;

  // Index latest active-state by session id.
  const activeById = new Map<string, boolean | undefined>();
  for (const s of sessions) activeById.set(s.id, s.active);

  let changed = false;
  for (const [k, entry] of pending) {
    if (!activeById.has(entry.sessionId)) continue; // session not in this poll set
    const active = activeById.get(entry.sessionId);
    const done =
      (entry.action === "archive" && active === false) ||
      (entry.action === "reconnect" && active === true);
    if (done) {
      pending.delete(k);
      clearTimer(k);
      changed = true;
    }
  }

  if (changed) updateSnapshot();
}

/** True if the given (sessionId, action) is currently pending. */
export function isActionPending(
  sessionId: string,
  action: SessionAction
): boolean {
  return pending.has(key(sessionId, action));
}

/**
 * Drop every row whose delete is in flight (#3516 follow-up). The delete
 * wrappers remove a row from the list caches optimistically, but the server
 * keeps the row until its tmux + worktree cleanup RPCs finish, and any
 * `session-updated` SSE in that window invalidates the list queries — so an
 * unfiltered refetch would put the row straight back. Both list queryFns run
 * their fresh server data through this so the optimistic removal survives every
 * refetch until the mark clears (onSettled / the 90s TTL). Returns the SAME
 * array when nothing is pending, so a no-op keeps the reference stable.
 */
export function withoutDeletePending<T extends { id: string }>(
  sessions: T[]
): T[] {
  if (pending.size === 0) return sessions;
  let hasPending = false;
  for (const entry of pending.values()) {
    if (entry.action === "delete") {
      hasPending = true;
      break;
    }
  }
  if (!hasPending) return sessions;
  const out = sessions.filter(s => !pending.has(key(s.id, "delete")));
  return out.length === sessions.length ? sessions : out;
}

/** The set of pending actions for one session (empty set if none). */
export function getActionsForSession(sessionId: string): Set<SessionAction> {
  const result = new Set<SessionAction>();
  for (const entry of pending.values()) {
    if (entry.sessionId === sessionId) result.add(entry.action);
  }
  return result;
}

// ── useSyncExternalStore interface ──────────────────────────────────

export function subscribeActionPending(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function getActionPendingSnapshot(): PendingActionEntry[] {
  return snapshot;
}

/** Test-only: reset all state (store, timers, listeners). */
export function __resetSessionActionPendingForTests(): void {
  for (const t of timers.values()) clearTimeout(t);
  pending.clear();
  timers.clear();
  listeners.clear();
  snapshot = [];
}
