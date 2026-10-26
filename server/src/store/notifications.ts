// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import {
  COALESCE_WINDOW_MS,
  NOTIFICATION_SEVERITIES,
  NOTIFICATION_TTL_MS,
  type NotificationKind,
  type NotificationSeverity,
  type StoredNotification,
} from "@hapi/protocol";

// Query functions for the `notifications` table (issue #4913, epic #4912). The
// table is created in `store/index.ts`; `NotificationStore` wraps these. Every
// function takes `now` so tests control time; reads never return a row past the
// 48-hour TTL, so the TTL holds between purge ticks.

type DbNotificationRow = {
  id: string;
  namespace: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  session_id: string | null;
  session_title: string | null;
  context: string | null;
  dedupe_key: string | null;
  count: number;
  first_at: number;
  last_at: number;
  read_at: number | null;
  dismissed_at: number | null;
};

function toStoredNotification(row: DbNotificationRow): StoredNotification {
  return {
    id: row.id,
    namespace: row.namespace,
    kind: row.kind as NotificationKind,
    severity: row.severity as NotificationSeverity,
    title: row.title,
    body: row.body,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    context: row.context,
    dedupeKey: row.dedupe_key,
    count: row.count,
    firstAt: row.first_at,
    lastAt: row.last_at,
    readAt: row.read_at,
    dismissedAt: row.dismissed_at,
  };
}

/** The fields a caller supplies for a new (or coalesced) notification. */
export type NewNotificationRow = {
  namespace: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  sessionId: string | null;
  sessionTitle: string | null;
  context: string | null;
  dedupeKey: string | null;
};

export type NotificationListOptions = {
  unreadOnly?: boolean;
  limit: number;
  offset: number;
};

export type CreateOrCoalesceResult = {
  notification: StoredNotification;
  coalesced: boolean;
};

/** The higher of two severities (info < warn < error). */
function maxSeverity(
  a: NotificationSeverity,
  b: NotificationSeverity
): NotificationSeverity {
  return NOTIFICATION_SEVERITIES.indexOf(a) >=
    NOTIFICATION_SEVERITIES.indexOf(b)
    ? a
    : b;
}

/**
 * Insert a notification, or coalesce it into the open row with the same
 * namespace, kind and dedupe key. "Open" = neither read nor dismissed, and
 * `last_at` within `COALESCE_WINDOW_MS` of `now` (a sliding window). A coalesce
 * increments `count`, moves `last_at` and raises `severity` to the higher of the
 * stored and incoming values (#4914, sink #5648 S-2); title, body and context stay
 * the first occurrence's. It never changes the unread count. Matching on `kind`
 * keeps a producer `dedupeKey` from merging two kinds into one row (sink #5648 S-3).
 *
 * The SELECT-then-write runs as `BEGIN IMMEDIATE` (#3631): a deferred read
 * transaction that later upgrades to a writer gets SQLITE_BUSY with no wait when
 * another connection has written, so the write lock is taken up front.
 */
export function createOrCoalesce(
  db: Database,
  row: NewNotificationRow,
  now: number = Date.now()
): CreateOrCoalesceResult {
  const txn = db.transaction((): CreateOrCoalesceResult => {
    if (row.dedupeKey !== null) {
      const open = db
        .prepare(
          `SELECT * FROM notifications
           WHERE namespace = ? AND kind = ? AND dedupe_key = ? AND last_at >= ?
             AND read_at IS NULL AND dismissed_at IS NULL
           ORDER BY last_at DESC LIMIT 1`
        )
        .get(
          row.namespace,
          row.kind,
          row.dedupeKey,
          now - COALESCE_WINDOW_MS
        ) as DbNotificationRow | null;
      if (open) {
        const severity = maxSeverity(
          open.severity as NotificationSeverity,
          row.severity
        );
        db.prepare(
          "UPDATE notifications SET count = count + 1, last_at = ?, severity = ? WHERE id = ?"
        ).run(now, severity, open.id);
        return {
          notification: toStoredNotification({
            ...open,
            severity,
            count: open.count + 1,
            last_at: now,
          }),
          coalesced: true,
        };
      }
    }

    const id = randomUUID();
    db.prepare(
      `INSERT INTO notifications (
         id, namespace, kind, severity, title, body, session_id, session_title,
         context, dedupe_key, count, first_at, last_at, read_at, dismissed_at
       ) VALUES (
         @id, @namespace, @kind, @severity, @title, @body, @session_id,
         @session_title, @context, @dedupe_key, 1, @now, @now, NULL, NULL
       )`
    ).run({
      id,
      namespace: row.namespace,
      kind: row.kind,
      severity: row.severity,
      title: row.title,
      body: row.body,
      session_id: row.sessionId,
      session_title: row.sessionTitle,
      context: row.context,
      dedupe_key: row.dedupeKey,
      now,
    });
    return {
      notification: {
        id,
        namespace: row.namespace,
        kind: row.kind,
        severity: row.severity,
        title: row.title,
        body: row.body,
        sessionId: row.sessionId,
        sessionTitle: row.sessionTitle,
        context: row.context,
        dedupeKey: row.dedupeKey,
        count: 1,
        firstAt: now,
        lastAt: now,
        readAt: null,
        dismissedAt: null,
      },
      coalesced: false,
    };
  });
  return txn.immediate();
}

