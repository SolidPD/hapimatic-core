// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Wire + domain types for `builtin.session-notes` (issue #1284).
 *
 * Declared inside the extension rather than in `shared/src/schemas.ts`: the
 * whole point of this pattern-demo issue is that a brand-new feature can ship
 * end-to-end WITHOUT core learning about it. The web half declares a structurally
 * identical `SessionNote` for the same reason — the two are coupled by the REST
 * contract, not by a shared import, exactly as a third-party extension would be.
 */

/** One note, as stored and as returned on the wire (camelCase). */
export interface SessionNote {
  id: string;
  sessionId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

/** Raw snake_case row shape as SQLite returns it. */
export interface SessionNoteRow {
  id: string;
  session_id: string;
  content: string;
  created_at: number;
  updated_at: number;
}
