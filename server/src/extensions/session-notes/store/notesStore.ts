// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `SessionNotesStore` — thin wrapper around the session-notes SQL queries
 * (issue #1284).
 *
 * Receives a `Database` in the constructor and delegates to the pure query
 * functions in `notesQueries.ts`. Pattern: follows
 * `server/src/extensions/scheduler/store/schedulerStore.ts`, which in turn
 * follows core's `server/src/store/timeLogStore.ts`.
 */
import type { Database } from "bun:sqlite";

import type { SessionNote } from "../types";
import {
  countNotes,
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from "./notesQueries";

export class SessionNotesStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  list(sessionId: string): SessionNote[] {
    return listNotes(this.db, sessionId);
  }

  count(sessionId: string): number {
    return countNotes(this.db, sessionId);
  }

  get(sessionId: string, noteId: string): SessionNote | null {
    return getNote(this.db, sessionId, noteId);
  }

  create(sessionId: string, content: string): SessionNote {
    return createNote(this.db, sessionId, content);
  }

  update(
    sessionId: string,
    noteId: string,
    content: string
  ): SessionNote | null {
    return updateNote(this.db, sessionId, noteId, content);
  }

  delete(sessionId: string, noteId: string): boolean {
    return deleteNote(this.db, sessionId, noteId);
  }
}