/** Undismissed rows in the namespace, newest `last_at` first, within the TTL. */
export function list(
  db: Database,
  namespace: string,
  options: NotificationListOptions,
  now: number = Date.now()
): StoredNotification[] {
  let query = `SELECT * FROM notifications
    WHERE namespace = ? AND last_at >= ? AND dismissed_at IS NULL`;
  if (options.unreadOnly) {
    query += " AND read_at IS NULL";
  }
  query += " ORDER BY last_at DESC, id DESC LIMIT ? OFFSET ?";
  const rows = db
    .prepare(query)
    .all(
      namespace,
      now - NOTIFICATION_TTL_MS,
      options.limit,
      options.offset
    ) as DbNotificationRow[];
  return rows.map(toStoredNotification);
}

/** Rows that are neither read nor dismissed, within the TTL. */
export function countUnread(
  db: Database,
  namespace: string,
  now: number = Date.now()
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM notifications
       WHERE namespace = ? AND last_at >= ?
         AND read_at IS NULL AND dismissed_at IS NULL`
    )
    .get(namespace, now - NOTIFICATION_TTL_MS) as { count: number } | null;
  return row?.count ?? 0;
}

export function getById(
  db: Database,
  namespace: string,
  id: string
): StoredNotification | null {
  const row = db
    .prepare("SELECT * FROM notifications WHERE id = ? AND namespace = ?")
    .get(id, namespace) as DbNotificationRow | null;
  return row ? toStoredNotification(row) : null;
}

/** Mark read; idempotent. `null` when no row with this id is in the namespace. */
export function markRead(
  db: Database,
  namespace: string,
  id: string,
  now: number = Date.now()
): StoredNotification | null {
  const result = db
    .prepare(
      "UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND namespace = ?"
    )
    .run(now, id, namespace);
  return result.changes > 0 ? getById(db, namespace, id) : null;
}

/** Dismiss; idempotent. `null` when no row with this id is in the namespace. */
export function dismiss(
  db: Database,
  namespace: string,
  id: string,
  now: number = Date.now()
): StoredNotification | null {
  const result = db
    .prepare(
      "UPDATE notifications SET dismissed_at = COALESCE(dismissed_at, ?) WHERE id = ? AND namespace = ?"
    )
    .run(now, id, namespace);
  return result.changes > 0 ? getById(db, namespace, id) : null;
}

/**
 * Dismiss every undismissed row in the namespace that is still within the TTL
 * (the rows the inbox shows); returns how many changed. Expired rows are left
 * to the purge, so the count matches what the user could see.
 */
export function dismissAll(
  db: Database,
  namespace: string,
  now: number = Date.now()
): number {
  return db
    .prepare(
      `UPDATE notifications SET dismissed_at = ?
       WHERE namespace = ? AND dismissed_at IS NULL AND last_at >= ?`
    )
    .run(now, namespace, now - NOTIFICATION_TTL_MS).changes;
}

/** Delete rows whose `last_at` is before `cutoffMs`, regardless of read state. */
export function deleteOlderThan(db: Database, cutoffMs: number): number {
  return db.prepare("DELETE FROM notifications WHERE last_at < ?").run(cutoffMs)
    .changes;
}
