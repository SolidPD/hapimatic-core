// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan 3.3, 8.1, 8.3; Task 5): the time-entry reads. Functions
 * over the database that write nothing; `TimeEntryStore` calls them, also
 * inside its own transactions (a write re-reads coverage and carry there).
 */
import type { Database } from "bun:sqlite";
import {
  TIME_ENTRY_LIST_LIMIT_DEFAULT,
  TIME_ENTRY_LIST_LIMIT_MAX,
  type TimeEntry,
  type TimeEntryDetail,
  type TimeEntryFilter,
  type TimeEntryListPage,
} from "@hapi/protocol";
import type { CoverageSpan } from "../../timeEntries/amount";
import {
  decodeCursor,
  encodeCursor,
  entryFromRow,
  eventFromRow,
  TimeEntryDomainError,
  type Bind,
  type CoverageRow,
  type CursorFilter,
  type EntryRow,
  type EventRow,
  type SyncRow,
} from "./timeEntryRows";

const MS_PER_MINUTE = 60_000;

/** Every coverage span of the session, entries' and exclusions' alike. */
export function readCoveredSpans(
  db: Database,
  namespace: string,
  sessionId: string
): CoverageSpan[] {
  const rows = db
    .prepare(
      `SELECT lane, key, from_ms, to_ms, owner_id FROM time_entry_coverage
        WHERE namespace = ? AND session_id = ? ORDER BY lane, key, from_ms`
    )
    .all(namespace, sessionId) as CoverageRow[];
  return rows.map(r => ({
    lane: r.lane as CoverageSpan["lane"],
    key: r.key,
    fromMs: r.from_ms,
    toMs: r.to_ms,
    ownerId: r.owner_id,
  }));
}

/**
 * The carried remainder: the `carry_out_ms` of the session's newest entry of
 * kind `time`, checked against the entries and their coverage, so it cannot
 * drift (3.3). A historical, void or relog row has no carry.
 */
export function readLastCarry(
  db: Database,
  namespace: string,
  sessionId: string
): number {
  const newest = db
    .prepare(
      `SELECT carry_out_ms FROM time_entries
        WHERE namespace = ? AND session_id = ? AND kind = 'time'
        ORDER BY ordinal DESC LIMIT 1`
    )
    .get(namespace, sessionId) as { carry_out_ms: number } | null;
  const sums = db
    .prepare(
      `SELECT COALESCE(SUM(measured_ms), 0) AS measured,
              COALESCE(SUM(minutes), 0) AS minutes
         FROM time_entries
        WHERE namespace = ? AND session_id = ? AND kind = 'time'`
    )
    .get(namespace, sessionId) as { measured: number; minutes: number };
  const covered = db
    .prepare(
      `SELECT COALESCE(SUM(c.to_ms - c.from_ms), 0) AS ms
         FROM time_entry_coverage c JOIN time_entries e ON e.id = c.owner_id
        WHERE c.namespace = ? AND c.session_id = ? AND e.kind = 'time'`
    )
    .get(namespace, sessionId) as { ms: number };
  const carry = newest?.carry_out_ms ?? 0;
  if (
    sums.measured !== sums.minutes * MS_PER_MINUTE + carry ||
    covered.ms !== sums.measured
  ) {
    throw new TimeEntryDomainError("carry", "does not match the coverage");
  }
  return carry;
}

export function readEntryDetail(
  db: Database,
  namespace: string,
  id: string
): TimeEntryDetail | null {
  const row = db
    .prepare(`SELECT * FROM time_entries WHERE namespace = ? AND id = ?`)
    .get(namespace, id) as EntryRow | null;
  if (row === null) return null;
  const events = db
    .prepare(
      `SELECT * FROM time_entry_events
        WHERE namespace = ? AND entry_id = ? ORDER BY id`
    )
    .all(namespace, id) as EventRow[];
  const coverage = db
    .prepare(
      `SELECT lane, key, from_ms, to_ms, owner_id FROM time_entry_coverage
        WHERE namespace = ? AND owner_id = ? ORDER BY lane, key, from_ms`
    )
    .all(namespace, id) as CoverageRow[];
  const sync = readSyncRow(db, namespace, id);
  return {
    entry: entryFromRow(row),
    events: events.map(eventFromRow),
    coverage: coverage.map(c => ({
      lane: c.lane,
      key: c.key,
      fromMs: c.from_ms,
      toMs: c.to_ms,
      ownerId: c.owner_id,
    })),
    sync:
      sync === null
        ? null
        : {
            state: sync.state,
            provider: sync.provider,
            connectionId: sync.connection_id,
            externalTaskId: sync.external_task_id,
            externalEntryId: sync.external_entry_id,
            taskLink: sync.task_link,
            entryLink: sync.entry_link,
            errorCode: sync.error_code,
            neverSent: sync.never_sent === 1,
            updatedAt: sync.updated_at,
          },
  };
}

/** The session's entries, every kind, in the order they were written. */
export function readSessionEntries(
  db: Database,
  namespace: string,
  sessionId: string
): TimeEntry[] {
  const rows = db
    .prepare(
      `SELECT * FROM time_entries WHERE namespace = ? AND session_id = ?
        ORDER BY logged_at, rowid`
    )
    .all(namespace, sessionId) as EntryRow[];
  return rows.map(entryFromRow);
}

