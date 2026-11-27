// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * A turn's id by `(hapiSessionId, seq)`, moved out of `TurnStore` unchanged
 * (#6559 PR 1 fix round), so `turnStore.ts` stays within the Epic 0 (#2077)
 * limit of 1,500 lines. Built on the database `TurnStore` reads
 * (`Store.getRawDb()`).
 */
export class TurnIdBySeqReader {
  constructor(private readonly db: Database) {}

  /**
   * The id of the turn `(hapiSessionId, seq)`, or `null` — issue #6559 (Task 10).
   * The context-reset service writes its `context_reset` events on the arming
   * turn's row and knows only the seq. Indexed by the UNIQUE operational key.
   */
  getTurnIdBySeq(hapiSessionId: string, seq: number): string | null {
    const row = this.db
      .prepare("SELECT id FROM turns WHERE hapi_session_id = ? AND seq = ?")
      .get(hapiSessionId, seq) as { id: unknown } | undefined;
    return row && row.id != null ? String(row.id) : null;
  }
}
