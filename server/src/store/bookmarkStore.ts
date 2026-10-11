// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { Bookmark } from "@hapi/protocol";

/** Raw `session_bookmarks` row as stored (epoch-ms created_at, nullable block_id). */
type BookmarkRow = {
  id: string;
  session_id: string;
  message_id: string;
  block_id: string | null;
  offset_px: number;
  /** Height of the offset's anchor element at creation (#3878); null = legacy row. */
  anchor_height_px: number | null;
  created_at: number;
};

/**
 * SQLite-backed persistence for per-session chat bookmarks (issue #3115, epic
 * #3133). Moves bookmarks off port-scoped localStorage so every device viewing
 * the SAME session sees the same bookmarks.
 *
 * **Node-local by design (RULING D2=A).** This store reads/writes the LOCAL
 * database only. A remote session viewed through a federation hub stores its
 * bookmarks on the SERVING node; cross-node bookmark visibility is an explicit
 * documented limitation and a future follow-up — there is deliberately no
 * federation mirror here.
 *
 * Follows the existing store pattern (`extensionPrefsStore.ts`,
 * `fileClaimsStore.ts`): synchronous queries, `Database` in the constructor. The
 * `session_bookmarks` table is created by the migration in `store/index.ts`
 * (`runMigrations`), NOT here — this class only reads and writes it. `session_id`
 * is FK-less (parity with `session_file_claims` — a session may live on a peer
 * under federation).
 */
export class BookmarkStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Map a raw row to the API `Bookmark` shape (epoch-ms → ISO string). */
  private rowToBookmark(row: BookmarkRow): Bookmark {
    return {
      id: row.id,
      messageId: row.message_id,
      blockId: row.block_id,
      offsetPx: row.offset_px,
      anchorHeightPx: row.anchor_height_px ?? null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  /** List a session's bookmarks, oldest first (stable order for the nav cursor). */
  list(sessionId: string): Bookmark[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM session_bookmarks WHERE session_id = ? ORDER BY created_at ASC, id ASC"
      )
      .all(sessionId) as BookmarkRow[];
    return rows.map(row => this.rowToBookmark(row));
  }

  /**
   * Upsert a bookmark at `(sessionId, messageId, blockId, offsetPx)`. Idempotent
   * on the exact SPOT: a repeat upsert of the same anchor+offset returns the
   * EXISTING row (never a duplicate), resolved via a transactional
   * read-then-insert so the read and write are atomic. A DIFFERENT `offsetPx`
   * creates a distinct bookmark, so one message/block can hold multiple
   * bookmarks at arbitrary spots (issue #3146). `blockId` null = the whole-turn
   * anchor (message root); `offsetPx` is the pixel offset of the tapped spot.
   *
   * A single-statement `INSERT ... ON CONFLICT` is avoided because the conflict
   * target is an EXPRESSION index (`COALESCE(block_id,'')`) — the SELECT-first
   * merge is portable and mirrors `extensionPrefsStore.set()`. The `block_id IS ?`
   * predicate is SQLite null-safe equality, so it matches both a null (whole-turn)
   * and a non-null (block) anchor without a branch; `offset_px` is NOT NULL so a
   * plain `= ?` equality is exact.
   *
   * `anchorHeightPx` (issue #3878) is NOT part of the spot identity — it rides
   * along on a fresh insert. It is the SIXTH parameter, after `now`, so the
   * existing positional callers keep their meaning. A repeat upsert returns the
   * stored row unchanged (a legacy row is not back-filled — the UI deletes a
   * same-spot bookmark before it could re-PUT it).
   */
  upsert(
    sessionId: string,
    messageId: string,
    blockId: string | null,
    offsetPx: number,
    now: number = Date.now(),
    anchorHeightPx: number | null = null
  ): Bookmark {
    const run = this.db.transaction((): Bookmark => {
      const existing = this.db
        .prepare(
          "SELECT * FROM session_bookmarks WHERE session_id = ? AND message_id = ? AND block_id IS ? AND offset_px = ?"
        )
        .get(sessionId, messageId, blockId, offsetPx) as BookmarkRow | null;
      if (existing) {
        return this.rowToBookmark(existing);
      }
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO session_bookmarks (id, session_id, message_id, block_id, offset_px, anchor_height_px, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, sessionId, messageId, blockId, offsetPx, anchorHeightPx, now);
      return {
        id,
        messageId,
        blockId,
        offsetPx,
        anchorHeightPx,
        createdAt: new Date(now).toISOString(),
      };
    });
    return run();
  }

  /**
   * Delete one bookmark by id, scoped to the session (a bookmark id from another
   * session never deletes here). Returns true if a row was removed.
   */
  deleteOne(sessionId: string, bookmarkId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM session_bookmarks WHERE id = ? AND session_id = ?")
      .run(bookmarkId, sessionId);
    return result.changes > 0;
  }

  /** Delete ALL bookmarks for a session (clear-all). Returns the count removed. */
  clear(sessionId: string): number {
    const result = this.db
      .prepare("DELETE FROM session_bookmarks WHERE session_id = ?")
      .run(sessionId);
    return result.changes;
  }
}
