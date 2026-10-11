// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

import { lastMessageTsMs } from "../../sync/transcript/transcriptParser";
import { newUuidV7 } from "./ids";
import { clampOrphanWatermark } from "./orphanWatermark";

/**
 * Historical orphan-duration backfill core (issue #2248).
 *
 * Before #2248 the orphan sweep left `duration_ms` NULL, so every orphaned turn
 * (840/8,125 = 10.3% in the prod audit) was excluded from all time aggregation.
 * The forward fix populates a lower-bound `duration_ms` at sweep time; this core
 * applies the SAME derivation to the historical rows already sitting NULL.
 *
 * For each `status='orphaned' AND duration_ms IS NULL` row it resolves the
 * last-observed-activity watermark — the transcript's last message timestamp
 * (`lastMessageTsMs`, fail-open), bounded above by the same session's next-turn
 * start so a later turn's messages are not mis-attributed — falling back to the
 * `started_at_ms` floor (duration 0) when the transcript is gone. It writes
 * `ended_at_ms` + `duration_ms = MAX(0, ended - started)` and records an
 * `orphan_close` provenance turn_event (identical to the sweep), so a backfilled
 * row stays distinguishable as an estimate.
 *
 * Idempotent: the `duration_ms IS NULL` filter means a second run scans the same
 * rows but finds none left to update (a floored row has `duration_ms = 0`, which
 * is non-NULL). Best-effort: month-old transcripts may be pruned → those rows
 * floor to 0 and remain `status='orphaned'`, re-derivable later.
 *
 * Separated from the `backfill-orphan-durations` CLI script so it is unit-testable
 * against an in-memory DB (the script is a thin path-resolution + DB-open wrapper).
 */

export interface OrphanBackfillSummary {
  /** Rows considered (status='orphaned' AND duration_ms IS NULL). */
  scanned: number;
  /** Rows that received a non-NULL lower-bound duration_ms. */
  updated: number;
  /** Of `updated`, those closed at a transcript watermark (> floor). */
  fromTranscript: number;
  /** Of `updated`, those floored to started_at_ms (transcript gone → duration 0). */
  floored: number;
}

export interface OrphanBackfillOptions {
  /** When true, compute + count but write no UPDATE / event. */
  dryRun?: boolean;
}

interface OrphanRow {
  id: string;
  hapi_session_id: string;
  seq: number;
  started_at_ms: number;
  node_id: string;
  transcript_path: string | null;
  cc_session_id: string | null;
  cwd: string | null;
}

export function backfillOrphanDurations(
  db: Database,
  options: OrphanBackfillOptions = {}
): OrphanBackfillSummary {
  const dryRun = options.dryRun ?? false;

  const rows = db
    .prepare(
      `SELECT id, hapi_session_id, seq, started_at_ms, node_id,
              transcript_path, cc_session_id, cwd
         FROM turns
        WHERE status = 'orphaned' AND duration_ms IS NULL`
    )
    .all() as OrphanRow[];

  const nextStart = db.prepare(
    "SELECT MIN(started_at_ms) AS n FROM turns WHERE hapi_session_id = ? AND seq > ?"
  );
  const update = db.prepare(
    `UPDATE turns
        SET ended_at_ms = @ended,
            duration_ms = MAX(0, @ended - started_at_ms)
      WHERE id = @id`
  );
  const insertEvent = db.prepare(
    `INSERT INTO turn_events (id, turn_id, node_id, ts_ms, kind, name, payload)
     VALUES (@id, @turn_id, @node_id, @ts_ms, 'config_snapshot', 'orphan_close', @payload)`
  );

  const toApply: Array<{
    row: OrphanRow;
    ended: number;
    source: "transcript" | "floor";
  }> = [];

  for (const row of rows) {
    const floor = row.started_at_ms;
    const nb = nextStart.get(row.hapi_session_id, row.seq) as
      | { n: number | null }
      | undefined;
    const wm = lastMessageTsMs({
      transcriptPath: row.transcript_path,
      ccSessionId: row.cc_session_id,
      workingDirectory: row.cwd,
      upperBoundMs: nb?.n ?? undefined,
    });
    const { endedAtMs, source } = clampOrphanWatermark(wm, floor);
    toApply.push({ row, ended: endedAtMs, source });
  }

  if (!dryRun && toApply.length > 0) {
    const applyAll = db.transaction((items: typeof toApply) => {
      for (const { row, ended, source } of items) {
        update.run({ id: row.id, ended });
        insertEvent.run({
          id: newUuidV7(),
          turn_id: row.id,
          node_id: row.node_id,
          ts_ms: ended,
          payload: JSON.stringify({
            watermark_source: source,
            duration_ms: Math.max(0, ended - row.started_at_ms),
            ended_at_ms: ended,
            backfilled: true,
          }),
        });
      }
    });
    applyAll(toApply);
  }

  let fromTranscript = 0;
  let floored = 0;
  for (const { source } of toApply) {
    if (source === "transcript") fromTranscript++;
    else floored++;
  }

  return {
    scanned: rows.length,
    updated: toApply.length,
    fromTranscript,
    floored,
  };
}
