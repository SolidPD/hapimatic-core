// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  BILLABLE_SWITCH_KEY_KINDS,
  TRACKING_BILLING_STATUSES,
  TRACKING_ORIGINS,
  TrackingRecordSchema,
  partialBillableRecord,
  projectSwitch,
  timeBillingStatus,
  type BillableConfirm,
  type BillableSwitchEventKind,
  type TrackingBillingStatus,
  type TrackingOrigin,
  type TrackingRecord,
  type TrackingRecordDraft,
} from "@hapi/protocol";
import { isBillingCurrency, isTrackingRateMinor } from "@hapi/protocol";
import {
  insertBillableSwitchEvent,
  type BillableSwitchEventInsert,
} from "./billableSwitchStore";
import { safeJsonParse } from "./json";

// A session's time-tracking record (issue #6778, plan section 3). One row per
// tracked session in `billable_tracking_settings` (row present ⇔ tracked); the
// history is `billable_switch_events`, widened by four columns; `sessions.billable`
// and `billable_confirm` are a projection of the row. `writeTrackingState` is
// the ONE code that writes the row or the two columns
// (`server/src/billableSwitch/projectionWriters.test.ts` fails on any other).
// No foreign key to `sessions`: a record survives archive and deletion (R11).
// The SQL holds the key and NOT NULL only (ruling 10); the value domains live
// in the writer, which refuses a row outside them.

export const BILLABLE_TRACKING_TABLES = [
  "billable_tracking_settings",
  "billable_tracking_pending_starts",
  "billable_tracking_meta",
] as const;

/** The four columns PR-B adds to `billable_switch_events` (`Store` adds them). */
export const BILLABLE_TRACKING_EVENT_COLUMNS = [
  "settings_before_json",
  "settings_after_json",
  "origin",
  "track_from",
] as const;

const BILLABLE_TRACKING_DDL: Record<
  (typeof BILLABLE_TRACKING_TABLES)[number],
  string
> = {
  billable_tracking_settings: `
    CREATE TABLE IF NOT EXISTS billable_tracking_settings (
      session_id TEXT PRIMARY KEY,
      namespace TEXT NOT NULL,
      billing_status TEXT NOT NULL,
      confirm TEXT,
      project_kind TEXT NOT NULL,
      project_key TEXT NOT NULL,
      project_name TEXT NOT NULL,
      category_source TEXT,
      category_id TEXT,
      category_name TEXT,
      default_rate_minor INTEGER,
      default_currency TEXT,
      rate_minor INTEGER,
      currency TEXT,
      rate_note TEXT,
      sync_json TEXT,
      complete INTEGER NOT NULL,
      created_via TEXT NOT NULL,
      track_from INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_event_id INTEGER NOT NULL
    )`,
  billable_tracking_pending_starts: `
    CREATE TABLE IF NOT EXISTS billable_tracking_pending_starts (
      tag TEXT PRIMARY KEY,
      namespace TEXT,
      kind TEXT NOT NULL,
      context_json TEXT NOT NULL,
      entry_node_id TEXT,
      queued_at INTEGER NOT NULL,
      lost_at INTEGER,
      lost_reason TEXT
    )`,
  billable_tracking_meta: `
    CREATE TABLE IF NOT EXISTS billable_tracking_meta (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )`,
};

/**
 * Create the three tables, each statement in its own log-and-continue `try`
 * (DDL only: the Store's migrations write no row). A failure leaves the
 * readiness check false, so the gate stays off for the process.
 */
export function migrateBillableTrackingTables(db: Database): void {
  for (const table of BILLABLE_TRACKING_TABLES) {
    try {
      db.exec(BILLABLE_TRACKING_DDL[table]);
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE ${table} (#6778):`,
        error
      );
    }
  }
}

