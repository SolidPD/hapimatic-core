// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type {
  BillableSwitchEvent,
  BillableSwitchEventKind,
} from "@hapi/protocol";
import { safeJsonParse } from "./json";

// The copy of other nodes' billable switch events and its per-origin cursor
// (issue #6646, Task 7b), moved out of `billableSwitchStore.ts` by #6778 PR-B
// so that file stays under the line limit. Functions over the database; the
// store's methods of the same names delegate here, so no caller changed.

export type BillableSwitchMirrorEvent = BillableSwitchEvent & {
  originNodeId: string;
  mirrorSeq: number;
  mirroredAt: number;
};

export type BillableSwitchMirrorCursor = {
  originIncarnation: string;
  cursor: number;
  feedState: string;
  lastOriginMaxId: number | null;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
};

/**
 * The four fields #6778 PR-B added to a row (3.2). A copy made from a feed
 * that left them out (an older puller, or a page without `schema=2`) has none.
 */
const NEW_ROW_KEYS = ["settingsBefore", "settingsAfter", "origin", "trackFrom"];
const lacksAll = (table: string): string =>
  NEW_ROW_KEYS.map(k => `json_type(${table}.row_json, '$.${k}') IS NULL`).join(
    " AND "
  );
const hasAll = (table: string): string =>
  NEW_ROW_KEYS.map(
    k => `json_type(${table}.row_json, '$.${k}') IS NOT NULL`
  ).join(" AND ");

/**
 * Copy a page of another node's events. An event never changes, so a row
 * already copied collides on (origin, incarnation, event id, time) and is
 * skipped; an id a restored database issues again has another time and is
 * kept as a second row. One exception (#6778 PR-B, reviews S9 and H5): a stored
 * copy that lacks all four new fields is replaced when the same row arrives
 * with all four, so a row first copied without them is repaired by the
 * re-pull. Only `row_json` changes; the row keeps its copy sequence. Returns
 * how many rows were added or repaired.
 */
export function upsertMirrorEvents(
  db: Database,
  originNodeId: string,
  incarnation: string,
  rows: readonly BillableSwitchEvent[],
  now: number
): number {
  if (rows.length === 0) return 0;
  const run = db.transaction((): number => {
    const stmt = db.prepare(
      `INSERT INTO billable_switch_events_mirror (
         origin_node_id, origin_incarnation, event_id, namespace, session_id,
         kind, at, row_json, mirrored_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (origin_node_id, origin_incarnation, event_id, at)
       DO UPDATE SET row_json = excluded.row_json
       WHERE ${lacksAll("billable_switch_events_mirror")} AND ${hasAll("excluded")}`
    );
    let added = 0;
    for (const r of rows) {
      const res = stmt.run(
        originNodeId,
        incarnation,
        r.id,
        r.namespace,
        r.sessionId ?? null,
        r.kind,
        r.at,
        JSON.stringify(r),
        now
      );
      added += res.changes;
    }
    return added;
  });
  return run.immediate();
}

export function getMirrorCursor(
  db: Database,
  originNodeId: string
): BillableSwitchMirrorCursor | null {
  const row = db
    .prepare(
      `SELECT origin_incarnation, cursor, feed_state, last_origin_max_id,
              last_sync_at, last_attempt_at
         FROM billable_switch_event_mirror_cursor WHERE origin_node_id = ?`
    )
    .get(originNodeId) as {
    origin_incarnation: string;
    cursor: number;
    feed_state: string;
    last_origin_max_id: number | null;
    last_sync_at: number | null;
    last_attempt_at: number | null;
  } | null;
  if (row == null) return null;
  return {
    originIncarnation: row.origin_incarnation,
    cursor: row.cursor,
    feedState: row.feed_state,
    lastOriginMaxId: row.last_origin_max_id,
    lastSyncAt: row.last_sync_at,
    lastAttemptAt: row.last_attempt_at,
  };
}

export function setMirrorCursor(
  db: Database,
  originNodeId: string,
  cursor: BillableSwitchMirrorCursor
): void {
  db.prepare(
    `INSERT INTO billable_switch_event_mirror_cursor (
         origin_node_id, origin_incarnation, cursor, feed_state,
         last_origin_max_id, last_sync_at, last_attempt_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (origin_node_id) DO UPDATE SET
         origin_incarnation = excluded.origin_incarnation,
         cursor = excluded.cursor,
         feed_state = excluded.feed_state,
         last_origin_max_id = excluded.last_origin_max_id,
         last_sync_at = excluded.last_sync_at,
         last_attempt_at = excluded.last_attempt_at`
  ).run(
    originNodeId,
    cursor.originIncarnation,
    cursor.cursor,
    cursor.feedState,
    cursor.lastOriginMaxId,
    cursor.lastSyncAt,
    cursor.lastAttemptAt
  );
}

