// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { generatePinId } from "@hapi/protocol";

/**
 * Pin IDs (#6574): storage. Free functions, not `PinStore` methods, because the
 * migration runs in `Store.runMigrations()` before `PinStore` is built, and the mint
 * runs inside the transaction `PinStore.upsert` already holds.
 *
 * Three pieces:
 * - `session_pins.pin_id`, added by `Store.runMigrations()` with `migrateAddColumn`,
 *   and a PLAIN unique index on it. A plain unique index still allows many NULLs
 *   (rows a reverted older binary inserted), and it serves the backfill's
 *   `pin_id IS NULL` probe as well as the by-ID read.
 * - `pin_ids`, the registry of every ID this node ever issued (ruling D2). It has no
 *   foreign key and no session or key column, so no delete path (eviction, the
 *   closed-pin trim, the session cascade) touches it, nothing of a deleted session
 *   survives in it, and an ID is never issued twice.
 * - The backfill, which gives every row without an ID one, on every start.
 *
 * `SCHEMA_VERSION` and `REQUIRED_TABLES` are untouched: an older binary ignores the
 * column and the table, and its inserts leave `pin_id` NULL, which the next start of
 * this binary fills.
 */

/** Attempts before the mint gives up. A real collision is ~6 × 10^-4 at 1 000 000 pins. */
const PIN_ID_MINT_ATTEMPTS = 8;
const BACKFILL_BATCH = 1000;

export type PinIdRandomBytes = (n: number) => Uint8Array;

export function applyPinIdMigrations(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS pin_ids (" +
      "id TEXT PRIMARY KEY, " +
      "minted_at INTEGER NOT NULL) WITHOUT ROWID"
  );
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_pins_pin_id " +
      "ON session_pins(pin_id)"
  );
  backfillPinIds(db);
}

/**
 * A new pin ID, recorded in `pin_ids`. An attempt is taken only when neither the
 * registry nor a pin row holds it (a row an older build gave an ID before the
 * registry existed cannot exist, but the check costs one index probe). The caller
 * holds the write transaction and calls this only once its row is certain to be
 * inserted, so a refused write never leaves an issued ID with no pin.
 */
export function mintPinId(
  db: Database,
  randomBytes?: PinIdRandomBytes,
  now: number = Date.now()
): string {
  const taken = db.prepare(
    "SELECT 1 FROM pin_ids WHERE id = ? " +
      "UNION ALL SELECT 1 FROM session_pins WHERE pin_id = ? LIMIT 1"
  );
  for (let attempt = 0; attempt < PIN_ID_MINT_ATTEMPTS; attempt++) {
    const id = generatePinId(randomBytes);
    if (taken.get(id, id)) continue;
    db.prepare("INSERT INTO pin_ids (id, minted_at) VALUES (?, ?)").run(
      id,
      now
    );
    return id;
  }
  throw new Error(
    `mintPinId: every one of ${PIN_ID_MINT_ATTEMPTS} attempts drew an ID already issued`
  );
}

/**
 * Give every row without an ID one. Probes first, outside any transaction, so a
 * start with nothing to fill never takes the write lock; otherwise fills in
 * `BEGIN IMMEDIATE` batches until none are left. Returns how many rows it filled.
 */
export function backfillPinIds(
  db: Database,
  options: { batch?: number; randomBytes?: PinIdRandomBytes } = {}
): number {
  const probe = db
    .prepare("SELECT 1 AS one FROM session_pins WHERE pin_id IS NULL LIMIT 1")
    .get();
  if (!probe) return 0;
  const batch = Math.max(1, options.batch ?? BACKFILL_BATCH);
  const select = db.prepare(
    "SELECT rowid AS rowid FROM session_pins WHERE pin_id IS NULL LIMIT ?"
  );
  const update = db.prepare(
    "UPDATE session_pins SET pin_id = ? WHERE rowid = ?"
  );
  const fillBatch = db.transaction((): number => {
    const rows = select.all(batch) as Array<{ rowid: number }>;
    for (const row of rows) {
      update.run(mintPinId(db, options.randomBytes), row.rowid);
    }
    return rows.length;
  });
  let filled = 0;
  for (;;) {
    const n = fillBatch.immediate();
    filled += n;
    if (n < batch) break;
  }
  if (filled > 0) {
    console.log(`[Store] Pin IDs: gave ${filled} existing pin(s) an ID`);
  }
  return filled;
}
