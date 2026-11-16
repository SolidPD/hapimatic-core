// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { IntervalFeedPage, MirrorIntervalRow } from "@hapi/protocol";
import { splitIntervalByLocalDay } from "../../billable/daySplit";
import { FEED_PAGE_BYTE_BUDGET } from "../turns/turnStore";
import {
  BALANCE_END_CAUSES,
  type BillableDays,
  type IntervalRecord,
  type SessionTotals,
} from "./intervalStore";

/**
 * The billable interval feed and mirror (issue #6586, R11).
 *
 * Two halves. The feed readers serve THIS node's closed `thinking_intervals` rows
 * to peers. The mirror half stores OTHER nodes' closed intervals in
 * `thinking_intervals_mirror` (never in `thinking_intervals`, so a local reader
 * cannot double-count) and one cursor row per origin in
 * `thinking_interval_mirror_cursor`, which is also where "no interval data" is
 * recorded (`feed_state`, `origin_mode`, `last_sync_at_ms`).
 *
 * Mirror rows are never deleted, so a departed origin's history is kept, and a
 * mirrored closed interval is never shortened (a restore can re-close an interval
 * shorter at the origin; the re-pull must not replace the real, longer close).
 * Readers count each `interval_id` once: when one id is stored under more than one
 * key (two incarnations, or a node whose id changed), a dated row is counted at
 * the largest `duration_ms`, then the latest `mirrored_at_ms`, and a balance row
 * (`opening_balance`, `carried_forward`) at the first received (keep-held, issue
 * #6651: a balance row made again after a restore can hold a different amount,
 * and the node keeps the one it received first). Balance rows are excluded from
 * interval lists and days and returned as `carriedForwardMs`, a `carried_forward`
 * row with the cap's key at its capped amount (`balanceAmounts`, issue #6651).
 */

/**
 * The mirror's rule for balance rows, printed on the boot line. A change to how
 * the mirror stores or counts a balance row changes this value (issue #6651).
 */
export const MIRROR_BALANCE_RULE = "keep-first-v1; cap-started-window-v1";

export type MirrorFeedState = "ok" | "unsupported";

export interface IntervalMirrorCursor {
  originNodeId: string;
  originIncarnation: string;
  cursor: number;
  feedState: MirrorFeedState;
  originMode: string | null;
  lastOriginMaxSeq: number | null;
  lastSyncAtMs: number | null;
  lastAttemptAtMs: number | null;
}

export interface MirrorSessionTotals extends SessionTotals {
  /** The origin of the session's most recently mirrored row. */
  originNodeId: string | null;
}

interface CursorRow {
  origin_node_id: string;
  origin_incarnation: string;
  cursor: number;
  feed_state: string;
  origin_mode: string | null;
  last_origin_max_seq: number | null;
  last_sync_at_ms: number | null;
  last_attempt_at_ms: number | null;
}

interface MirrorRow {
  origin_node_id: string;
  interval_id: string;
  hapi_session_id: string;
  namespace: string;
  launcher_kind: string;
  started_at_ms: number;
  ended_at_ms: number;
  duration_ms: number;
  end_cause: string;
  row_json: string;
  origin_change_seq: number;
  mirrored_at_ms: number;
}

/**
 * One row per `interval_id` for a session in a namespace: the count-once rule.
 * A balance id is counted at the first received (keep-held, #6651), and on an
 * exact tie of `mirrored_at_ms` at the SMALLER duration, so a tie never counts a
 * figure above the one-node figure (#6651, the Project Manager's ruling of
 * 2026-11-14); a dated id at the largest duration, then the latest mirror time.
 * One id is either a balance id or a dated id, so one partition is of one kind; the
 * last two keys make a full tie deterministic. For a balance row stored before
 * keep-held, the older upsert had moved `mirrored_at_ms` at every arrival, so
 * "first received" there means its latest arrival before the upgrade.
 */
const COUNT_ONCE_SQL =
  "SELECT * FROM (SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.interval_id " +
  "ORDER BY CASE WHEN m.end_cause IN ('opening_balance', 'carried_forward') " +
  "THEN m.mirrored_at_ms ELSE 0 END ASC, " +
  "CASE WHEN m.end_cause IN ('opening_balance', 'carried_forward') " +
  "THEN m.duration_ms ELSE -m.duration_ms END ASC, " +
  "m.mirrored_at_ms DESC, m.origin_node_id, m.origin_incarnation) AS rn " +
  "FROM thinking_intervals_mirror m WHERE m.hapi_session_id = ? AND m.namespace = ?) " +
  "WHERE rn = 1";