/**
 * Entries by session, project, dates, status, category, sync state and
 * kind (R14; 8.1), in keyset pages of at most 500. `decidable: true` leaves
 * out both rows of every frozen pair (7.1). After the first page the
 * filters travel in the opaque cursor, which then replaces them.
 */
export function readEntryList(
  db: Database,
  namespace: string,
  filter: TimeEntryFilter
): TimeEntryListPage {
  const limit = Math.min(
    filter.limit ?? TIME_ENTRY_LIST_LIMIT_DEFAULT,
    TIME_ENTRY_LIST_LIMIT_MAX
  );
  let f: CursorFilter;
  let after: [string, string] | null = null;
  if (filter.cursor !== undefined) {
    const cursor = decodeCursor(filter.cursor);
    f = cursor.f;
    after = cursor.k;
  } else {
    const { cursor: _cursor, limit: _limit, ...rest } = filter;
    f = rest;
  }
  const dateCol = f.dateBy === "billable" ? "e.billable_since" : "e.work_date";
  const where: string[] = ["e.namespace = ?"];
  const binds: Bind[] = [namespace];
  const add = (clause: string, ...values: Bind[]) => {
    where.push(clause);
    binds.push(...values);
  };
  if (f.dateBy === "billable") add("e.billable_since IS NOT NULL");
  if (f.session !== undefined) add("e.session_id = ?", f.session);
  if (f.project !== undefined) add("e.current_project_key = ?", f.project);
  if (f.from !== undefined) add(`${dateCol} >= ?`, f.from);
  if (f.to !== undefined) add(`${dateCol} <= ?`, f.to);
  if (f.status !== undefined) add("e.status = ?", f.status);
  if (f.categorySource !== undefined && f.categoryId !== undefined) {
    add(
      "e.category_source = ? AND e.category_id = ?",
      f.categorySource,
      f.categoryId
    );
  }
  if (f.sync !== undefined) add("s.state = ?", f.sync);
  if (f.kind !== undefined) add("e.kind = ?", f.kind);
  if (f.decidable === true) add("e.voided_by IS NULL AND e.kind <> 'void'");
  if (after !== null) {
    add(
      `(${dateCol} > ? OR (${dateCol} = ? AND e.id > ?))`,
      after[0],
      after[0],
      after[1]
    );
  }
  const rows = db
    .prepare(
      `SELECT e.* FROM time_entries e
         LEFT JOIN time_entry_sync s ON s.entry_id = e.id
        WHERE ${where.join(" AND ")}
        ORDER BY ${dateCol}, e.id LIMIT ?`
    )
    .all(...binds, limit + 1) as EntryRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined
      ? encodeCursor({
          f,
          k: [
            (f.dateBy === "billable" ? last.billable_since : last.work_date) ??
              "",
            last.id,
          ],
        })
      : null;
  return { entries: page.map(entryFromRow), nextCursor };
}

export function readSyncRow(
  db: Database,
  namespace: string,
  entryId: string
): SyncRow | null {
  return db
    .prepare(
      `SELECT * FROM time_entry_sync WHERE namespace = ? AND entry_id = ?`
    )
    .get(namespace, entryId) as SyncRow | null;
}

/** The rows `figuresFor` reads besides the plan (8.3). */
export function readFigureRows(
  db: Database,
  namespace: string,
  sessionId: string
) {
  const unsynced = db
    .prepare(
      `SELECT COALESCE(SUM(e.minutes), 0) AS n FROM time_entries e
         JOIN time_entry_sync s ON s.entry_id = e.id
        WHERE e.namespace = ? AND e.session_id = ? AND e.kind <> 'void'
          AND s.state IN ('waiting', 'failed', 'change-pending')`
    )
    .get(namespace, sessionId) as { n: number };
  const excluded = db
    .prepare(
      `SELECT COALESCE(SUM(measured_ms), 0) AS ms FROM time_entry_exclusions
        WHERE namespace = ? AND session_id = ? AND released_at IS NULL`
    )
    .get(namespace, sessionId) as { ms: number };
  const mark = db
    .prepare(
      `SELECT baseline_ms, baseline_tracked, baseline_settled, epoch, confirmed_ms, confirmed_epoch, high_raw_ms FROM time_entry_timer_marks
        WHERE namespace = ? AND session_id = ?`
    )
    .get(namespace, sessionId) as {
    baseline_ms: number | null;
    baseline_tracked: number | null;
    baseline_settled: number;
    epoch: number;
    confirmed_ms: number | null;
    confirmed_epoch: number | null;
    high_raw_ms: number | null;
  } | null;
  const historical = db
    .prepare(
      `SELECT COALESCE(SUM(minutes), 0) AS n FROM time_entries
        WHERE namespace = ? AND session_id = ? AND kind = 'historical'`
    )
    .get(namespace, sessionId) as { n: number };
  return {
    unsyncedMinutes: unsynced.n,
    excludedMs: excluded.ms,
    mark,
    // A confirmed reading below its epoch's high-water: a fall no epoch has opened.
    markFallen:
      mark !== null &&
      mark.confirmed_ms !== null &&
      mark.high_raw_ms !== null &&
      mark.confirmed_epoch === mark.epoch &&
      mark.confirmed_ms < mark.high_raw_ms,
    historicalMinutes: historical.n,
  };
}
