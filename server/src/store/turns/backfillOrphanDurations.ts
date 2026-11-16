// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";

import { lastMessageTsMsForBounds } from "../../sync/transcript/transcriptParser";
import { resolveTranscriptPaths } from "../../sync/transcript/transcriptPath";
import { isMissingFileError } from "../../sync/transcript/transcriptReader";
import { newUuidV7 } from "./ids";
import { clampOrphanWatermark } from "./orphanWatermark";

/**
 * Orphan-duration backfill core (issues #2248, #6678).
 *
 * Fills `duration_ms` on `status='orphaned' AND duration_ms IS NULL` turns with
 * the same lower bound the live orphan sweep writes: the largest transcript
 * timestamp at or below the same session's next-turn start, clamped by
 * `clampOrphanWatermark` (no watermark, or one at or below the start, floors to
 * duration 0; a 24 h ceiling). Its inputs are rows orphaned before #2248 and
 * the live sweep's own hand-off: since #6264 the sweep leaves a turn NULL (`watermark_source: "unresolved"`)
 * when its bounded tail read could not reach the watermark, and this backfill
 * resolves it with the exact read.
 *
 * The read stays exact and whole-file (#6264 R10) but no longer loads the file
 * (#6678): rows are grouped by transcript file (inode, so paths through
 * symlinked `account-configs/*` directories count once) and each file is
 * streamed once by `lastMessageTsMsForBounds`, folding every turn's bound.
 *
 * Outcomes per row:
 * - `transcript` / `floor`: the file was read; the row is closed.
 * - missing (no file, or no resolvable path): left NULL by default, because a
 *   floored 0 is never revisited and a transcript restored to a known path can
 *   still fill it; `floorMissing` floors it as #2248 did, with
 *   `transcript_missing: true` in the event.
 * - unreadable (the file exists but a read failed): always left NULL and
 *   reported through `onReadError`, so it can be repaired once readable.
 *
 * All reads happen in the plan phase, with no transaction open. The apply
 * phase is one short `BEGIN IMMEDIATE` transaction whose UPDATE changes a row
 * only while it is still orphaned with a NULL duration and its next-turn start
 * is unchanged since the plan, and the `orphan_close`
 * event is written only for a row that changed, so a concurrent finalize or a
 * second run is never overwritten. A row the sweep left `unresolved` then
 * carries two `orphan_close` events (that one and this one; the newest by id is
 * current); a row orphaned before #2248 carries only this one.
 *
 * Separated from the CLI script (`server/scripts/backfill-orphan-durations-v2.ts`)
 * so it is unit-testable against an in-memory DB.
 */

export interface OrphanBackfillSummary {
  /** Rows considered (status='orphaned' AND duration_ms IS NULL). */
  scanned: number;
  /** Rows given a duration (= fromTranscript + floored). */
  updated: number;
  /** Of `updated`, those closed at a transcript watermark. */
  fromTranscript: number;
  /** Of `updated`, those floored to duration 0 (includes `flooredMissing`). */
  floored: number;
  /** Of `floored`, rows whose transcript is missing (only with `floorMissing`). */
  flooredMissing: number;
  /** Rows left NULL because the transcript is missing or its path unknown. */
  skippedMissing: number;
  /** Rows left NULL because the transcript exists but could not be read. */
  skippedReadError: number;
  /** Rows another writer resolved between the plan and the write (real run). */
  alreadyResolved: number;
  /** Rows still NULL whose session started a later turn after the plan (real
   *  run); the next run closes them. */
  boundChanged: number;
  /** Sum of the durations of the `fromTranscript` rows, in ms. */
  recoveredMs: number;
  /** Distinct transcript files read. */
  transcriptFiles: number;
  /** Their total size in bytes. */
  transcriptBytes: number;
}

