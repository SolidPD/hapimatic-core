// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type {
  MirrorAdjustmentRow,
  MirrorTurnRow,
  TurnFeedDigestDay,
  TurnMirrorOriginStatus,
} from "@hapi/protocol";

/** The per-origin cursor row (turns + adjustments cursors + status). */
export interface MirrorCursor {
  originIncarnation: string;
  turnCursor: number;
  adjCursor: number;
  lastOriginMaxSeq: number | null;
  lastSyncAtMs: number | null;
}

/**
 * The read-only mirror of OTHER nodes' finalized turns (issue #4614).
 *
 * Writes go ONLY to the `turn_mirror` / `timelog_adjustments_mirror` /
 * `turn_mirror_cursor` tables — NEVER to `turns` / `timelog_adjustments` — so the
 * existing readers (`/api/timelogs/derived`, session totals) can never see a
 * foreign row and double-count (R3). Rows are keyed by
 * `(origin_node_id, origin_incarnation, <row id>)`, so a rebuilt origin's
 * new-incarnation rows coexist with the old; nothing here ever DELETEs, so a
 * departed node's history is kept (R11). Synchronous (like `TurnStore`); the
 * pull service wraps a whole feed page in one transaction.
 */
export class TurnMirrorStore {
  constructor(private readonly db: Database) {}

