// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

/**
 * Issue #1325: server-backed message queue.
 *
 * Functional-style query layer for the queued_messages table. Wrapped by
 * QueuedMessageStore (matches the SessionStore/ErrorLogStore pattern).
 *
 * Idempotency: when clientGeneratedId is supplied, the partial unique index
 * idx_queued_msgs_session_client guarantees ON CONFLICT semantics. Callers
 * receive {result: "deduplicated", row} instead of a duplicate insert — this
 * is how the legacy sessionStorage migration path stays safe across retries.
 *
 * Ordering: position is a per-session monotonic integer assigned at enqueue.
 * popHeadQueuedMessage performs a transactional SELECT min(position) + DELETE
 * for atomicity against concurrent removeQueuedMessageAt calls.
 */

export interface StoredQueuedMessage {
  id: string;
  sessionId: string;
  namespace: string;
  body: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  clientGeneratedId: string | null;
}

interface QueuedMessageRow {
  id: string;
  session_id: string;
  namespace: string;
  body: string;
  position: number;
  created_at: number;
  updated_at: number;
  client_generated_id: string | null;
}

function rowToStored(row: QueuedMessageRow): StoredQueuedMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    namespace: row.namespace,
    body: row.body,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    clientGeneratedId: row.client_generated_id,
  };
}

export type EnqueueResult =
  | { result: "inserted"; row: StoredQueuedMessage }
  | { result: "deduplicated"; row: StoredQueuedMessage };

export function enqueueQueuedMessage(
  db: Database,
  args: {
    sessionId: string;
    namespace: string;
    body: string;
    clientGeneratedId?: string | null;
  }
): EnqueueResult {
  const txn = db.transaction((): EnqueueResult => {
    if (args.clientGeneratedId) {
      const existing = db
        .prepare(
          "SELECT * FROM queued_messages WHERE session_id = ? AND client_generated_id = ? LIMIT 1"
        )
        .get(args.sessionId, args.clientGeneratedId) as
        | QueuedMessageRow
        | undefined;
      if (existing) {
        return { result: "deduplicated", row: rowToStored(existing) };
      }
    }

    const nextPosRow = db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM queued_messages WHERE session_id = ?"
      )
      .get(args.sessionId) as { next: number } | undefined;
    const position = nextPosRow?.next ?? 0;

    const now = Date.now();
    const id = randomUUID();

    db.prepare(
      `INSERT INTO queued_messages (
        id, session_id, namespace, body, position, created_at, updated_at, client_generated_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      args.sessionId,
      args.namespace,
      args.body,
      position,
      now,
      now,
      args.clientGeneratedId ?? null
    );

    const row = db
      .prepare("SELECT * FROM queued_messages WHERE id = ?")
      .get(id) as QueuedMessageRow;
    return { result: "inserted", row: rowToStored(row) };
  });

  return txn();
}

export function listQueuedMessages(
  db: Database,
  sessionId: string,
  namespace: string
): StoredQueuedMessage[] {
  const rows = db
    .prepare(
      "SELECT * FROM queued_messages WHERE session_id = ? AND namespace = ? ORDER BY position ASC"
    )
    .all(sessionId, namespace) as QueuedMessageRow[];
  return rows.map(rowToStored);
}

export function popHeadQueuedMessage(
  db: Database,
  sessionId: string
): StoredQueuedMessage | null {
  const txn = db.transaction((): StoredQueuedMessage | null => {
    const row = db
      .prepare(
        "SELECT * FROM queued_messages WHERE session_id = ? ORDER BY position ASC LIMIT 1"
      )
      .get(sessionId) as QueuedMessageRow | undefined;
    if (!row) return null;
    db.prepare("DELETE FROM queued_messages WHERE id = ?").run(row.id);
    return rowToStored(row);
  });
  return txn();
}

export function updateQueuedMessageAt(
  db: Database,
  sessionId: string,
  namespace: string,
  position: number,
  body: string
): StoredQueuedMessage | null {
  const txn = db.transaction((): StoredQueuedMessage | null => {
    const now = Date.now();
    const result = db
      .prepare(
        `UPDATE queued_messages
         SET body = ?, updated_at = ?
         WHERE session_id = ? AND namespace = ? AND position = ?`
      )
      .run(body, now, sessionId, namespace, position);
    if (result.changes === 0) return null;
    const row = db
      .prepare(
        "SELECT * FROM queued_messages WHERE session_id = ? AND namespace = ? AND position = ?"
      )
      .get(sessionId, namespace, position) as QueuedMessageRow | undefined;
    return row ? rowToStored(row) : null;
  });
  return txn();
}

export function removeQueuedMessageAt(
  db: Database,
  sessionId: string,
  namespace: string,
  position: number
): boolean {
  const txn = db.transaction((): boolean => {
    const deleted = db
      .prepare(
        "DELETE FROM queued_messages WHERE session_id = ? AND namespace = ? AND position = ?"
      )
      .run(sessionId, namespace, position);
    if (deleted.changes === 0) return false;
    db.prepare(
      `UPDATE queued_messages
       SET position = position - 1
       WHERE session_id = ? AND namespace = ? AND position > ?`
    ).run(sessionId, namespace, position);
    return true;
  });
  return txn();
}

export function clearQueuedMessages(
  db: Database,
  sessionId: string,
  namespace: string
): number {
  const result = db
    .prepare(
      "DELETE FROM queued_messages WHERE session_id = ? AND namespace = ?"
    )
    .run(sessionId, namespace);
  return result.changes;
}

export function deleteQueuedMessagesForSession(
  db: Database,
  sessionId: string
): number {
  const result = db
    .prepare("DELETE FROM queued_messages WHERE session_id = ?")
    .run(sessionId);
  return result.changes;
}