export interface OrphanBackfillOptions {
  /** When true, compute + count but write no UPDATE / event. */
  dryRun?: boolean;
  /** Floor rows whose transcript is missing to duration 0 (permanent). */
  floorMissing?: boolean;
  /** Called once per transcript file that exists but could not be read. */
  onReadError?: (path: string, error: unknown) => void;
  /** Read chunk size (test knob). */
  chunkBytes?: number;
  /** Per-line cap (test knob). */
  maxLineBytes?: number;
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

/** One planned write: the row closes at `ended`. */
export interface PlannedClose {
  id: string;
  nodeId: string;
  startedAtMs: number;
  ended: number;
  source: "transcript" | "floor";
  transcriptMissing: boolean;
  /** The next-turn start the close was computed with (null: no later turn). */
  bound: number | null;
}

/** The read-only result of the plan phase. */
export interface OrphanBackfillPlan {
  closes: PlannedClose[];
  summary: OrphanBackfillSummary;
}

type RowRead = number | null | "missing" | "read-error";

/** The transcript path a row's watermark is read from, or null when none resolves. */
function resolveRowPath(row: OrphanRow): string | null {
  if (row.transcript_path) return row.transcript_path;
  try {
    return resolveTranscriptPaths({
      ccSessionId: row.cc_session_id ?? "",
      workingDirectory: row.cwd ?? undefined,
    }).main;
  } catch {
    return null;
  }
}

function emptySummary(scanned: number): OrphanBackfillSummary {
  return {
    scanned,
    updated: 0,
    fromTranscript: 0,
    floored: 0,
    flooredMissing: 0,
    skippedMissing: 0,
    skippedReadError: 0,
    alreadyResolved: 0,
    boundChanged: 0,
    recoveredMs: 0,
    transcriptFiles: 0,
    transcriptBytes: 0,
  };
}

/**
 * Plan phase: read every row, resolve and read each distinct transcript once,
 * and decide each row's outcome. Writes nothing and holds no transaction.
 */
export function planOrphanBackfill(
  db: Database,
  options: OrphanBackfillOptions = {}
): OrphanBackfillPlan {
  const selectRows = db.prepare(
    `SELECT id, hapi_session_id, seq, started_at_ms, node_id,
            transcript_path, cc_session_id, cwd
       FROM turns
      WHERE status = 'orphaned' AND duration_ms IS NULL`
  );
  const nextStart = db.prepare(
    "SELECT MIN(started_at_ms) AS n FROM turns WHERE hapi_session_id = ? AND seq > ?"
  );
  // Read every row and bound before any file I/O, then release the statements,
  // so no read snapshot stays open on a live database during the read phase.
  const rows = selectRows.all() as OrphanRow[];
  const bounds = rows.map(row => {
    const r = nextStart.get(row.hapi_session_id, row.seq) as
      | { n: number | null }
      | undefined;
    return r?.n ?? undefined;
  });
  selectRows.finalize();
  nextStart.finalize();

  const summary = emptySummary(rows.length);
  const reads: RowRead[] = rows.map(() => "missing");
  const groups = new Map<
    string,
    { path: string; size: number; indexes: number[] }
  >();
  const reportedErrorPaths = new Set<string>();
  const readError = (path: string, error: unknown): void => {
    if (reportedErrorPaths.has(path)) return;
    reportedErrorPaths.add(path);
    options.onReadError?.(path, error);
  };

  rows.forEach((row, i) => {
    const path = resolveRowPath(row);
    if (path === null) return; // missing
    let st;
    try {
      st = statSync(path, { bigint: true, throwIfNoEntry: false });
    } catch (error) {
      reads[i] = "read-error";
      readError(path, error);
      return;
    }
    if (st === undefined) return; // missing
    if (!st.isFile()) {
      reads[i] = "read-error";
      readError(path, new Error(`not a regular file: ${path}`));
      return;
    }
    const key = `${st.dev}:${st.ino}`;
    const group = groups.get(key) ?? {
      path,
      size: Number(st.size),
      indexes: [],
    };
    group.indexes.push(i);
    groups.set(key, group);
  });

  for (const group of groups.values()) {
    try {
      const wms = lastMessageTsMsForBounds(
        group.path,
        group.indexes.map(i => bounds[i]),
        { chunkBytes: options.chunkBytes, maxLineBytes: options.maxLineBytes }
      );
      group.indexes.forEach((rowIndex, k) => {
        reads[rowIndex] = wms[k];
      });
      summary.transcriptFiles += 1;
      summary.transcriptBytes += group.size;
    } catch (error) {
      // A file that vanished after the stat is missing; anything else is a
      // read error. Never fall through to a floor.
      const outcome = isMissingFileError(error) ? "missing" : "read-error";
      if (outcome === "read-error") readError(group.path, error);
      for (const rowIndex of group.indexes) reads[rowIndex] = outcome;
    }
  }

  const closes: PlannedClose[] = [];
  rows.forEach((row, i) => {
    const read = reads[i];
    if (read === "read-error") {
      summary.skippedReadError += 1;
      return;
    }
    if (read === "missing") {
      if (!options.floorMissing) {
        summary.skippedMissing += 1;
        return;
      }
      closes.push({
        id: row.id,
        nodeId: row.node_id,
        startedAtMs: row.started_at_ms,
        ended: row.started_at_ms,
        source: "floor",
        transcriptMissing: true,
        bound: bounds[i] ?? null,
      });
      return;
    }
    const { endedAtMs, source } = clampOrphanWatermark(read, row.started_at_ms);
    closes.push({
      id: row.id,
      nodeId: row.node_id,
      startedAtMs: row.started_at_ms,
      ended: endedAtMs,
      source,
      transcriptMissing: false,
      bound: bounds[i] ?? null,
    });
  });

  countCloses(summary, closes);
  return { closes, summary };
}

/** Add `closes` to the summary's written-row counts. */
function countCloses(
  summary: OrphanBackfillSummary,
  closes: PlannedClose[]
): void {
  for (const c of closes) {
    summary.updated += 1;
    if (c.source === "transcript") {
      summary.fromTranscript += 1;
      summary.recoveredMs += Math.max(0, c.ended - c.startedAtMs);
    } else {
      summary.floored += 1;
      if (c.transcriptMissing) summary.flooredMissing += 1;
    }
  }
}

/**
 * Apply phase: write the planned closes in one short `BEGIN IMMEDIATE`
 * transaction. A row is updated only while it is still orphaned with a NULL
 * duration and its next-turn start is unchanged since the plan (`IS @bound`),
 * and its `orphan_close` event is written only if it changed. Returns
 * the summary with the written counts (a row that changed meanwhile moves from
 * its planned count to `alreadyResolved`, or `boundChanged` if still NULL).
 */
export function applyOrphanBackfill(
  db: Database,
  plan: OrphanBackfillPlan
): OrphanBackfillSummary {
  const summary: OrphanBackfillSummary = {
    ...plan.summary,
    updated: 0,
    fromTranscript: 0,
    floored: 0,
    flooredMissing: 0,
    recoveredMs: 0,
  };
  if (plan.closes.length === 0) return summary;

  const update = db.prepare(
    `UPDATE turns
        SET ended_at_ms = @ended,
            duration_ms = MAX(0, @ended - started_at_ms)
      WHERE id = @id AND status = 'orphaned' AND duration_ms IS NULL
        AND (SELECT MIN(n.started_at_ms) FROM turns n
              WHERE n.hapi_session_id = turns.hapi_session_id
                AND n.seq > turns.seq) IS @bound`
  );
  const insertEvent = db.prepare(
    `INSERT INTO turn_events (id, turn_id, node_id, ts_ms, kind, name, payload)
     VALUES (@id, @turn_id, @node_id, @ts_ms, 'config_snapshot', 'orphan_close', @payload)`
  );
  const stillOpen = db.prepare(
    "SELECT 1 FROM turns WHERE id = ? AND status = 'orphaned' AND duration_ms IS NULL"
  );

  const applied: PlannedClose[] = [];
  const applyAll = db.transaction((items: PlannedClose[]) => {
    for (const c of items) {
      const changes = update.run({
        id: c.id,
        ended: c.ended,
        bound: c.bound,
      }).changes;
      if (changes !== 1) {
        // Still a NULL orphan: only its next-turn bound moved (#6678 review).
        if (stillOpen.get(c.id)) summary.boundChanged += 1;
        else summary.alreadyResolved += 1;
        continue;
      }
      insertEvent.run({
        id: newUuidV7(),
        turn_id: c.id,
        node_id: c.nodeId,
        ts_ms: c.ended,
        payload: JSON.stringify({
          watermark_source: c.source,
          duration_ms: Math.max(0, c.ended - c.startedAtMs),
          ended_at_ms: c.ended,
          backfilled: true,
          ...(c.transcriptMissing ? { transcript_missing: true } : {}),
        }),
      });
      applied.push(c);
    }
  });
  applyAll.immediate(plan.closes);
  countCloses(summary, applied);
  return summary;
}

export function backfillOrphanDurations(
  db: Database,
  options: OrphanBackfillOptions = {}
): OrphanBackfillSummary {
  const plan = planOrphanBackfill(db, options);
  return options.dryRun ? plan.summary : applyOrphanBackfill(db, plan);
}