  /** Upsert a page of mirrored turns (idempotent re-pull → no dup rows, R5). */
  upsertMirrorTurns(
    originNodeId: string,
    incarnation: string,
    rows: MirrorTurnRow[]
  ): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO turn_mirror (
         origin_node_id, origin_incarnation, turn_id, origin_change_seq,
         hapi_session_id, namespace, status, started_at_ms, ended_at_ms,
         duration_ms, row_json, mirrored_at_ms
       ) VALUES (
         @origin_node_id, @origin_incarnation, @turn_id, @origin_change_seq,
         @hapi_session_id, @namespace, @status, @started_at_ms, @ended_at_ms,
         @duration_ms, @row_json, @mirrored_at_ms
       )
       ON CONFLICT (origin_node_id, origin_incarnation, turn_id) DO UPDATE SET
         origin_change_seq = excluded.origin_change_seq,
         hapi_session_id   = excluded.hapi_session_id,
         namespace         = excluded.namespace,
         status            = excluded.status,
         started_at_ms     = excluded.started_at_ms,
         ended_at_ms       = excluded.ended_at_ms,
         duration_ms       = excluded.duration_ms,
         row_json          = excluded.row_json,
         mirrored_at_ms    = excluded.mirrored_at_ms`
    );
    const now = Date.now();
    const apply = this.db.transaction((items: MirrorTurnRow[]) => {
      for (const r of items) {
        stmt.run({
          origin_node_id: originNodeId,
          origin_incarnation: incarnation,
          turn_id: r.turnId,
          origin_change_seq: r.changeSeq,
          hapi_session_id: r.hapiSessionId,
          namespace: r.namespace,
          status: r.status,
          started_at_ms: r.startedAtMs,
          ended_at_ms: r.endedAtMs,
          duration_ms: r.durationMs,
          row_json: r.rowJson,
          mirrored_at_ms: now,
        });
      }
    });
    apply(rows);
  }

  /** Upsert a page of mirrored adjustments. */
  upsertMirrorAdjustments(
    originNodeId: string,
    incarnation: string,
    rows: MirrorAdjustmentRow[]
  ): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO timelog_adjustments_mirror (
         origin_node_id, origin_incarnation, adjustment_id, origin_change_seq,
         hapi_session_id, namespace, ts_ms, row_json, mirrored_at_ms
       ) VALUES (
         @origin_node_id, @origin_incarnation, @adjustment_id, @origin_change_seq,
         @hapi_session_id, @namespace, @ts_ms, @row_json, @mirrored_at_ms
       )
       ON CONFLICT (origin_node_id, origin_incarnation, adjustment_id) DO UPDATE SET
         origin_change_seq = excluded.origin_change_seq,
         hapi_session_id   = excluded.hapi_session_id,
         namespace         = excluded.namespace,
         ts_ms             = excluded.ts_ms,
         row_json          = excluded.row_json,
         mirrored_at_ms    = excluded.mirrored_at_ms`
    );
    const now = Date.now();
    const apply = this.db.transaction((items: MirrorAdjustmentRow[]) => {
      for (const r of items) {
        stmt.run({
          origin_node_id: originNodeId,
          origin_incarnation: incarnation,
          adjustment_id: r.adjustmentId,
          origin_change_seq: r.changeSeq,
          hapi_session_id: r.hapiSessionId,
          namespace: r.namespace,
          ts_ms: r.tsMs,
          row_json: r.rowJson,
          mirrored_at_ms: now,
        });
      }
    });
    apply(rows);
  }

  /** The stored cursor for an origin, or null if never pulled. */
  getCursor(originNodeId: string): MirrorCursor | null {
    const row = this.db
      .prepare(
        `SELECT origin_incarnation, turn_cursor, adj_cursor,
                last_origin_max_seq, last_sync_at_ms
           FROM turn_mirror_cursor WHERE origin_node_id = @id`
      )
      .get({ id: originNodeId }) as {
      origin_incarnation: string;
      turn_cursor: number;
      adj_cursor: number;
      last_origin_max_seq: number | null;
      last_sync_at_ms: number | null;
    } | null;
    if (!row) return null;
    return {
      originIncarnation: row.origin_incarnation,
      turnCursor: row.turn_cursor,
      adjCursor: row.adj_cursor,
      lastOriginMaxSeq: row.last_origin_max_seq,
      lastSyncAtMs: row.last_sync_at_ms,
    };
  }

  /** Persist the advanced cursor + status for an origin (upsert). */
  setCursor(
    originNodeId: string,
    incarnation: string,
    turnCursor: number,
    adjCursor: number,
    originMaxSeq: number | null,
    syncAtMs: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO turn_mirror_cursor (
           origin_node_id, origin_incarnation, turn_cursor, adj_cursor,
           last_origin_max_seq, last_sync_at_ms
         ) VALUES (@id, @inc, @tc, @ac, @max, @sync)
         ON CONFLICT (origin_node_id) DO UPDATE SET
           origin_incarnation  = excluded.origin_incarnation,
           turn_cursor         = excluded.turn_cursor,
           adj_cursor          = excluded.adj_cursor,
           last_origin_max_seq = excluded.last_origin_max_seq,
           last_sync_at_ms     = excluded.last_sync_at_ms`
      )
      .run({
        id: originNodeId,
        inc: incarnation,
        tc: turnCursor,
        ac: adjCursor,
        max: originMaxSeq,
        sync: syncAtMs,
      });
  }

  /**
   * Reset an origin's cursor to 0 under a (possibly new) incarnation — the clean
   * resync on a rebuilt-VM incarnation change or a restore-from-backup rewind
   * (R5). Old-incarnation mirror rows are intentionally LEFT in place (R11); the
   * composite key means the re-pulled rows land under the new incarnation.
   */
  resetOrigin(originNodeId: string, incarnation: string): void {
    this.setCursor(originNodeId, incarnation, 0, 0, null, Date.now());
  }

  /** Per-origin sync status for the status read (R6). lag = now - lastSync. */
  getStatus(nowMs: number = Date.now()): TurnMirrorOriginStatus[] {
    const rows = this.db
      .prepare(
        `SELECT c.origin_node_id, c.origin_incarnation, c.turn_cursor, c.adj_cursor,
                c.last_origin_max_seq, c.last_sync_at_ms,
                (SELECT COUNT(*) FROM turn_mirror m
                   WHERE m.origin_node_id = c.origin_node_id
                     AND m.origin_incarnation = c.origin_incarnation) AS mirrored_turn_count
           FROM turn_mirror_cursor c
          ORDER BY c.origin_node_id`
      )
      .all() as Array<{
      origin_node_id: string;
      origin_incarnation: string;
      turn_cursor: number;
      adj_cursor: number;
      last_origin_max_seq: number | null;
      last_sync_at_ms: number | null;
      mirrored_turn_count: number;
    }>;
    return rows.map(r => ({
      originNodeId: r.origin_node_id,
      originIncarnation: r.origin_incarnation,
      turnCursor: r.turn_cursor,
      adjCursor: r.adj_cursor,
      lastOriginMaxSeq: r.last_origin_max_seq,
      lastSyncAtMs: r.last_sync_at_ms,
      lagMs: r.last_sync_at_ms === null ? null : nowMs - r.last_sync_at_ms,
      mirroredTurnCount: r.mirrored_turn_count,
    }));
  }

  /**
   * Per-UTC-day (count, checksum) digest over an origin's mirrored turns —
   * compared against the origin's own digest to detect silent drift (R10). Uses
   * `started_at_ms` from the mirror's projected column + `origin_change_seq` so
   * the checksum matches the origin's `SUM(change_seq)` exactly when in sync.
   */
  getMirrorDigest(
    originNodeId: string,
    incarnation: string
  ): TurnFeedDigestDay[] {
    return this.db
      .prepare(
        `SELECT date(started_at_ms / 1000, 'unixepoch') AS date,
                COUNT(*) AS count,
                COALESCE(SUM(origin_change_seq), 0) AS checksum
           FROM turn_mirror
          WHERE origin_node_id = @id AND origin_incarnation = @inc
            AND status != 'open'
          GROUP BY date ORDER BY date`
      )
      .all({ id: originNodeId, inc: incarnation }) as TurnFeedDigestDay[];
  }

  /** Count mirrored turns for an origin (tests / status). */
  countMirrorTurns(originNodeId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS c FROM turn_mirror WHERE origin_node_id = @id"
      )
      .get({ id: originNodeId }) as { c: number };
    return row.c;
  }
}