/**
 * The copied events of a session id; only `namespace`'s when given, and only
 * the kinds of `kindClause` (an `AND kind IN (…)` clause) when given. In the
 * origin's order (#6778 PR-B, reviews S10 and H11): by event id within one
 * origin and incarnation, never by `at` (a wall clock that can step back) or by
 * arrival. An incarnation's rows come in the order its first row arrived, and
 * a re-issued id's two rows by arrival.
 */
export function listMirrorEvents(
  db: Database,
  sessionId: string,
  namespace?: string,
  kindClause = ""
): BillableSwitchMirrorEvent[] {
  const where =
    namespace === undefined
      ? "session_id = ?"
      : "session_id = ? AND namespace = ?";
  const rows = db
    .prepare(
      `SELECT *, MIN(mirror_seq) OVER (
                PARTITION BY origin_node_id, origin_incarnation
              ) AS incarnation_first
         FROM billable_switch_events_mirror
        WHERE ${where}${kindClause}
        ORDER BY incarnation_first ASC, event_id ASC, mirror_seq ASC`
    )
    .all(
      ...(namespace === undefined ? [sessionId] : [sessionId, namespace])
    ) as MirrorRow[];
  return rows
    .map(mirrorRowToEvent)
    .filter((e): e is BillableSwitchMirrorEvent => e !== null);
}

/** The `at` of each copied row with this origin, incarnation and event id (S14). */
export function getMirrorEventAts(
  db: Database,
  originNodeId: string,
  incarnation: string,
  eventId: number
): number[] {
  const rows = db
    .prepare(
      `SELECT at FROM billable_switch_events_mirror
        WHERE origin_node_id = ? AND origin_incarnation = ? AND event_id = ?`
    )
    .all(originNodeId, incarnation, eventId) as Array<{ at: number }>;
  return rows.map(r => r.at);
}

/**
 * A namespace's copied events after a mirror sequence, by arrival: this is a
 * cursor feed whose cursor is the copy sequence, so it stays in arrival order
 * (#6778 PR-B); each row carries its origin and event id for a reader that
 * rebuilds an origin's order.
 */
export function listMirrorEventsSince(
  db: Database,
  namespace: string,
  afterMirrorSeq: number,
  filter: { clause: string; kinds: string[] },
  requestedLimit?: number
): BillableSwitchMirrorEvent[] {
  const limit = Math.max(1, Math.min(requestedLimit ?? 500, 1000));
  const rows = db
    .prepare(
      `SELECT * FROM billable_switch_events_mirror
        WHERE namespace = ? AND mirror_seq > ?${filter.clause}
        ORDER BY mirror_seq ASC LIMIT ${limit}`
    )
    .all(namespace, afterMirrorSeq, ...filter.kinds) as MirrorRow[];
  return rows
    .map(mirrorRowToEvent)
    .filter((e): e is BillableSwitchMirrorEvent => e !== null);
}

/** The namespaces under which copied events exist for a session id. */
export function mirrorNamespacesForSession(
  db: Database,
  sessionId: string
): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT namespace FROM billable_switch_events_mirror WHERE session_id = ?"
    )
    .all(sessionId) as Array<{ namespace: string }>;
  return rows.map(r => r.namespace);
}

/** The copied header events of a namespace, by arrival. */
export function listMirrorHeaderEvents(
  db: Database,
  namespace: string
): BillableSwitchMirrorEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM billable_switch_events_mirror
        WHERE namespace = ? AND kind IN ('header-on', 'header-off')
        ORDER BY mirror_seq ASC`
    )
    .all(namespace) as MirrorRow[];
  return rows
    .map(mirrorRowToEvent)
    .filter((e): e is BillableSwitchMirrorEvent => e !== null);
}

type MirrorRow = {
  mirror_seq: number;
  origin_node_id: string;
  origin_incarnation: string;
  event_id: number;
  namespace: string;
  session_id: string | null;
  kind: string;
  at: number;
  row_json: string;
  mirrored_at: number;
};

function mirrorRowToEvent(row: MirrorRow): BillableSwitchMirrorEvent | null {
  const parsed = safeJsonParse(row.row_json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return {
    ...(parsed as BillableSwitchEvent),
    // The columns win over the copied JSON for the keys the copy is indexed by.
    id: row.event_id,
    namespace: row.namespace,
    sessionId: row.session_id,
    kind: row.kind as BillableSwitchEventKind,
    at: row.at,
    originNodeId: row.origin_node_id,
    mirrorSeq: row.mirror_seq,
    mirroredAt: row.mirrored_at,
  };
}
