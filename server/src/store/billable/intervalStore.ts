// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type {
  BillableEndCause,
  BillableStartCause,
} from "../../billable/predicate";
import { splitIntervalByLocalDay } from "../../billable/daySplit";
import { safeJsonParse } from "../json";

/**
 * The local thinking-interval store (issue #6586). Synchronous, house style; each
 * write method runs in ONE `BEGIN IMMEDIATE` transaction, because a read-then-write
 * under a deferred BEGIN returns SQLITE_BUSY with no wait (`server/CLAUDE.md`
 * "Database").
 *
 * A "balance row" is a row whose `end_cause` is in {@link BALANCE_END_CAUSES}; a
 * "dated row" is any other closed row. Every reader excludes balance rows from
 * days and interval lists (a balance row's start is the boot time and its
 * duration a whole earlier history), and no reader adds an open interval to a
 * total or a day (ruling D3-A: closed intervals only).
 */
export const BALANCE_END_CAUSES = [
  "opening_balance",
  "carried_forward",
] as const;

const BALANCE_IN = BALANCE_END_CAUSES.map(c => `'${c}'`).join(", ");

/** The column-named open row the tracker builds. */
export interface OpenIntervalRow {
  id: string;
  hapi_session_id: string;
  namespace: string;
  node_id: string;
  launcher_kind: string;
  recorded_mode: string;
  stretch_started_at_ms: number;
  started_at_ms: number;
  last_seen_at_ms: number;
  start_cause: BillableStartCause;
  session_name: string | null;
  linked_issue: string | null;
  cwd: string | null;
}

/** The tracker spreads the open row into every close. */
export interface CloseIntervalInput extends OpenIntervalRow {
  sessionId: string;
  endedAtMs: number;
  endCause: BillableEndCause;
  recomputeTimer: boolean;
}

export interface CloseIntervalResult {
  /** False only when the row was already closed with a cause other than `hub_restart`. */
  changed: boolean;
  /** The row's stored `duration_ms` after the call. */
  durationMs: number;
  /** The sum of `duration_ms` over the session's closed rows, balance rows included. */
  sessionTotalMs: number;
}

/** The column-named old-clock stretch row the session cache builds (`shadow` only). */
export interface LegacyStretchRow {
  id: string;
  hapi_session_id: string;
  namespace: string;
  node_id: string;
  launcher_kind: string;
  stretch_started_at_ms: number;
  legacy_ended_at_ms: number;
  legacy_ms: number;
  intervals_ms: number;
  wait_ms: number;
  trim_ms: number;
  wait_ref_ms: number;
  wait_ref_incomplete: number;
  sweep_gap_ms: number;
  site: string;
  recorded_at_ms: number;
}

export interface IntervalRecord {
  id: string;
  hapiSessionId: string;
  namespace: string;
  nodeId: string;
  launcherKind: string;
  recordedMode: string;
  stretchStartedAtMs: number;
  startedAtMs: number;
  lastSeenAtMs: number;
  endedAtMs: number;
  durationMs: number;
  startCause: string;
  endCause: string;
  sessionName: string | null;
  linkedIssue: string | null;
  cwd: string | null;
  changeSeq: number | null;
}

export interface SessionTotals {
  intervalsMs: number;
  intervalsMsByLauncher: Record<string, number>;
  carriedForwardMs: number;
  totalMs: number;
}

export interface BillableDays {
  days: Array<{ localDate: string; ms: number }>;
  carriedForwardMs: number;
}

interface IntervalRow {
  id: string;
  hapi_session_id: string;
  namespace: string;
  node_id: string;
  launcher_kind: string;
  recorded_mode: string;
  stretch_started_at_ms: number;
  started_at_ms: number;
  last_seen_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
  start_cause: string;
  end_cause: string | null;
  session_name: string | null;
  linked_issue: string | null;
  cwd: string | null;
  flags: string | null;
  change_seq: number | null;
}

function toRecord(row: IntervalRow): IntervalRecord {
  return {
    id: row.id,
    hapiSessionId: row.hapi_session_id,
    namespace: row.namespace,
    nodeId: row.node_id,
    launcherKind: row.launcher_kind,
    recordedMode: row.recorded_mode,
    stretchStartedAtMs: row.stretch_started_at_ms,
    startedAtMs: row.started_at_ms,
    lastSeenAtMs: row.last_seen_at_ms,
    endedAtMs: row.ended_at_ms ?? row.started_at_ms,
    durationMs: row.duration_ms ?? 0,
    startCause: row.start_cause,
    endCause: row.end_cause ?? "",
    sessionName: row.session_name,
    linkedIssue: row.linked_issue,
    cwd: row.cwd,
    changeSeq: row.change_seq,
  };
}

