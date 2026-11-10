// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import type { StoredMessage } from "./types";
import {
  addMessage,
  getMessages,
  getMessagesAfter,
  getLatestMessagesForSessions,
  hasMessageWithLocalId,
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

  /**
   * Whether `sessionId` holds a message with this `localId`: the de-duplication
   * key `addMessage` already reads. It is the replay guard in `persistWithRecord`
   * (#6453), and lets a Submit tell where an earlier attempt was delivered (#6454).
   */
  hasLocalId(sessionId: string, localId: string): boolean {
    return hasMessageWithLocalId(this.db, sessionId, localId);
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

  /**
   * The id of the newest of a session's last `window` messages whose stored JSON
   * contains `needle` (#6455: the message that holds a tool call, by its id).
   * `instr`, so no row is parsed and nothing in the needle is a wildcard.
   */
  findRecentMessageIdContaining(
    sessionId: string,
    needle: string,
    window: number = 20
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM (
           SELECT id, seq, content FROM messages
           WHERE session_id = ? ORDER BY seq DESC LIMIT ?
         ) WHERE instr(content, ?) > 0 ORDER BY seq DESC LIMIT 1`
      )
      .get(sessionId, window, needle) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * A session's newest messages, newest first, created at or after `sinceMs`
   * (#6455: the turn a Detected pin is read from). A row longer than `maxChars` is
   * returned with `content: null` and never parsed, because one stored message
   * can be hundreds of kilobytes.
   */
  getRecentMessagesBounded(
    sessionId: string,
    options: { limit: number; sinceMs: number; maxChars: number }
  ): Array<{ id: string; createdAt: number; content: unknown }> {
    const rows = this.db
      .prepare(
        `SELECT id, created_at,
                CASE WHEN length(content) <= ? THEN content END AS content
         FROM messages WHERE session_id = ? AND created_at >= ?
         ORDER BY seq DESC LIMIT ?`
      )
      .all(
        options.maxChars,
        sessionId,
        options.sinceMs,
        options.limit
      ) as Array<{ id: string; created_at: number; content: string | null }>;
    return rows.map(row => {
      let content: unknown = null;
      if (row.content !== null) {
        try {
          content = JSON.parse(row.content);
        } catch {
          content = null;
        }
      }
      return { id: row.id, createdAt: row.created_at, content };
    });
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
