// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Physical table name for `builtin.session-notes` (issue #1284).
 *
 * Single source of truth shared by the migration (which creates the table) and
 * the query layer (which reads and writes it). They MUST agree — if the
 * migration creates one name while the queries address another, the extension
 * loads cleanly and then fails at first query with `SQLiteError: no such table`.
 * That exact failure shipped past a green migration suite in #1274; the lesson
 * is encoded here as a shared constant rather than two string literals.
 *
 * The `ext_<sanitizedId>_` prefix matches the convention the extension host
 * applies in `host.store.addTable` for `builtin.session-notes` (`.` → `_`), and
 * is asserted directly by this issue's acceptance criteria.
 */

/** Per-session notes owned by `builtin.session-notes`. */
export const SESSION_NOTES_TABLE = "ext_builtin_session_notes_notes";

/** Maximum note length, enforced at the route boundary and mirrored in the UI. */
export const MAX_NOTE_LENGTH = 5000;
