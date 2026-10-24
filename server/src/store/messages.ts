// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { scrubSecretTokens } from "@hapi/protocol";

import type { StoredMessage } from "./types";
import { safeJsonParse } from "./json";
import { isOperatorUserMessage } from "../sync/sentFrom";

type DbMessageRow = {
  id: string;
  session_id: string;
  content: string;
  created_at: number;
  seq: number;
  local_id: string | null;
};

function toStoredMessage(row: DbMessageRow): StoredMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    content: safeJsonParse(row.content),
    createdAt: row.created_at,
    seq: row.seq,
    localId: row.local_id,
  };
}

/**
 * Extract the top-level `role` string from a message's content, if any.
 * Used to detect user-role messages for the sessions.user_message_count counter (#1032).
 */
function extractRole(content: unknown): string | null {
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const role = (content as { role?: unknown }).role;
    return typeof role === "string" ? role : null;
  }
  return null;
}

export function addMessage(
  db: Database,
  sessionId: string,
  content: unknown,
  localId?: string,
  generatedAt?: number
): StoredMessage {
  const now = Date.now();
  // Use generatedAt as created_at if valid (not in the future, positive)
  const createdAt =
    generatedAt && generatedAt > 0 && generatedAt <= now ? generatedAt : now;

  const id = randomUUID();
  // #1587 + B4 #1957: mask secret tokens before persisting transcript content
  // to hapi.db. scrubSecretTokens covers Anthropic tokens (sk-ant-oat01-… OAuth
  // tokens, API keys, refresh tokens — #1587) AND non-Anthropic provider keys
  // (OpenAI/OpenRouter sk-…, Gemini AIza… — B4 defense-in-depth for an
  // accidental key paste; the conversational flow's primary control is never
  // putting the secret in the conversation). Scrubbing the serialized JSON
  // (vs. a recursive object walk) has no nesting depth limit and is a single
  // pass; the [REDACTED] marker is JSON-safe, so the row re-read below
  // (toStoredMessage → safeJsonParse) returns the masked content, propagating
  // redaction to the SSE broadcast and CLI-peer relay.
  // #3631: computed BEFORE the transaction — under BEGIN IMMEDIATE the write
  // lock is held from the first statement, so this pure (and for a large
  // payload, non-trivial) serialize + regex pass must not run inside the lock.
  const json = scrubSecretTokens(JSON.stringify(content));

  // Wrap the insert + counter bump in a single synchronous transaction so
  // the sessions.user_message_count stays in lockstep with the messages
  // table even if any sub-statement fails (#1032).
  const txn = db.transaction((): StoredMessage => {
    if (localId) {
      const existing = db
        .prepare(
          "SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1"
        )
        .get(sessionId, localId) as DbMessageRow | undefined;
      if (existing) {
        return toStoredMessage(existing);
      }
    }

    // Determine seq based on whether this is a late-arriving message (Issue #952)
    // If generatedAt is provided and older than the latest message, insert in
    // chronological order by bumping later seq values.
    let msgSeq: number;
    const isLateArrival = generatedAt && generatedAt > 0 && generatedAt < now;

    if (isLateArrival) {
      const insertionPoint = db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) AS insertAfterSeq FROM messages WHERE session_id = ? AND created_at <= ?"
        )
        .get(sessionId, createdAt) as { insertAfterSeq: number };

      const laterCount = db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE session_id = ? AND seq > ?"
        )
        .get(sessionId, insertionPoint.insertAfterSeq) as { count: number };

      if (laterCount.count > 0) {
        // Bump later seq values to make room for chronological insertion
        db.prepare(
          "UPDATE messages SET seq = seq + 1 WHERE session_id = ? AND seq > ?"
        ).run(sessionId, insertionPoint.insertAfterSeq);
        msgSeq = insertionPoint.insertAfterSeq + 1;
      } else {
        // No later messages — append normally
        const row = db
          .prepare(
            "SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?"
          )
          .get(sessionId) as { nextSeq: number };
        msgSeq = row.nextSeq;
      }
    } else {
      // Normal path: append at end
      const row = db
        .prepare(
          "SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?"
        )
        .get(sessionId) as { nextSeq: number };
      msgSeq = row.nextSeq;
    }

    db.prepare(
      `
          INSERT INTO messages (
              id, session_id, content, created_at, seq, local_id
          ) VALUES (
              @id, @session_id, @content, @created_at, @seq, @local_id
          )
      `
    ).run({
      id,
      session_id: sessionId,
      content: json,
      created_at: createdAt,
      seq: msgSeq,
      local_id: localId ?? null,
    });

    // Denormalized user-message counter (#1032). Only bump for role='user'
    // messages so the column matches what /api/sessions wants to report.
    if (extractRole(content) === "user") {
      db.prepare(
        "UPDATE sessions SET user_message_count = user_message_count + 1 WHERE id = ?"
      ).run(sessionId);
    }

    // Denormalized last-operator-message timestamp (#5254 R2): the ceiling
    // guard's inactivity gate. MAX keeps a late arrival (an older createdAt,
    // #952) from moving it backwards.
    // Fail-open: if the column migration ever failed, a missing column throws
    // at prepare (before any write) and must not stop the message itself from
    // being saved. (The guard's own read of the column then throws too and the
    // guard degrades through its fail-open catch, so nothing is stopped.)
    if (isOperatorUserMessage(content)) {
      try {
        db.prepare(
          "UPDATE sessions SET last_operator_message_at = MAX(IFNULL(last_operator_message_at, 0), ?) WHERE id = ?"
        ).run(createdAt, sessionId);
      } catch (error) {
        console.error(
          "[Store] could not update sessions.last_operator_message_at (#5254):",
          error
        );
      }
    }

    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as
      | DbMessageRow
      | undefined;
    if (!row) {
      throw new Error("Failed to create message");
    }
    return toStoredMessage(row);
  });

  // #3631: BEGIN IMMEDIATE. The body above is a read-then-write transaction
  // (the local_id dedup read and the MAX(seq) read, then the INSERT). Under the
  // default deferred BEGIN it opens a READ transaction first, and once a read
  // transaction is open SQLite no longer consults the busy handler when the
  // upgrade to writer finds another connection holding (or having committed) a
  // write: it returns SQLITE_BUSY immediately, so the connection-wide
  // busy_timeout (store/index.ts) never applied on this path. Taking the write
  // lock up front makes contention WAIT (up to busy_timeout, 5 s) and then read
  // the committed state, so seq is allocated after the other writer's commit.
  // First .immediate() use in the repo. Measured 2026-09-13 (RP1, 9 writer
  // processes x 200 back-to-back writes): deferred threw SQLITE_BUSY on
  // 1181/1800 writes; immediate persisted 1800/1800 with 0 throws, successful-
  // write p99 34 ms, worst single blocking hold 738 ms (ceiling: busy_timeout).
  return txn.immediate();
}