function toCursor(row: CursorRow): IntervalMirrorCursor {
  return {
    originNodeId: row.origin_node_id,
    originIncarnation: row.origin_incarnation,
    cursor: row.cursor,
    feedState: row.feed_state === "ok" ? "ok" : "unsupported",
    originMode: row.origin_mode,
    lastOriginMaxSeq: row.last_origin_max_seq,
    lastSyncAtMs: row.last_sync_at_ms,
    lastAttemptAtMs: row.last_attempt_at_ms,
  };
}

function rowField<T>(rowJson: string, key: string, fallback: T): T {
  try {
    const parsed = JSON.parse(rowJson) as Record<string, unknown>;
    const value = parsed[key];
    return (value as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function toRecord(row: MirrorRow): IntervalRecord {
  return {
    id: row.interval_id,
    hapiSessionId: row.hapi_session_id,
    namespace: row.namespace,
    nodeId: row.origin_node_id,
    launcherKind: row.launcher_kind,
    recordedMode: rowField(row.row_json, "recorded_mode", ""),
    stretchStartedAtMs: rowField(
      row.row_json,
      "stretch_started_at_ms",
      row.started_at_ms
    ),
    startedAtMs: row.started_at_ms,
    lastSeenAtMs: rowField(row.row_json, "last_seen_at_ms", row.ended_at_ms),
    endedAtMs: row.ended_at_ms,
    durationMs: row.duration_ms,
    startCause: rowField(row.row_json, "start_cause", ""),
    endCause: row.end_cause,
    sessionName: rowField<string | null>(row.row_json, "session_name", null),
    linkedIssue: rowField<string | null>(row.row_json, "linked_issue", null),
    cwd: rowField<string | null>(row.row_json, "cwd", null),
    changeSeq: row.origin_change_seq,
  };
}

function isBalance(endCause: string): boolean {
  return (BALANCE_END_CAUSES as readonly string[]).includes(endCause);
}

interface CapKey {
  fromStartedAt: number;
  shadowMs: number;
}

/**
 * The cap's key in a carried row's `flags` (issue #6651, Task C1), or null: no
 * flags, flags that are not JSON, no `cap.v === 1`, or a `fromStartedAt` or
 * `shadowMs` that is not an integer of 0 or more. A null key counts the carried
 * amount uncapped.
 */
function capKeyOf(rowJson: string): CapKey | null {
  const flags = rowField<unknown>(rowJson, "flags", null);
  if (typeof flags !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(flags);
  } catch {
    return null;
  }
  const cap =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { cap?: unknown }).cap
      : undefined;
  if (cap === null || typeof cap !== "object") return null;
  const { v, fromStartedAt, shadowMs } = cap as Record<string, unknown>;
  const count = (x: unknown): x is number =>
    typeof x === "number" && Number.isInteger(x) && x >= 0;
  if (v !== 1 || !count(fromStartedAt) || !count(shadowMs)) return null;
  return { fromStartedAt, shadowMs };
}

export class IntervalMirrorStore {
  constructor(private readonly db: Database) {}

  // ───────────── feed readers (this node's local rows) ─────────────

  /**
   * Closed local rows with `change_seq > cursor`, ascending, cut at the byte
   * budget while always keeping at least one row. Balance rows and the rows of
   * deleted sessions are closed rows and are served (the feed does not join
   * `sessions`).
   */
  getFeedPage(
    cursor: number,
    limit: number,
    maxBytes: number = FEED_PAGE_BYTE_BUDGET
  ): MirrorIntervalRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM thinking_intervals WHERE change_seq > ? " +
          "AND ended_at_ms IS NOT NULL ORDER BY change_seq ASC LIMIT ?"
      )
      .all(cursor, limit) as Array<Record<string, unknown>>;
    const page: MirrorIntervalRow[] = [];
    let bytes = 0;
    for (const r of rows) {
      const rowJson = JSON.stringify(r);
      bytes += Buffer.byteLength(rowJson, "utf8");
      if (page.length > 0 && bytes > maxBytes) break;
      page.push({
        intervalId: String(r.id),
        changeSeq: Number(r.change_seq),
        hapiSessionId: String(r.hapi_session_id),
        namespace: String(r.namespace),
        launcherKind: String(r.launcher_kind),
        startedAtMs: Number(r.started_at_ms),
        endedAtMs: Number(r.ended_at_ms),
        durationMs: Number(r.duration_ms ?? 0),
        endCause: String(r.end_cause ?? ""),
        rowJson,
      });
    }
    return page;
  }

  /** The largest `change_seq` over closed rows: exactly what the feed can serve. */
  getMaxClosedChangeSeq(): number {
    return (
      this.db
        .prepare(
          "SELECT COALESCE(MAX(change_seq), 0) AS m FROM thinking_intervals WHERE ended_at_ms IS NOT NULL"
        )
        .get() as { m: number }
    ).m;
  }

  // ───────────── mirror writes ─────────────

  /**
   * Upsert mirrored intervals. A dated row whose incoming `duration_ms` is smaller
   * than the stored one keeps its stored values and updates only
   * `origin_change_seq` and `mirrored_at_ms`. A stored balance row
   * (`opening_balance`, `carried_forward`) is kept whole when it arrives again,
   * every column included (keep-held, issue #6651).
   */
  upsertMirrorIntervals(
    originNodeId: string,
    incarnation: string,
    rows: MirrorIntervalRow[],
    nowMs: number
  ): void {
    if (rows.length === 0) return;
    const txn = this.db.transaction(() =>
      this.writeMirrorRows(originNodeId, incarnation, rows, nowMs)
    );
    txn.immediate();
  }

  /** The upsert itself, without a transaction of its own (callers hold one). */
  private writeMirrorRows(
    originNodeId: string,
    incarnation: string,
    rows: MirrorIntervalRow[],
    nowMs: number
  ): void {
    // Keep-held (#6651): a stored balance row keeps every column. SET reads the
    // stored row's values as they were before this update, so `end_cause` below
    // is the stored cause in every clause.
    const storedBalance =
      "thinking_intervals_mirror.end_cause IN ('opening_balance', 'carried_forward')";
    const keep = (col: string) =>
      `${col} = CASE WHEN ${storedBalance} THEN thinking_intervals_mirror.${col} ` +
      `WHEN excluded.duration_ms < thinking_intervals_mirror.duration_ms ` +
      `THEN thinking_intervals_mirror.${col} ELSE excluded.${col} END`;
    const latest = (col: string) =>
      `${col} = CASE WHEN ${storedBalance} THEN thinking_intervals_mirror.${col} ` +
      `ELSE excluded.${col} END`;
    const stmt = this.db.prepare(
      "INSERT INTO thinking_intervals_mirror (origin_node_id, origin_incarnation, " +
        "interval_id, origin_change_seq, hapi_session_id, namespace, launcher_kind, " +
        "started_at_ms, ended_at_ms, duration_ms, end_cause, row_json, mirrored_at_ms) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (origin_node_id, origin_incarnation, interval_id) DO UPDATE SET " +
        latest("origin_change_seq") +
        ", " +
        latest("mirrored_at_ms") +
        ", " +
        [
          "hapi_session_id",
          "namespace",
          "launcher_kind",
          "started_at_ms",
          "ended_at_ms",
          "row_json",
          "end_cause",
        ]
          .map(keep)
          .join(", ") +
        `, duration_ms = CASE WHEN ${storedBalance} THEN thinking_intervals_mirror.duration_ms ` +
        "ELSE MAX(excluded.duration_ms, thinking_intervals_mirror.duration_ms) END"
    );
    for (const r of rows) {
      stmt.run(
        originNodeId,
        incarnation,
        r.intervalId,
        r.changeSeq,
        r.hapiSessionId,
        r.namespace,
        r.launcherKind,
        r.startedAtMs,
        r.endedAtMs,
        r.durationMs,
        r.endCause,
        r.rowJson,
        nowMs
      );
    }
  }

  getCursor(originNodeId: string): IntervalMirrorCursor | null {
    const row = this.db
      .prepare(
        "SELECT * FROM thinking_interval_mirror_cursor WHERE origin_node_id = ?"
      )
      .get(originNodeId) as CursorRow | null;
    return row ? toCursor(row) : null;
  }

  /**
   * An origin without the feed: record `unsupported` and the attempt, keeping the
   * stored incarnation, cursor, mode and sync time. A first row starts empty.
   */
  markUnsupported(originNodeId: string, nowMs: number): void {
    this.db
      .prepare(
        "INSERT INTO thinking_interval_mirror_cursor (origin_node_id, origin_incarnation, " +
          "cursor, feed_state, last_attempt_at_ms) VALUES (?, '', 0, 'unsupported', ?) " +
          "ON CONFLICT (origin_node_id) DO UPDATE SET feed_state = 'unsupported', " +
          "last_attempt_at_ms = excluded.last_attempt_at_ms"
      )
      .run(originNodeId, nowMs);
  }

  /** A failed attempt moves only `last_attempt_at_ms`, and only when a row exists. */
  noteAttempt(originNodeId: string, nowMs: number): void {
    this.db
      .prepare(
        "UPDATE thinking_interval_mirror_cursor SET last_attempt_at_ms = ? WHERE origin_node_id = ?"
      )
      .run(nowMs, originNodeId);
  }

  /** Resync: cursor to 0 under the page's incarnation; every mirror row is kept. */
  resetCursor(originNodeId: string, incarnation: string, nowMs: number): void {
    this.db
      .prepare(
        "INSERT INTO thinking_interval_mirror_cursor (origin_node_id, origin_incarnation, " +
          "cursor, feed_state, last_attempt_at_ms) VALUES (?, ?, 0, 'ok', ?) " +
          "ON CONFLICT (origin_node_id) DO UPDATE SET origin_incarnation = excluded.origin_incarnation, " +
          "cursor = 0, last_attempt_at_ms = excluded.last_attempt_at_ms"
      )
      .run(originNodeId, incarnation, nowMs);
  }

  /** Apply one parsed page: its rows, then the cursor row, in one transaction. */
  applyPage(originNodeId: string, page: IntervalFeedPage, nowMs: number): void {
    const txn = this.db.transaction(() => {
      this.writeMirrorRows(
        originNodeId,
        page.incarnation,
        page.intervals,
        nowMs
      );
      this.db
        .prepare(
          "INSERT INTO thinking_interval_mirror_cursor (origin_node_id, origin_incarnation, " +
            "cursor, feed_state, origin_mode, last_origin_max_seq, last_sync_at_ms, " +
            "last_attempt_at_ms) VALUES (?, ?, ?, 'ok', ?, ?, ?, ?) " +
            "ON CONFLICT (origin_node_id) DO UPDATE SET " +
            "origin_incarnation = excluded.origin_incarnation, cursor = excluded.cursor, " +
            "feed_state = 'ok', origin_mode = excluded.origin_mode, " +
            "last_origin_max_seq = excluded.last_origin_max_seq, " +
            "last_sync_at_ms = excluded.last_sync_at_ms, " +
            "last_attempt_at_ms = excluded.last_attempt_at_ms"
        )
        .run(
          originNodeId,
          page.incarnation,
          page.nextCursor,
          page.mode,
          page.maxChangeSeq,
          nowMs,
          nowMs
        );
    });
    txn.immediate();
  }

  // ───────────── mirror readers (for /api/billable-time) ─────────────

  /** The distinct namespaces of the session's rows, balance rows included, local and mirrored. */
  namespacesForSession(sessionId: string): {
    local: string[];
    mirror: string[];
  } {
    const read = (table: string) =>
      (
        this.db
          .prepare(
            `SELECT DISTINCT namespace FROM ${table} WHERE hapi_session_id = ?`
          )
          .all(sessionId) as Array<{ namespace: string }>
      ).map(r => r.namespace);
    return {
      local: read("thinking_intervals"),
      mirror: read("thinking_intervals_mirror"),
    };
  }

  private countedRows(sessionId: string, namespace: string): MirrorRow[] {
    return this.db
      .prepare(COUNT_ONCE_SQL)
      .all(sessionId, namespace) as MirrorRow[];
  }

  /** The session's mirrored closed dated rows overlapping the range, oldest first. */
  listForSession(
    sessionId: string,
    namespace: string,
    range: { fromMs?: number; toMs?: number } = {}
  ): IntervalRecord[] {
    const fromMs = range.fromMs ?? Number.MIN_SAFE_INTEGER;
    const toMs = range.toMs ?? Number.MAX_SAFE_INTEGER;
    return this.countedRows(sessionId, namespace)
      .filter(
        r =>
          !isBalance(r.end_cause) &&
          r.started_at_ms < toMs &&
          r.ended_at_ms > fromMs
      )
      .sort(
        (a, b) =>
          a.started_at_ms - b.started_at_ms ||
          (a.interval_id < b.interval_id ? -1 : 1)
      )
      .map(toRecord);
  }

  /**
   * The counted amount of each counted balance row (the cap, issue #6651; plan
   * section 12 (i)). A `carried_forward` row whose flags hold the cap's key is
   * counted at its amount less the `shadow` time this node holds in its window
   * beyond what the carrying copy held there (`shadowMs`), never below zero. The
   * window is the session's counted dated rows recorded in `shadow` that started
   * at or after the key's `fromStartedAt` and before the carried row's own start
   * (its copy's boot time); `started_at_ms` never changes for a row, so a row
   * closed again later stays in its window. Every other balance row, an
   * `opening_balance` included, is counted at its stored amount. The rows are
   * those `countedRows` returns, so a dated row stored under two keys is in the
   * window once.
   */
  private balanceAmounts(rows: MirrorRow[]): number[] {
    const keyed = rows
      .filter(r => r.end_cause === "carried_forward")
      .map(r => ({ r, key: capKeyOf(r.row_json) }));
    const shadowRows = keyed.some(k => k.key !== null)
      ? rows.filter(
          r =>
            !isBalance(r.end_cause) &&
            rowField<string>(r.row_json, "recorded_mode", "") === "shadow"
        )
      : [];
    const amounts: number[] = [];
    for (const r of rows) {
      if (!isBalance(r.end_cause)) continue;
      const key = keyed.find(k => k.r === r)?.key ?? null;
      if (key === null) {
        amounts.push(r.duration_ms);
        continue;
      }
      let windowMs = 0;
      for (const d of shadowRows) {
        if (
          d.started_at_ms >= key.fromStartedAt &&
          d.started_at_ms < r.started_at_ms
        )
          windowMs += d.duration_ms;
      }
      const extra = Math.max(0, windowMs - key.shadowMs);
      amounts.push(Math.max(0, r.duration_ms - extra));
    }
    return amounts;
  }

  sessionTotals(sessionId: string, namespace: string): MirrorSessionTotals {
    let intervalsMs = 0;
    const intervalsMsByLauncher: Record<string, number> = {};
    let latest: MirrorRow | null = null;
    const rows = this.countedRows(sessionId, namespace);
    const carriedForwardMs = this.balanceAmounts(rows).reduce(
      (a, b) => a + b,
      0
    );
    for (const r of rows) {
      if (latest === null || r.mirrored_at_ms > latest.mirrored_at_ms)
        latest = r;
      if (!isBalance(r.end_cause)) {
        intervalsMs += r.duration_ms;
        intervalsMsByLauncher[r.launcher_kind] =
          (intervalsMsByLauncher[r.launcher_kind] ?? 0) + r.duration_ms;
      }
    }
    return {
      intervalsMs,
      intervalsMsByLauncher,
      carriedForwardMs,
      totalMs: intervalsMs + carriedForwardMs,
      originNodeId: latest?.origin_node_id ?? null,
    };
  }

  /** Day portions of the session's mirrored closed dated rows, clipped to the range. */
  billableByLocalDay(query: {
    namespace: string;
    sessionId: string;
    fromMs: number;
    toMs: number;
    timezone: string;
  }): BillableDays {
    const byDay = new Map<string, number>();
    const rows = this.countedRows(query.sessionId, query.namespace);
    const carriedForwardMs = this.balanceAmounts(rows).reduce(
      (a, b) => a + b,
      0
    );
    for (const r of rows) {
      if (isBalance(r.end_cause)) continue;
      if (!(r.started_at_ms < query.toMs && r.ended_at_ms > query.fromMs))
        continue;
      const portions = splitIntervalByLocalDay(
        Math.max(r.started_at_ms, query.fromMs),
        Math.min(r.started_at_ms + r.duration_ms, query.toMs),
        query.timezone
      );
      for (const p of portions)
        byDay.set(p.localDate, (byDay.get(p.localDate) ?? 0) + p.ms);
    }
    const days = [...byDay.entries()]
      .map(([localDate, ms]) => ({ localDate, ms }))
      .sort((a, b) =>
        a.localDate < b.localDate ? -1 : a.localDate > b.localDate ? 1 : 0
      );
    return { days, carriedForwardMs };
  }

  getOriginState(originNodeId: string): {
    feedState: MirrorFeedState;
    originMode: string | null;
    lastSyncAtMs: number | null;
  } | null {
    const cursor = this.getCursor(originNodeId);
    return cursor
      ? {
          feedState: cursor.feedState,
          originMode: cursor.originMode,
          lastSyncAtMs: cursor.lastSyncAtMs,
        }
      : null;
  }
}