/** Merge `patch` into a row's `flags` JSON object, keeping what it already holds. */
function mergeFlags(
  existing: string | null,
  patch: Record<string, unknown>
): string {
  const parsed = safeJsonParse(existing);
  const base =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return JSON.stringify({ ...base, ...patch });
}

/** Add day portions into a per-date map, keeping first-seen order. */
function addPortions(
  into: Map<string, number>,
  startMs: number,
  endMs: number,
  timezone: string
): void {
  for (const portion of splitIntervalByLocalDay(startMs, endMs, timezone)) {
    into.set(
      portion.localDate,
      (into.get(portion.localDate) ?? 0) + portion.ms
    );
  }
}

function sortedDays(map: Map<string, number>): BillableDays["days"] {
  return [...map.entries()]
    .map(([localDate, ms]) => ({ localDate, ms }))
    .sort((a, b) =>
      a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0
    );
}

export class IntervalStore {
  constructor(private readonly db: Database) {}

  private recomputeSessionTimer(sessionId: string): void {
    this.db
      .prepare(
        "UPDATE sessions SET server_accumulated_ms = (" +
          "SELECT COALESCE(SUM(duration_ms), 0) FROM thinking_intervals " +
          "WHERE hapi_session_id = ? AND ended_at_ms IS NOT NULL) WHERE id = ?"
      )
      .run(sessionId, sessionId);
  }