export function getMessages(
  db: Database,
  sessionId: string,
  limit: number = 200,
  beforeSeq?: number
): StoredMessage[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, limit))
    : 200;

  const rows =
    beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(beforeSeq)
      ? (db
          .prepare(
            "SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?"
          )
          .all(sessionId, beforeSeq, safeLimit) as DbMessageRow[])
      : (db
          .prepare(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?"
          )
          .all(sessionId, safeLimit) as DbMessageRow[]);

  return rows.reverse().map(toStoredMessage);
}

export function getMessagesAfter(
  db: Database,
  sessionId: string,
  afterSeq: number,
  limit: number = 200
): StoredMessage[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, limit))
    : 200;
  const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0;

  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?"
    )
    .all(sessionId, safeAfterSeq, safeLimit) as DbMessageRow[];

  return rows.map(toStoredMessage);
}

const CHUNK_SIZE = 900;

export function getLatestMessagesForSessions(
  db: Database,
  sessionIds: string[],
  limit: number = 200
): Map<string, StoredMessage[]> {
  const result = new Map<string, StoredMessage[]>();
  if (sessionIds.length === 0) return result;

  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(200, limit))
    : 200;

  for (let i = 0; i < sessionIds.length; i += CHUNK_SIZE) {
    const chunk = sessionIds.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");

    const rows = db
      .prepare(
        `SELECT * FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY seq DESC) AS rn
          FROM messages
          WHERE session_id IN (${placeholders})
        ) WHERE rn <= ?`
      )
      .all(...chunk, safeLimit) as (DbMessageRow & { rn: number })[];

    for (const row of rows) {
      let arr = result.get(row.session_id);
      if (!arr) {
        arr = [];
        result.set(row.session_id, arr);
      }
      arr.push(toStoredMessage(row));
    }
  }

  // Sort each session's messages ascending by seq (they come back in arbitrary order from the window query)
  for (const [, messages] of result) {
    messages.sort((a, b) => a.seq - b.seq);
  }

  return result;
}
