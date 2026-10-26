// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers for the notification inbox on Settings → Notifications (issue
// #4916, epic #4912 Sub D): the list order, the context payload as key/value
// pairs, the page size, and how a row's session resolves. React-free so the
// rules are tested without rendering.
import { NOTIFICATION_LIST_MAX_LIMIT } from "@hapi/protocol";
import type { SessionSummary, StoredNotification } from "@/types/api";

/**
 * The inbox asks for the largest page the server returns, in one query. A
 * paged (infinite) query would break the live cache: `applyNotificationToCache`
 * reads `data.notifications` on every list under the `["notifications","list"]`
 * key prefix.
 */
export const INBOX_PAGE_LIMIT = NOTIFICATION_LIST_MAX_LIMIT;

/** True when the server may hold more rows than the page shows. */
export function isInboxCapped(count: number): boolean {
  return count >= INBOX_PAGE_LIMIT;
}

/** Newest `lastAt` first, then id descending — the server's own order. */
function newestFirst(a: StoredNotification, b: StoredNotification): number {
  if (a.lastAt !== b.lastAt) return b.lastAt - a.lastAt;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Every unread row before every read row, each group newest first. A row in
 * `held` (opened during this visit) keeps its unread-group position even after
 * it is read, so a row never moves under the user's finger while it is open.
 * Returns a new array; the input is not changed.
 */
export function orderInbox(
  rows: readonly StoredNotification[],
  held: ReadonlySet<string>
): StoredNotification[] {
  const unread: StoredNotification[] = [];
  const read: StoredNotification[] = [];
  for (const row of rows) {
    if (row.readAt == null || held.has(row.id)) unread.push(row);
    else read.push(row);
  }
  return [...unread.sort(newestFirst), ...read.sort(newestFirst)];
}

export type ContextEntry = {
  key: string;
  value: string;
  /** `true` when the value is JSON (or raw text) that renders in a code block. */
  structured: boolean;
};

/**
 * A row's `context` (a JSON string) as key/value pairs. Every value is a
 * string, because a plain object is not a valid React child. A non-object JSON
 * value, or text that does not parse (a row written by an older peer binary can
 * hold cut JSON), becomes one "Context" entry with the raw text.
 */
export function contextEntries(context: string | null): ContextEntry[] | null {
  if (context == null || context.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(context);
  } catch {
    return [{ key: "Context", value: context, structured: true }];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{ key: "Context", value: context, structured: true }];
  }
  return Object.entries(parsed as Record<string, unknown>).map(
    ([key, value]) => {
      if (typeof value === "string") return { key, value, structured: false };
      if (value === null || typeof value !== "object") {
        return { key, value: String(value), structured: false };
      }
      return { key, value: JSON.stringify(value, null, 2), structured: true };
    }
  );
}

/** First-seen / last-seen timestamps in the detail view. */
export function formatNotificationTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export type NotificationSessionState =
  | { state: "none" }
  | { state: "found"; session: SessionSummary }
  | { state: "pending" }
  | { state: "unknown" }
  | { state: "missing" };

/**
 * How a row's session resolves against the merged local + federation session
 * list. Both session queries return an empty list while loading and on error,
 * so "missing" is claimed only once both have answered without an error.
 */
export function resolveNotificationSession(
  sessionId: string | null,
  sessions: readonly SessionSummary[],
  lookup: { settled: boolean; failed: boolean }
): NotificationSessionState {
  if (!sessionId) return { state: "none" };
  const session = sessions.find(s => s.id === sessionId);
  if (session) return { state: "found", session };
  if (!lookup.settled) return { state: "pending" };
  if (lookup.failed) return { state: "unknown" };
  return { state: "missing" };
}