/** The three tables and the four event columns exist ("the schema is there"). */
export function hasBillableTrackingStorage(db: Database): boolean {
  try {
    const columns = db
      .prepare("PRAGMA table_info(billable_switch_events)")
      .all() as Array<{ name: string }>;
    const names = new Set(columns.map(c => c.name));
    if (!BILLABLE_TRACKING_EVENT_COLUMNS.every(c => names.has(c))) return false;
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?)`
      )
      .all(...BILLABLE_TRACKING_TABLES) as Array<{ name: string }>;
    return rows.length === BILLABLE_TRACKING_TABLES.length;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The row

type SettingsRow = {
  session_id: string;
  namespace: string;
  billing_status: string;
  confirm: string | null;
  project_kind: string;
  project_key: string;
  project_name: string;
  category_source: string | null;
  category_id: string | null;
  category_name: string | null;
  default_rate_minor: number | null;
  default_currency: string | null;
  rate_minor: number | null;
  currency: string | null;
  rate_note: string | null;
  sync_json: string | null;
  complete: number;
  created_via: string;
  track_from: number;
  created_at: number;
  updated_at: number;
  last_event_id: number;
};

/** A stored record with the row's own keys. */
export type StoredTrackingRecord = {
  sessionId: string;
  namespace: string;
  record: TrackingRecord;
  lastEventId: number;
};

function rowToRecord(row: SettingsRow): StoredTrackingRecord {
  const sync = safeJsonParse(row.sync_json);
  return {
    sessionId: row.session_id,
    namespace: row.namespace,
    lastEventId: row.last_event_id,
    record: {
      billingStatus: row.billing_status as TrackingBillingStatus,
      confirm: row.confirm === "pending" ? "pending" : null,
      projectKind: row.project_kind as TrackingRecord["projectKind"],
      projectKey: row.project_key,
      projectName: row.project_name,
      categorySource: row.category_source,
      categoryId: row.category_id,
      categoryName: row.category_name,
      defaultRateMinor: row.default_rate_minor,
      defaultCurrency: row.default_currency,
      rateMinor: row.rate_minor,
      currency: row.currency,
      rateNote: row.rate_note,
      sync:
        sync !== null && typeof sync === "object"
          ? (sync as TrackingRecord["sync"])
          : null,
      complete: row.complete === 1,
      createdVia: row.created_via as TrackingOrigin,
      trackFrom: row.track_from,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

/** A value outside its domain (3.1, ruling 10): the write is refused and rolled back. */
export class TrackingDomainError extends Error {
  constructor(readonly field: string) {
    super(`billable tracking: ${field} is outside its domain`);
    this.name = "TrackingDomainError";
  }
}

const isRate = (v: number | null): boolean =>
  v === null || isTrackingRateMinor(v);

/** Refuse a record any of whose values is outside its domain (3.1). */
export function checkTrackingDomains(r: TrackingRecordDraft): void {
  const fail = (field: string): never => {
    throw new TrackingDomainError(field);
  };
  if (
    !(TRACKING_BILLING_STATUSES as readonly string[]).includes(r.billingStatus)
  )
    fail("billingStatus");
  if (r.confirm !== null && r.confirm !== "pending") fail("confirm");
  if (!(BILLABLE_SWITCH_KEY_KINDS as readonly string[]).includes(r.projectKind))
    fail("projectKind");
  if (!r.projectKey || typeof r.projectName !== "string") fail("projectKey");
  if (!isRate(r.rateMinor)) fail("rateMinor");
  if (!isRate(r.defaultRateMinor)) fail("defaultRateMinor");
  if ((r.defaultRateMinor === null) !== (r.defaultCurrency === null))
    fail("defaultCurrency");
  if (r.currency !== null && !isBillingCurrency(r.currency)) fail("currency");
  if (r.defaultCurrency !== null && !isBillingCurrency(r.defaultCurrency))
    fail("defaultCurrency");
  if ((r.rateMinor === null) !== (r.currency === null)) fail("currency");
  const full =
    r.categorySource !== null &&
    r.categoryId !== null &&
    r.categoryName !== null &&
    r.rateMinor !== null &&
    r.currency !== null;
  if (r.complete && !full) fail("complete");
  if (!(TRACKING_ORIGINS as readonly string[]).includes(r.createdVia))
    fail("createdVia");
  if (!Number.isFinite(r.trackFrom)) fail("trackFrom");
}

const RECORD_KEYS: ReadonlyArray<keyof TrackingRecordDraft> = [
  "billingStatus",
  "confirm",
  "projectKind",
  "projectKey",
  "projectName",
  "categorySource",
  "categoryId",
  "categoryName",
  "defaultRateMinor",
  "defaultCurrency",
  "rateMinor",
  "currency",
  "rateNote",
  "sync",
  "complete",
  "createdVia",
  "trackFrom",
];

function sameRecord(
  a: TrackingRecordDraft | null,
  b: TrackingRecordDraft | null
): boolean {
  if (a === null || b === null) return a === b;
  return RECORD_KEYS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/** The history row's fields the caller decides; the writer fills the rest. */
export type TrackingEventFields = Omit<
  BillableSwitchEventInsert,
  | "namespace"
  | "sessionId"
  | "kind"
  | "reason"
  | "billableBefore"
  | "billableAfter"
  | "confirmBefore"
  | "confirmAfter"
  | "settingsBefore"
  | "settingsAfter"
  | "trackFrom"
  | "origin"
>;

export type TrackingWriteInput = {
  namespace: string;
  sessionId: string;
  /** The next record from the prior one (null: untracked, the row is deleted). */
  next: (prior: TrackingRecord | null) => TrackingRecordDraft | null;
  /** A start writes its `start` row whether or not anything changed. */
  start?: boolean;
  /** Write the history row even when nothing changed (the reconcile: one row per replayed row). */
  always?: boolean;
  /** The kind the caller names (the pair form of #6646's switch); else chosen from the projection (3.2). */
  kind?: BillableSwitchEventKind;
  /** The reason for the kind the writer chose (3.2). */
  reasonFor: (
    kind: BillableSwitchEventKind,
    prior: TrackingRecord | null
  ) => string;
  origin: TrackingOrigin;
  event: TrackingEventFields;
  /** When given, the session's highest history id must equal it (else `stale_token`). */
  token?: number;
  /** When given, refuse (`not_waiting`) a prior record that is not waiting. */
  requireWaiting?: boolean;
  now?: number;
};

export type TrackingWriteResult =
  | { ok: false; code: "stale_token"; token: number }
  | { ok: false; code: "not_waiting" }
  | {
      ok: true;
      changed: boolean;
      record: TrackingRecord | null;
      prior: TrackingRecord | null;
      before: { billable: boolean; billableConfirm: BillableConfirm };
      after: { billable: boolean; billableConfirm: BillableConfirm };
      projectionChanged: boolean;
      eventId: number | null;
      kind: BillableSwitchEventKind | null;
      token: number;
    };

function readRow(
  db: Database,
  sessionId: string,
  namespace: string
): StoredTrackingRecord | null {
  const row = db
    .prepare(
      "SELECT * FROM billable_tracking_settings WHERE session_id = ? AND namespace = ?"
    )
    .get(sessionId, namespace) as SettingsRow | null;
  return row == null ? null : rowToRecord(row);
}

function highestEventId(
  db: Database,
  sessionId: string,
  namespace: string
): number {
  const row = db
    .prepare(
      "SELECT MAX(id) AS id FROM billable_switch_events WHERE session_id = ? AND namespace = ?"
    )
    .get(sessionId, namespace) as { id: number | null } | null;
  return row?.id ?? 0;
}

/** The kind of a write from the projection it replaces (3.2's table). */
function kindFor(
  start: boolean,
  b: { billable: boolean; billableConfirm: BillableConfirm },
  a: { billable: boolean; billableConfirm: BillableConfirm }
): BillableSwitchEventKind {
  if (start) return "start";
  if (!b.billable && a.billable) return "on";
  if (b.billable && !a.billable)
    return b.billableConfirm === "pending" ? "reverse" : "off";
  if (
    b.billable &&
    a.billable &&
    b.billableConfirm === "pending" &&
    a.billableConfirm === null
  )
    return "keep";
  return "tracking";
}

/**
 * THE writer (3.3). Runs inside the caller's IMMEDIATE transaction: reads the
 * prior row; compares the token with the session's highest history id; refuses
 * a value outside its domain; upserts or deletes the row; sets the projection
 * on `sessions` (with `seq + 1`) only when it changes, so a settings-only write
 * leaves `sessions` and its `seq` alone; appends the history row with both
 * whole snapshots and the origin; points the row at that history row. A write
 * that changes nothing writes nothing (a start always writes its row).
 */
export function writeTrackingState(
  db: Database,
  input: TrackingWriteInput
): TrackingWriteResult {
  const { namespace, sessionId } = input;
  const now = input.now ?? Date.now();
  const stored = readRow(db, sessionId, namespace);
  const prior = stored?.record ?? null;
  const current = highestEventId(db, sessionId, namespace);
  if (input.token !== undefined && input.token !== current) {
    return { ok: false, code: "stale_token", token: current };
  }
  if (input.requireWaiting && prior?.confirm !== "pending") {
    return { ok: false, code: "not_waiting" };
  }
  const draft = input.next(prior);
  if (draft !== null) checkTrackingDomains(draft);
  const session = db
    .prepare(
      "SELECT billable, billable_confirm FROM sessions WHERE id = ? AND namespace = ?"
    )
    .get(sessionId, namespace) as {
    billable: number | null;
    billable_confirm: string | null;
  } | null;
  const before = {
    billable: session?.billable === 1,
    billableConfirm: (session?.billable_confirm === "pending"
      ? "pending"
      : null) as BillableConfirm,
  };
  const after = projectSwitch(draft);
  const projectionChanged =
    session != null &&
    (before.billable !== after.billable ||
      before.billableConfirm !== after.billableConfirm);
  if (
    !input.start &&
    !input.always &&
    sameRecord(prior, draft) &&
    !projectionChanged
  ) {
    return {
      ok: true,
      changed: false,
      record: prior,
      prior,
      before,
      after: before,
      projectionChanged: false,
      eventId: null,
      kind: null,
      token: current,
    };
  }
  const record: TrackingRecord | null =
    draft === null
      ? null
      : { ...draft, createdAt: prior?.createdAt ?? now, updatedAt: now };
  if (projectionChanged) {
    db.prepare(
      `UPDATE sessions SET billable = ?, billable_confirm = ?, seq = seq + 1
        WHERE id = ? AND namespace = ?`
    ).run(after.billable ? 1 : 0, after.billableConfirm, sessionId, namespace);
  }
  const kind = input.kind ?? kindFor(input.start === true, before, after);
  const eventId = insertBillableSwitchEvent(db, {
    ...input.event,
    namespace,
    sessionId,
    kind,
    reason: input.reasonFor(kind, prior),
    billableBefore: before.billable,
    billableAfter: after.billable,
    confirmBefore: before.billableConfirm,
    confirmAfter: after.billableConfirm,
    settingsBefore: prior,
    settingsAfter: record,
    origin: input.origin,
    trackFrom: record?.trackFrom ?? prior?.trackFrom ?? null,
    at: input.event.at ?? now,
  });
  if (record === null) {
    db.prepare(
      "DELETE FROM billable_tracking_settings WHERE session_id = ? AND namespace = ?"
    ).run(sessionId, namespace);
  } else {
    db.prepare(
      `INSERT INTO billable_tracking_settings (
         session_id, namespace, billing_status, confirm, project_kind, project_key,
         project_name, category_source, category_id, category_name,
         default_rate_minor, default_currency, rate_minor, currency, rate_note,
         sync_json, complete, created_via, track_from, created_at, updated_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET
         namespace = excluded.namespace, billing_status = excluded.billing_status,
         confirm = excluded.confirm, project_kind = excluded.project_kind,
         project_key = excluded.project_key, project_name = excluded.project_name,
         category_source = excluded.category_source, category_id = excluded.category_id,
         category_name = excluded.category_name,
         default_rate_minor = excluded.default_rate_minor,
         default_currency = excluded.default_currency, rate_minor = excluded.rate_minor,
         currency = excluded.currency, rate_note = excluded.rate_note,
         sync_json = excluded.sync_json, complete = excluded.complete,
         created_via = excluded.created_via, track_from = excluded.track_from,
         created_at = excluded.created_at, updated_at = excluded.updated_at,
         last_event_id = excluded.last_event_id`
    ).run(
      sessionId,
      namespace,
      record.billingStatus,
      record.confirm,
      record.projectKind,
      record.projectKey,
      record.projectName,
      record.categorySource,
      record.categoryId,
      record.categoryName,
      record.defaultRateMinor,
      record.defaultCurrency,
      record.rateMinor,
      record.currency,
      record.rateNote,
      record.sync === null ? null : JSON.stringify(record.sync),
      record.complete ? 1 : 0,
      record.createdVia,
      record.trackFrom,
      record.createdAt,
      record.updatedAt,
      eventId
    );
  }
  return {
    ok: true,
    changed: true,
    record,
    prior,
    before,
    after,
    projectionChanged,
    eventId,
    kind,
    token: eventId,
  };
}

// ---------------------------------------------------------------------------
// The history read (3.5)

type HistoryRow = {
  id: number;
  at: number;
  kind: string;
  reason: string | null;
  project_key: string | null;
  key_kind: string | null;
  billable_after: number | null;
  confirm_after: string | null;
  settings_after_json: string | null;
  origin: string | null;
  label_json: string | null;
};

export type TrackingSegment = {
  from: number;
  to: number | null;
  record: TrackingRecord | null;
  timeStatus: TrackingBillingStatus | null;
};

/** History rows already named for a record that does not parse (L5). */
const warnedSnapshots = new Set<number>();

function snapshot(
  json: string | null,
  eventId?: number
): TrackingRecord | null {
  if (json === null) return null;
  const parsed = TrackingRecordSchema.safeParse(safeJsonParse(json));
  if (parsed.success) return parsed.data as TrackingRecord;
  // Review finding L5: a stored record that does not parse reads as an
  // untracked stretch; say so once per row instead of in silence.
  if (eventId !== undefined && !warnedSnapshots.has(eventId)) {
    if (warnedSnapshots.size >= 10_000) warnedSnapshots.clear();
    warnedSnapshots.add(eventId);
    const issue = parsed.error.issues[0];
    console.warn(
      `[BillableTracking] history row ${eventId}: its stored record does not parse (${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "unreadable"}); the timeline reads that stretch as untracked`
    );
  }
  return null;
}

/** The record a row without a snapshot stands for: partial Billable or none. */
function legacyRecord(row: HistoryRow): TrackingRecord | null {
  if (row.billable_after !== 1) return null;
  const key = row.project_key ?? "Other";
  return {
    ...partialBillableRecord({
      project: {
        kind: row.key_kind === "repo" ? "repo" : "path",
        key,
        name: key,
      },
      createdVia: "reconciled",
      trackFrom: row.at,
    }),
    confirm: row.confirm_after === "pending" ? "pending" : null,
    createdAt: row.at,
    updatedAt: row.at,
  };
}

/** Segments in history-id order, each starting at max(previous start, at). */
export function buildTimeline(rows: readonly HistoryRow[]): TrackingSegment[] {
  const replayed = new Set<number>();
  for (const r of rows) {
    if (r.kind === "tracking" && r.reason === "reconciled") {
      const label = safeJsonParse(r.label_json) as {
        replayOf?: unknown;
      } | null;
      if (typeof label?.replayOf === "number") replayed.add(label.replayOf);
    }
  }
  const segments: TrackingSegment[] = [];
  for (const row of rows) {
    if (row.kind === "header-on" || row.kind === "header-off") continue;
    // A row the writer did not write (origin null: #6646's history, or a
    // previous binary's after a roll back) stands for a partial record or
    // none, unless a `reconciled` row replays it with the snapshots.
    if (row.origin === null && replayed.has(row.id)) continue;
    const record =
      row.origin !== null
        ? snapshot(row.settings_after_json, row.id)
        : legacyRecord(row);
    const last = segments[segments.length - 1];
    let from = last ? Math.max(last.from, row.at) : row.at;
    // "Include earlier time": a turn-on starts at its own track_from, over the
    // untracked stretch before it only, never over tracked time (R8).
    if (record && last && last.record === null && record.trackFrom < from) {
      from = Math.max(record.trackFrom, last.from);
      if (from <= last.from) segments.pop();
    } else if (record && !last && record.trackFrom < from) {
      from = record.trackFrom;
    }
    const prev = segments[segments.length - 1];
    if (prev) prev.to = from;
    segments.push({
      from,
      to: null,
      record,
      timeStatus: timeBillingStatus(record),
    });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// The store

export type PendingStartRow = {
  tag: string;
  namespace: string | null;
  kind: string;
  contextJson: string;
  entryNodeId: string | null;
  queuedAt: number;
  lostAt: number | null;
  lostReason: string | null;
};

export type TrackedSessionListing = {
  sessionId: string;
  namespace: string;
  source: "local" | "deleted" | "mirror";
};

export class BillableTrackingStore {
  constructor(private readonly db: Database) {}

  /** A session's current record, or null (untracked). */
  get(sessionId: string, namespace: string): StoredTrackingRecord | null {
    return readRow(this.db, sessionId, namespace);
  }

  /** The session's highest history id: the token of its next write (0 when none). */
  token(sessionId: string, namespace: string): number {
    return highestEventId(this.db, sessionId, namespace);
  }

  /** The writer in its own IMMEDIATE transaction. */
  write(input: TrackingWriteInput): TrackingWriteResult {
    return this.db
      .transaction(() => writeTrackingState(this.db, input))
      .immediate();
  }

  /**
   * Sessions whose two columns differ from their row's projection (3.3 proof
   * item 3). Driven by `sessions`, with a LEFT JOIN to the row: a session with
   * no row reads untracked, so its columns set count as a mismatch, and a row
   * whose session is gone is never counted.
   */
  projectionMismatches(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions s
           LEFT JOIN billable_tracking_settings t
             ON t.session_id = s.id AND t.namespace = s.namespace
          WHERE COALESCE(s.billable, 0) != (CASE WHEN t.billing_status = 'billable' THEN 1 ELSE 0 END)
             OR COALESCE(s.billable_confirm, '') != (CASE WHEN t.billing_status = 'billable' AND t.confirm = 'pending' THEN 'pending' ELSE '' END)`
      )
      .get() as { n: number };
    return row.n;
  }

  private historyRows(sessionId: string, namespace: string): HistoryRow[] {
    return this.db
      .prepare(
        `SELECT id, at, kind, reason, project_key, key_kind, billable_after,
                confirm_after, settings_after_json, origin, label_json
           FROM billable_switch_events
          WHERE session_id = ? AND namespace = ? ORDER BY id ASC`
      )
      .all(sessionId, namespace) as HistoryRow[];
  }

  /** The session's record over time, ordered by history id (3.5). */
  timeline(sessionId: string, namespace: string): TrackingSegment[] {
    return buildTimeline(this.historyRows(sessionId, namespace));
  }

  /** The record in force at `t`, or null (untracked then). */
  settingsAt(
    sessionId: string,
    namespace: string,
    t: number
  ): TrackingSegment | null {
    const segs = this.timeline(sessionId, namespace);
    return segs.find(s => s.from <= t && (s.to === null || t < s.to)) ?? null;
  }

  /**
   * Every session tracked at some moment in [fromMs, toMs): a current row, or a
   * history row in the range that carries a record, from this node and from its
   * copy of other nodes' history. Deleted sessions are included (R11).
   */
  listTrackedBetween(
    namespace: string,
    fromMs: number,
    toMs: number
  ): TrackedSessionListing[] {
    const out = new Map<string, TrackedSessionListing>();
    const local = this.db
      .prepare(
        `SELECT t.session_id AS id, s.id AS alive FROM billable_tracking_settings t
           LEFT JOIN sessions s ON s.id = t.session_id AND s.namespace = t.namespace
          WHERE t.namespace = ?
         UNION
         SELECT e.session_id AS id, s.id AS alive FROM billable_switch_events e
           LEFT JOIN sessions s ON s.id = e.session_id AND s.namespace = e.namespace
          WHERE e.namespace = ? AND e.session_id IS NOT NULL AND e.at >= ? AND e.at < ?
            AND (e.settings_after_json IS NOT NULL OR e.settings_before_json IS NOT NULL
                 OR e.billable_after = 1 OR e.billable_before = 1)`
      )
      .all(namespace, namespace, fromMs, toMs) as Array<{
      id: string;
      alive: string | null;
    }>;
    for (const r of local) {
      out.set(r.id, {
        sessionId: r.id,
        namespace,
        source: r.alive === null ? "deleted" : "local",
      });
    }
    const mirror = this.db
      .prepare(
        `SELECT DISTINCT session_id AS id, row_json FROM billable_switch_events_mirror
          WHERE namespace = ? AND session_id IS NOT NULL AND at >= ? AND at < ?`
      )
      .all(namespace, fromMs, toMs) as Array<{ id: string; row_json: string }>;
    for (const r of mirror) {
      if (out.has(r.id)) continue;
      const ev = safeJsonParse(r.row_json) as Record<string, unknown> | null;
      if (
        ev &&
        (ev.settingsAfter ||
          ev.settingsBefore ||
          ev.billableAfter === true ||
          ev.billableBefore === true)
      ) {
        out.set(r.id, { sessionId: r.id, namespace, source: "mirror" });
      }
    }
    return [...out.values()];
  }

  // ---- the durable pending start (4.2 row 10, ruling 6) -----------------

  putPendingStart(row: Omit<PendingStartRow, "lostAt" | "lostReason">): void {
    this.db
      .prepare(
        `INSERT INTO billable_tracking_pending_starts
           (tag, namespace, kind, context_json, entry_node_id, queued_at, lost_at, lost_reason)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT (tag) DO UPDATE SET namespace = excluded.namespace,
           kind = excluded.kind, context_json = excluded.context_json,
           entry_node_id = excluded.entry_node_id, queued_at = excluded.queued_at,
           lost_at = NULL, lost_reason = NULL`
      )
      .run(
        row.tag,
        row.namespace,
        row.kind,
        row.contextJson,
        row.entryNodeId,
        row.queuedAt
      );
  }

  getPendingStart(tag: string): PendingStartRow | null {
    const r = this.db
      .prepare("SELECT * FROM billable_tracking_pending_starts WHERE tag = ?")
      .get(tag) as {
      tag: string;
      namespace: string | null;
      kind: string;
      context_json: string;
      entry_node_id: string | null;
      queued_at: number;
      lost_at: number | null;
      lost_reason: string | null;
    } | null;
    if (r == null) return null;
    return {
      tag: r.tag,
      namespace: r.namespace,
      kind: r.kind,
      contextJson: r.context_json,
      entryNodeId: r.entry_node_id,
      queuedAt: r.queued_at,
      lostAt: r.lost_at,
      lostReason: r.lost_reason,
    };
  }

  deletePendingStart(tag: string): void {
    this.db
      .prepare("DELETE FROM billable_tracking_pending_starts WHERE tag = ?")
      .run(tag);
  }

  markPendingStartLost(tag: string, reason: string, at: number): void {
    this.db
      .prepare(
        "UPDATE billable_tracking_pending_starts SET lost_at = ?, lost_reason = ? WHERE tag = ? AND lost_at IS NULL"
      )
      .run(at, reason, tag);
  }

  /** Live entries queued before `before` (expired, not yet marked lost). */
  listExpiredPendingStarts(before: number): PendingStartRow[] {
    const tags = this.db
      .prepare(
        "SELECT tag FROM billable_tracking_pending_starts WHERE lost_at IS NULL AND queued_at < ?"
      )
      .all(before) as Array<{ tag: string }>;
    return tags
      .map(t => this.getPendingStart(t.tag))
      .filter((r): r is PendingStartRow => r !== null);
  }

  hasPendingStart(tag: string): boolean {
    return this.getPendingStart(tag)?.lostAt === null;
  }

  /** Drop lost entries marked before `before` (kept seven days for a late registration). */
  pruneLostPendingStarts(before: number): number {
    return this.db
      .prepare(
        "DELETE FROM billable_tracking_pending_starts WHERE lost_at IS NOT NULL AND lost_at < ?"
      )
      .run(before).changes;
  }

  // ---- the reconcile's watermark (3.3 item 4) -----------------------------

  getMeta(key: string): number | null {
    const r = this.db
      .prepare("SELECT value FROM billable_tracking_meta WHERE key = ?")
      .get(key) as { value: number } | null;
    return r?.value ?? null;
  }

  /** Write a value once; a later call leaves the first one. Returns the stored value. */
  setMetaOnce(key: string, value: number): number {
    this.db
      .prepare(
        "INSERT INTO billable_tracking_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING"
      )
      .run(key, value);
    return this.getMeta(key) ?? value;
  }
}
