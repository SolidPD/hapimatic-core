// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import {
  clearQueuedMessages,
  deleteQueuedMessagesForSession,
  enqueueQueuedMessage,
  listQueuedMessages,
  popHeadQueuedMessage,
  removeQueuedMessageAt,
  updateQueuedMessageAt,
  type EnqueueResult,
  type StoredQueuedMessage,
} from "./queuedMessages";

/**
 * Issue #1325: server-backed message queue store.
 *
 * Class wrapper for the queue query functions in queuedMessages.ts. Matches
 * the SessionStore / ErrorLogStore pattern so it slots cleanly into Store.
 */
export class QueuedMessageStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  enqueue(args: {
    sessionId: string;
    namespace: string;
    body: string;
    clientGeneratedId?: string | null;
  }): EnqueueResult {
    return enqueueQueuedMessage(this.db, args);
  }

  list(sessionId: string, namespace: string): StoredQueuedMessage[] {
    return listQueuedMessages(this.db, sessionId, namespace);
  }

  popHead(sessionId: string): StoredQueuedMessage | null {
    return popHeadQueuedMessage(this.db, sessionId);
  }

  updateAt(
    sessionId: string,
    namespace: string,
    position: number,
    body: string
  ): StoredQueuedMessage | null {
    return updateQueuedMessageAt(this.db, sessionId, namespace, position, body);
  }

  removeAt(sessionId: string, namespace: string, position: number): boolean {
    return removeQueuedMessageAt(this.db, sessionId, namespace, position);
  }

  clear(sessionId: string, namespace: string): number {
    return clearQueuedMessages(this.db, sessionId, namespace);
  }

  deleteForSession(sessionId: string): number {
    return deleteQueuedMessagesForSession(this.db, sessionId);
  }
}
