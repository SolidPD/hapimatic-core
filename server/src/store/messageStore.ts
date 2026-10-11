// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type { StoredMessage } from "./types";
import {
  addMessage,
  getMessages,
  getMessagesAfter,
  getLatestMessagesForSessions,
} from "./messages";

export class MessageStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  addMessage(
    sessionId: string,
    content: unknown,
    localId?: string,
    generatedAt?: number
  ): StoredMessage {
    return addMessage(this.db, sessionId, content, localId, generatedAt);
  }

  getMessages(
    sessionId: string,
    limit: number = 200,
    beforeSeq?: number
  ): StoredMessage[] {
    return getMessages(this.db, sessionId, limit, beforeSeq);
  }

  getMessagesAfter(
    sessionId: string,
    afterSeq: number,
    limit: number = 200
  ): StoredMessage[] {
    return getMessagesAfter(this.db, sessionId, afterSeq, limit);
  }

  getLatestMessagesForSessions(
    sessionIds: string[],
    limit: number = 200
  ): Map<string, StoredMessage[]> {
    return getLatestMessagesForSessions(this.db, sessionIds, limit);
  }

  /** Get the highest message seq for a session, or 0 if no messages exist */
  getMaxSeq(sessionId: string): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?"
      )
      .get(sessionId) as { maxSeq: number } | undefined;
    return row?.maxSeq ?? 0;
  }
}