  private closedSum(sessionId: string): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(duration_ms), 0) AS n FROM thinking_intervals " +
            "WHERE hapi_session_id = ? AND ended_at_ms IS NOT NULL"
        )
        .get(sessionId) as { n: number }
    ).n;
  }

  /**
   * Open an interval. First closes every OTHER open row of the session that
   * started earlier, as `superseded` at its last-seen time, because a stale open
   * row (left by a set-aside close) would otherwise make every later open of the
   * session throw on the one-open-row index. Only earlier rows are superseded, so
   * an open that arrives late never closes a newer live row: the insert then throws
   * the unique-index error and the write service sets the op aside.
   */
  openInterval(
    row: OpenIntervalRow,
    options: { recomputeTimer: boolean }
  ): { inserted: boolean; superseded: number } {
    const txn = this.db.transaction(() => {
      const older = this.db
        .prepare(
          "SELECT id FROM thinking_intervals WHERE hapi_session_id = ? " +
            "AND ended_at_ms IS NULL AND id != ? AND started_at_ms < ?"
        )
        .all(row.hapi_session_id, row.id, row.started_at_ms) as Array<{
        id: string;
      }>;
      const supersede = this.db.prepare(
        "UPDATE thinking_intervals SET end_cause = 'superseded', " +
          "duration_ms = MAX(0, last_seen_at_ms - started_at_ms), " +
          "ended_at_ms = MAX(last_seen_at_ms, started_at_ms) WHERE id = ?"
      );
      for (const o of older) supersede.run(o.id);
      if (options.recomputeTimer && older.length > 0) {
        this.recomputeSessionTimer(row.hapi_session_id);
      }
      this.db
        .prepare(
          "INSERT INTO thinking_intervals (id, hapi_session_id, namespace, " +
            "node_id, launcher_kind, recorded_mode, stretch_started_at_ms, " +
            "started_at_ms, last_seen_at_ms, start_cause, session_name, " +
            "linked_issue, cwd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO NOTHING"
        )
        .run(
          row.id,
          row.hapi_session_id,
          row.namespace,
          row.node_id,
          row.launcher_kind,
          row.recorded_mode,
          row.stretch_started_at_ms,
          row.started_at_ms,
          Math.max(row.last_seen_at_ms, row.started_at_ms),
          row.start_cause,
          row.session_name,
          row.linked_issue,
          row.cwd
        );
      // changes() counts the INSERT itself, never a trigger's writes.
      const inserted =
        (this.db.prepare("SELECT changes() AS n").get() as { n: number }).n > 0;
      return { inserted, superseded: older.length };
    });
    return txn.immediate();
  }

  /**
   * Close an interval. Exactly one of: (a) the row is open, or closed as
   * `hub_restart` (written only by a start-up step of a process that did not own
   * the interval) → set its end; (b) no row has the id (the open was lost or set
   * aside) → insert it closed; (c) the row is closed with any other cause → no
   * write, so a second close is a no-op.
   *
   * `duration_ms = MAX(0, endedAtMs - started_at_ms)` and the stored end is
   * `started_at_ms + duration_ms`; an end before the start also records
   * `flags.clamped` and `flags.rawEndedAtMs`. No duration is capped: the tracker
   * rolls an interval over at 24 h instead.
   */
  closeInterval(input: CloseIntervalInput): CloseIntervalResult {
    const txn = this.db.transaction((): CloseIntervalResult => {
      const existing = this.db
        .prepare("SELECT * FROM thinking_intervals WHERE id = ?")
        .get(input.id) as IntervalRow | null;

      const startedAtMs = existing?.started_at_ms ?? input.started_at_ms;
      const durationMs = Math.max(0, input.endedAtMs - startedAtMs);
      const endedAtMs = startedAtMs + durationMs;
      const clampPatch =
        input.endedAtMs < startedAtMs
          ? { clamped: true, rawEndedAtMs: input.endedAtMs }
          : null;

      let changed: boolean;
      let storedDuration: number;
      if (
        existing != null &&
        (existing.ended_at_ms === null || existing.end_cause === "hub_restart")
      ) {
        this.db
          .prepare(
            "UPDATE thinking_intervals SET ended_at_ms = ?, duration_ms = ?, " +
              "end_cause = ?, flags = ? WHERE id = ?"
          )
          .run(
            endedAtMs,
            durationMs,
            input.endCause,
            clampPatch
              ? mergeFlags(existing.flags, clampPatch)
              : existing.flags,
            input.id
          );
        changed = true;
        storedDuration = durationMs;
      } else if (existing == null) {
        this.db
          .prepare(
            "INSERT INTO thinking_intervals (id, hapi_session_id, namespace, " +
              "node_id, launcher_kind, recorded_mode, stretch_started_at_ms, " +
              "started_at_ms, last_seen_at_ms, ended_at_ms, duration_ms, " +
              "start_cause, end_cause, session_name, linked_issue, cwd, flags) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            input.id,
            input.hapi_session_id,
            input.namespace,
            input.node_id,
            input.launcher_kind,
            input.recorded_mode,
            input.stretch_started_at_ms,
            startedAtMs,
            endedAtMs,
            endedAtMs,
            durationMs,
            input.start_cause,
            input.endCause,
            input.session_name,
            input.linked_issue,
            input.cwd,
            clampPatch ? mergeFlags(null, clampPatch) : null
          );
        changed = true;
        storedDuration = durationMs;
      } else {
        changed = false;
        storedDuration = existing.duration_ms ?? 0;
      }

      if (changed && input.recomputeTimer) {
        this.recomputeSessionTimer(input.sessionId);
      }
      return {
        changed,
        durationMs: storedDuration,
        sessionTotalMs: this.closedSum(input.sessionId),
      };
    });
    return txn.immediate();
  }

  /**
   * Persist an open interval's last-observed time; monotonic. A `hub_restart` row
   * stays touchable, because the hub that owns it may still be running after
   * another process repaired it; the next boot repair re-closes it at the later
   * time. A touch never moves `change_seq` (the trigger ignores it).
   */
  touchLastSeen(id: string, ms: number): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE thinking_intervals SET last_seen_at_ms = MAX(last_seen_at_ms, ?) " +
            "WHERE id = ? AND (ended_at_ms IS NULL OR end_cause = 'hub_restart')"
        )
        .run(ms, id);
    });
    txn.immediate();
  }

  /** Record one old-clock stretch (`shadow` only); once per `id`. */
  recordLegacyStretch(row: LegacyStretchRow): void {
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO billable_shadow_stretches (id, hapi_session_id, namespace, " +
            "node_id, stretch_started_at_ms, legacy_ended_at_ms, legacy_ms, " +
            "intervals_ms, wait_ms, trim_ms, launcher_kind, wait_ref_ms, " +
            "wait_ref_incomplete, sweep_gap_ms, site, recorded_at_ms) VALUES " +
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING"
        )
        .run(
          row.id,
          row.hapi_session_id,
          row.namespace,
          row.node_id,
          row.stretch_started_at_ms,
          row.legacy_ended_at_ms,
          row.legacy_ms,
          row.intervals_ms,
          row.wait_ms,
          row.trim_ms,
          row.launcher_kind,
          row.wait_ref_ms,
          row.wait_ref_incomplete,
          row.sweep_gap_ms,
          row.site,
          row.recorded_at_ms
        );
    });
    txn.immediate();
  }

  /**
   * The session's closed dated rows, oldest first. With a bound, rows are selected
   * by overlap (`started_at_ms < toMs AND ended_at_ms > fromMs`).
   */
  listForSession(
    sessionId: string,
    range: { fromMs?: number; toMs?: number } = {}
  ): IntervalRecord[] {
    const fromMs = range.fromMs ?? Number.MIN_SAFE_INTEGER;
    const toMs = range.toMs ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        "SELECT * FROM thinking_intervals WHERE hapi_session_id = ? " +
          `AND ended_at_ms IS NOT NULL AND end_cause NOT IN (${BALANCE_IN}) ` +
          "AND started_at_ms < ? AND ended_at_ms > ? ORDER BY started_at_ms, id"
      )
      .all(sessionId, toMs, fromMs) as IntervalRow[];
    return rows.map(toRecord);
  }

  /** Lifetime totals; an open row is in none of them. */
  sessionTotals(sessionId: string): SessionTotals {
    const rows = this.db
      .prepare(
        "SELECT launcher_kind, end_cause, COALESCE(SUM(duration_ms), 0) AS ms " +
          "FROM thinking_intervals WHERE hapi_session_id = ? AND ended_at_ms IS NOT NULL " +
          "GROUP BY launcher_kind, end_cause"
      )
      .all(sessionId) as Array<{
      launcher_kind: string;
      end_cause: string | null;
      ms: number;
    }>;
    let intervalsMs = 0;
    let carriedForwardMs = 0;
    const intervalsMsByLauncher: Record<string, number> = {};
    for (const r of rows) {
      if (
        (BALANCE_END_CAUSES as readonly string[]).includes(r.end_cause ?? "")
      ) {
        carriedForwardMs += r.ms;
      } else {
        intervalsMs += r.ms;
        intervalsMsByLauncher[r.launcher_kind] =
          (intervalsMsByLauncher[r.launcher_kind] ?? 0) + r.ms;
      }
    }
    return {
      intervalsMs,
      intervalsMsByLauncher,
      carriedForwardMs,
      totalMs: intervalsMs + carriedForwardMs,
    };
  }

  /**
   * Day portions of the namespace's (and, when given, the session's) closed dated
   * rows in `[fromMs, toMs)`. Each row's span is clipped to the range and then
   * split, which gives the same portions as splitting the whole row and clipping
   * each portion, so two adjacent ranges add up to the whole interval.
   * `carriedForwardMs` sums the balance rows in the same scope whatever the range,
   * because a balance row is undated.
   */
  billableByLocalDay(query: {
    namespace: string;
    sessionId?: string;
    fromMs: number;
    toMs: number;
    timezone: string;
  }): BillableDays {
    const sessionClause =
      query.sessionId !== undefined ? " AND hapi_session_id = ?" : "";
    const scope: Array<string> =
      query.sessionId !== undefined
        ? [query.namespace, query.sessionId]
        : [query.namespace];
    const rows = this.db
      .prepare(
        "SELECT started_at_ms, duration_ms FROM thinking_intervals WHERE namespace = ?" +
          sessionClause +
          ` AND ended_at_ms IS NOT NULL AND end_cause NOT IN (${BALANCE_IN})` +
          " AND started_at_ms < ? AND ended_at_ms > ?"
      )
      .all(...scope, query.toMs, query.fromMs) as Array<{
      started_at_ms: number;
      duration_ms: number;
    }>;
    const byDay = new Map<string, number>();
    for (const r of rows) {
      addPortions(
        byDay,
        Math.max(r.started_at_ms, query.fromMs),
        Math.min(r.started_at_ms + r.duration_ms, query.toMs),
        query.timezone
      );
    }
    const carriedForwardMs = (
      this.db
        .prepare(
          "SELECT COALESCE(SUM(duration_ms), 0) AS n FROM thinking_intervals " +
            `WHERE namespace = ?${sessionClause} AND end_cause IN (${BALANCE_IN})`
        )
        .get(...scope) as { n: number }
    ).n;
    return { days: sortedDays(byDay), carriedForwardMs };
  }

  /** The session's one open row, for display only; it is in no total. */
  openForSession(
    sessionId: string
  ): { id: string; startedAtMs: number; lastSeenAtMs: number } | null {
    const row = this.db
      .prepare(
        "SELECT id, started_at_ms, last_seen_at_ms FROM thinking_intervals " +
          "WHERE hapi_session_id = ? AND ended_at_ms IS NULL"
      )
      .get(sessionId) as {
      id: string;
      started_at_ms: number;
      last_seen_at_ms: number;
    } | null;
    return row
      ? {
          id: row.id,
          startedAtMs: row.started_at_ms,
          lastSeenAtMs: row.last_seen_at_ms,
        }
      : null;
  }
}
