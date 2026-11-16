// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";

/**
 * Issue #6647 (Task 9a, ruling GATE): a daily snapshot of the runner identity
 * counts, one row per UTC day and node.
 *
 * The route's counts live in memory and restart with every server start, and a
 * node restarts at every deploy, so seven days of watching are judged from
 * these rows. Each write adds the counts since the registry's last write to the
 * day's row, so a day that spans several server starts adds up.
 *
 * Additive: created in `runMigrations()` with `CREATE TABLE IF NOT EXISTS`, not
 * in `REQUIRED_TABLES`, unread by an older binary. `DROP TABLE
 * runner_identity_daily` is safe at any time; the next start creates it again.
 */

export const RUNNER_IDENTITY_DAILY_RETENTION_DAYS = 90;
export const RUNNER_IDENTITY_SNAPSHOT_LIMIT = 14;
const DAY_MS = 86_400_000;

const TABLE_DDL = `CREATE TABLE IF NOT EXISTS runner_identity_daily (
  day TEXT NOT NULL,
  node_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  mode_changed INTEGER NOT NULL DEFAULT 0,
  counts_json TEXT NOT NULL,
  boots INTEGER NOT NULL,
  unidentified_live_max INTEGER NOT NULL,
  first_write_ms INTEGER NOT NULL,
  last_write_ms INTEGER NOT NULL,
  PRIMARY KEY (day, node_id)
)`;

/** Creates the table; a failure is logged and never stops the server start. */
export function migrateRunnerIdentityDailyTable(db: Database): void {
  try {
    db.exec(TABLE_DDL);
  } catch (error) {
    console.error(
      "[Store] Migration failed: CREATE TABLE runner_identity_daily (#6647):",
      error
    );
  }
}

/** The UTC day of a time, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adds two count trees (objects whose leaves are numbers) key by key. */
export function addCountTrees(a: unknown, b: unknown): unknown {
  if (typeof a === "number" || typeof b === "number") {
    return (typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0);
  }
  const left = isRecord(a) ? a : {};
  const right = isRecord(b) ? b : {};
  const out: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    out[key] = addCountTrees(left[key], right[key]);
  }
  return out;
}

function parseCounts(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

export type RunnerIdentityDailyWrite = {
  nowMs: number;
  mode: string;
  /** The counts added since the registry's last write that landed. */
  countsDelta: object;
  /** True for the write at a server start (adds 1 to `boots`). */
  boot: boolean;
  /** `nodeWide.unidentifiedLive` at this write. */
  unidentifiedLive: number;
};

export type RunnerIdentitySnapshot = {
  day: string;
  nodeId: string;
  mode: string;
  modeChanged: boolean;
  /** The day's counts; null when the stored text does not parse. */
  counts: unknown;
  boots: number;
  unidentifiedLiveMax: number;
  firstWriteMs: number;
  lastWriteMs: number;
};

type DailyRow = {
  day: string;
  node_id: string;
  mode: string;
  mode_changed: number;
  counts_json: string;
  boots: number;
  unidentified_live_max: number;
  first_write_ms: number;
  last_write_ms: number;
};

/** One node's rows of `runner_identity_daily`. */
export class RunnerIdentityDaily {
  constructor(
    private readonly db: Database,
    readonly nodeId: string
  ) {}

  /**
   * Adds one write to the day's row (an upsert) and deletes rows older than
   * the retention. Reads before it writes, so it runs as `BEGIN IMMEDIATE`.
   */
  write(input: RunnerIdentityDailyWrite): void {
    const day = utcDay(input.nowMs);
    const oldest = utcDay(
      input.nowMs - RUNNER_IDENTITY_DAILY_RETENTION_DAYS * DAY_MS
    );
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM runner_identity_daily WHERE day = ? AND node_id = ?"
        )
        .get(day, this.nodeId) as DailyRow | null | undefined;
      if (row == null) {
        this.db
          .prepare(
            `INSERT INTO runner_identity_daily (day, node_id, mode, mode_changed,
               counts_json, boots, unidentified_live_max, first_write_ms, last_write_ms)
             VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`
          )
          .run(
            day,
            this.nodeId,
            input.mode,
            JSON.stringify(input.countsDelta),
            input.boot ? 1 : 0,
            input.unidentifiedLive,
            input.nowMs,
            input.nowMs
          );
      } else {
        const counts = addCountTrees(
          parseCounts(row.counts_json),
          input.countsDelta
        );
        this.db
          .prepare(
            `UPDATE runner_identity_daily SET mode = ?, mode_changed = ?,
               counts_json = ?, boots = ?, unidentified_live_max = ?, last_write_ms = ?
             WHERE day = ? AND node_id = ?`
          )
          .run(
            input.mode,
            row.mode_changed === 1 || row.mode !== input.mode ? 1 : 0,
            JSON.stringify(counts),
            row.boots + (input.boot ? 1 : 0),
            Math.max(row.unidentified_live_max, input.unidentifiedLive),
            input.nowMs,
            day,
            this.nodeId
          );
      }
      this.db
        .prepare("DELETE FROM runner_identity_daily WHERE day < ?")
        .run(oldest);
    });
    run.immediate();
  }

  /** The node's newest rows, newest first, with the counts parsed. */
  snapshots(limit = RUNNER_IDENTITY_SNAPSHOT_LIMIT): RunnerIdentitySnapshot[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runner_identity_daily WHERE node_id = ? ORDER BY day DESC LIMIT ?"
      )
      .all(this.nodeId, limit) as DailyRow[];
    return rows.map(row => ({
      day: row.day,
      nodeId: row.node_id,
      mode: row.mode,
      modeChanged: row.mode_changed === 1,
      counts: parseCounts(row.counts_json),
      boots: row.boots,
      unidentifiedLiveMax: row.unidentified_live_max,
      firstWriteMs: row.first_write_ms,
      lastWriteMs: row.last_write_ms,
    }));
  }
}
