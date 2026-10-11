// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session-notes SQL queries (issue #1284).
 *
 * Pure query functions operating on the extension's single table. Each receives
 * a `Database` instance — no side effects beyond SQL.
 *
 * The table name comes from `../tableNames` and is interpolated into every
 * statement rather than written inline, so the migration and the query layer
 * cannot drift apart (the #1274 lesson). It is a module constant, never user
 * input. Every VALUE is bound as a parameter.
 *
 * Pattern: follows `server/src/extensions/scheduler/store/schedulerQueries.ts`.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import { SESSION_NOTES_TABLE } from "../tableNames";
import type { SessionNote, SessionNoteRow } from "../types";

const toNote = (row: SessionNoteRow): SessionNote => ({
  id: row.id,
  sessionId: row.session_id,
  content: row.content,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * All notes for one session, oldest first. The `(session_id, created_at)` index
 * serves both the filter and the ordering, so this never sorts at runtime.
 */
export function listNotes(db: Database, sessionId: string): SessionNote[] {
  const rows = db
    .prepare(
      `SELECT id, session_id, content, created_at, updated_at
         FROM ${SESSION_NOTES_TABLE}
        WHERE session_id = ?
        ORDER BY created_at ASC, id ASC`
    )
    .all(sessionId) as SessionNoteRow[];
  return rows.map(toNote);
}

/** Count of notes for one session — what `NotesIndicator` renders. */
export function countNotes(db: Database, sessionId: string): number {
  const row = db
    .prepare(
      `SELECT count(*) AS c FROM ${SESSION_NOTES_TABLE} WHERE session_id = ?`
    )
    .get(sessionId) as { c: number };
  return row.c;
}

/** One note scoped to its session, or null. */
export function getNote(
  db: Database,
  sessionId: string,
  noteId: string
): SessionNote | null {
  const row = db
    .prepare(
      `SELECT id, session_id, content, created_at, updated_at
         FROM ${SESSION_NOTES_TABLE}
        WHERE id = ? AND session_id = ?`
    )
    .get(noteId, sessionId) as SessionNoteRow | undefined;
  return row ? toNote(row) : null;
}

/**
 * Insert a note and return it. `now` is injected rather than read from
 * `Date.now()` inside the SQL default so create and update share one clock and
 * tests can assert exact timestamps.
 */
export function createNote(
  db: Database,
  sessionId: string,
  content: string,
  now: number = Date.now()
): SessionNote {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO ${SESSION_NOTES_TABLE}
       (id, session_id, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, sessionId, content, now, now);
  return {
    id,
    sessionId,
    content,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update a note's content. Returns the updated note, or null when the note does
 * not exist OR belongs to a different session — the `session_id = ?` predicate
 * in the WHERE clause is what makes a cross-session update impossible, so the
 * route layer never has to re-check ownership after the fact.
 */
export function updateNote(
  db: Database,
  sessionId: string,
  noteId: string,
  content: string,
  now: number = Date.now()
): SessionNote | null {
  const result = db
    .prepare(
      `UPDATE ${SESSION_NOTES_TABLE}
          SET content = ?, updated_at = ?
        WHERE id = ? AND session_id = ?`
    )
    .run(content, now, noteId, sessionId);
  // `changes === 0` means no row matched BOTH predicates — either the note does
  // not exist or it belongs to another session. Returning early avoids a wasted
  // SELECT on the miss path, and the caller maps null to 404 either way.
  if (result.changes === 0) return null;
  return getNote(db, sessionId, noteId);
}

/**
 * Delete a note. Returns true when a row was removed, false when the note did
 * not exist or belonged to another session (same scoping rationale as
 * {@link updateNote}).
 */
export function deleteNote(
  db: Database,
  sessionId: string,
  noteId: string
): boolean {
  const result = db
    .prepare(
      `DELETE FROM ${SESSION_NOTES_TABLE} WHERE id = ? AND session_id = ?`
    )
    .run(noteId, sessionId);
  return result.changes > 0;
}
