// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Issue #6204 (plan 3.2, 3.3, 6; Task 5): the time-entry rows as SQLite holds
 * them, their mappers to the wire forms of `shared/src/timeEntries.ts`, the
 * column lists `TimeEntryStore`'s inserts use (from the schema's one
 * definition), an entry's value, its turn overlap and the list's opaque
 * cursor. Pure: no statement here writes, so the one-writer walk sees every
 * write in `timeEntryStore.ts` alone.
 */
import {
  BILLING_RATE_MINOR_MAX,
  entryValueMinor,
  isBillingCurrency,
  type BillableSwitchActor,
  type TimeEntry,
  type TimeEntryEvent,
  type TimeEntryFilter,
  type TimeEntryValueReason,
  type TrackingRecord,
} from "@hapi/protocol";
import { TIME_ENTRY_TABLE_COLUMNS, type TimeEntryTable } from "./schema";

/** A turn of the session, for the entry's overlap list (R3; evidence only). */
export type MeasuredTurn = { id: string; startMs: number; endMs: number };

/** Who wrote it (#6646's actor: a person is `client`, an agent is `session`). */
export type TimeEntryActor = BillableSwitchActor;

/** A value outside its domain: the write is refused and rolled back. */
export class TimeEntryDomainError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string
  ) {
    super(`time entries: ${field} ${reason}`);
    this.name = "TimeEntryDomainError";
  }
}

// ---------------------------------------------------------------------------
// Rows

export type Bind = string | number | null;

export type EntryRow = {
  id: string;
  namespace: string;
  session_id: string;
  ordinal: number | null;
  origin_node_id: string;
  kind: string;
  refers_to: string | null;
  source: string;
  night: string | null;
  work_date: string;
  zone: string;
  late: number;
  minutes: number;
  basis: string;
  basis_ms_json: string | null;
  read_from_at: number | null;
  read_to_at: number | null;
  epoch: number;
  measured_ms: number;
  carry_in_ms: number;
  carry_out_ms: number;
  period_event_id: number | null;
  period_begin_event_id: number | null;
  period_from: number | null;
  period_to: number | null;
  first_ms: number | null;
  last_ms: number | null;
  launcher_ms_json: string | null;
  turns_json: string | null;
  project_kind: string;
  project_key: string;
  project_name: string;
  repo_key: string | null;
  external_json: string | null;
  status_made: string;
  held: number;
  held_status: string | null;
  category_source: string | null;
  category_id: string | null;
  category_name: string | null;
  default_rate_minor: number | null;
  default_currency: string | null;
  rate_minor: number | null;
  currency: string | null;
  rate_note: string | null;
  complete: number;
  value_minor: number | null;
  value_reason: string | null;
  settles_baseline: number;
  session_name: string | null;
  logged_at: number;
  status: string;
  billable_since: string | null;
  current_project_kind: string;
  current_project_key: string;
  current_project_name: string;
  current_external_json: string | null;
  voided_by: string | null;
  last_event_id: number;
};

export type EventRow = {
  id: number;
  namespace: string;
  entry_id: string;
  kind: string;
  status_before: string | null;
  status_after: string | null;
  project_before_json: string | null;
  project_after_json: string | null;
  billable_since_before: string | null;
  billable_since_after: string | null;
  effective_date: string | null;
  zone: string | null;
  actor_kind: string;
  actor_session_id: string | null;
  actor_user_agent: string | null;
  via: string;
  note: string | null;
  source_event_id: number | null;
  at: number;
};

export type SyncRow = {
  entry_id: string;
  namespace: string;
  state: string;
  provider: string | null;
  connection_id: string | null;
  external_task_id: string | null;
  external_entry_id: string | null;
  task_link: string | null;
  entry_link: string | null;
  error_code: string | null;
  never_sent: number;
  updated_at: number;
};

export type CoverageRow = {
  lane: string;
  key: string;
  from_ms: number;
  to_ms: number;
  owner_id: string;
};

/** `INSERT INTO <table> (…) VALUES ($…)`: the columns of the one definition. */
function insertColumns(table: TimeEntryTable, skip: readonly string[] = []) {
  const cols = TIME_ENTRY_TABLE_COLUMNS[table].filter(c => !skip.includes(c));
  return {
    names: cols.join(", "),
    params: cols.map(c => `$${c}`).join(", "),
  };
}

export const ENTRY_COLS = insertColumns("time_entries");
export const EVENT_COLS = insertColumns("time_entry_events", ["id"]);
export const SYNC_COLS = insertColumns("time_entry_sync");

export const parseJson = (text: string | null): unknown =>
  text === null ? null : JSON.parse(text);
export const jsonOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

export function entryFromRow(row: EntryRow): TimeEntry {
  return {
    id: row.id,
    namespace: row.namespace,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    originNodeId: row.origin_node_id,
    kind: row.kind,
    refersTo: row.refers_to,
    source: row.source,
    night: row.night,
    workDate: row.work_date,
    zone: row.zone,
    late: row.late === 1,
    minutes: row.minutes,
    basis: row.basis,
    basisMs: parseJson(row.basis_ms_json) as TimeEntry["basisMs"],
    readFromAt: row.read_from_at,
    readToAt: row.read_to_at,
    epoch: row.epoch,
    measuredMs: row.measured_ms,
    carryInMs: row.carry_in_ms,
    carryOutMs: row.carry_out_ms,
    periodEventId: row.period_event_id,
    periodBeginEventId: row.period_begin_event_id,
    periodFrom: row.period_from,
    periodTo: row.period_to,
    firstMs: row.first_ms,
    lastMs: row.last_ms,
    launcherMs: parseJson(row.launcher_ms_json) as TimeEntry["launcherMs"],
    turns: parseJson(row.turns_json) as TimeEntry["turns"],
    projectKind: row.project_kind,
    projectKey: row.project_key,
    projectName: row.project_name,
    repoKey: row.repo_key,
    external: parseJson(row.external_json),
    statusMade: row.status_made,
    held: row.held === 1,
    heldStatus: row.held_status,
    categorySource: row.category_source,
    categoryId: row.category_id,
    categoryName: row.category_name,
    defaultRateMinor: row.default_rate_minor,
    defaultCurrency: row.default_currency,
    rateMinor: row.rate_minor,
    currency: row.currency,
    rateNote: row.rate_note,
    complete: row.complete === 1,
    valueMinor: row.value_minor,
    valueReason: row.value_reason,
    settlesBaseline: row.settles_baseline === 1,
    sessionName: row.session_name,
    loggedAt: row.logged_at,
    status: row.status,
    billableSince: row.billable_since,
    currentProjectKind: row.current_project_kind,
    currentProjectKey: row.current_project_key,
    currentProjectName: row.current_project_name,
    currentExternal: parseJson(row.current_external_json),
    voidedBy: row.voided_by,
    lastEventId: row.last_event_id,
  };
}

export function eventFromRow(row: EventRow): TimeEntryEvent {
  return {
    id: row.id,
    entryId: row.entry_id,
    kind: row.kind,
    statusBefore: row.status_before,
    statusAfter: row.status_after,
    projectBefore: parseJson(row.project_before_json),
    projectAfter: parseJson(row.project_after_json),
    billableSinceBefore: row.billable_since_before,
    billableSinceAfter: row.billable_since_after,
    effectiveDate: row.effective_date,
    zone: row.zone,
    actorKind: row.actor_kind,
    actorSessionId: row.actor_session_id,
    actorUserAgent: row.actor_user_agent,
    via: row.via,
    note: row.note,
    sourceEventId: row.source_event_id,
    at: row.at,
  };
}

// ---------------------------------------------------------------------------
// Values and overlaps

/** The overlap list keeps at most this many turn ids, then a count (Task 7). */
export const TURN_IDS_MAX = 200;

/** An entry's value, or why it has none (section 6; item 30). */
export function valueOf(
  minutes: number,
  rateMinor: number | null,
  currency: string | null
): { value: number | null; reason: TimeEntryValueReason | null } {
  if (rateMinor === null || currency === null) {
    return { value: null, reason: null };
  }
  if (!isBillingCurrency(currency)) {
    return { value: null, reason: "currency_unknown" };
  }
  if (
    !Number.isSafeInteger(rateMinor) ||
    rateMinor < 0 ||
    rateMinor > BILLING_RATE_MINOR_MAX
  ) {
    return { value: null, reason: "rate_out_of_range" };
  }
  return {
    value: entryValueMinor({ minutes, rateMinor, currency }),
    reason: null,
  };
}

/** A void's value: the stored value negated, never rounded again, never -0. */
export const negatedValue = (value: number | null): number | null =>
  value === null ? null : value === 0 ? 0 : -value;

/** The turns overlapping `[fromMs, toMs]`: ids, then a count past the cap. */
export function turnsOverlapping(
  turns: readonly MeasuredTurn[],
  fromMs: number,
  toMs: number
): unknown[] {
  const ids = turns
    .filter(t => t.startMs <= toMs && t.endMs >= fromMs)
    .map(t => t.id);
  if (ids.length <= TURN_IDS_MAX) return ids;
  return [...ids.slice(0, TURN_IDS_MAX), { more: ids.length - TURN_IDS_MAX }];
}

// ---------------------------------------------------------------------------
// The list's opaque cursor (item 42): the filters travel in it

export type CursorFilter = Omit<TimeEntryFilter, "cursor" | "limit">;
type Cursor = { f: CursorFilter; k: [string, string] };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(text: string): Cursor {
  try {
    const raw = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    if (
      raw !== null &&
      typeof raw === "object" &&
      typeof raw.f === "object" &&
      raw.f !== null &&
      Array.isArray(raw.k) &&
      raw.k.length === 2 &&
      raw.k.every((v: unknown) => typeof v === "string")
    ) {
      return raw as Cursor;
    }
  } catch {
    // falls through to the refusal
  }
  throw new TimeEntryDomainError("cursor", "is not a cursor of this list");
}

/** The project and external target an event's before or after records. */
export function projectJson(row: {
  current_project_kind: string;
  current_project_key: string;
  current_project_name: string;
  current_external_json: string | null;
}): string {
  return JSON.stringify({
    kind: row.current_project_kind,
    key: row.current_project_key,
    name: row.current_project_name,
    external: parseJson(row.current_external_json),
  });
}

export function actorColumns(actor: TimeEntryActor) {
  return {
    actor_kind: actor.kind,
    actor_session_id: actor.sessionId ?? null,
    actor_user_agent: actor.userAgent ?? null,
  };
}

/** The snapshot columns an entry copies from a record as measured (R4). */
export function snapshotColumns(record: TrackingRecord) {
  const external = jsonOrNull(record.sync);
  return {
    project_kind: record.projectKind,
    project_key: record.projectKey,
    project_name: record.projectName,
    external_json: external,
    category_source: record.categorySource,
    category_id: record.categoryId,
    category_name: record.categoryName,
    default_rate_minor: record.defaultRateMinor,
    default_currency: record.defaultCurrency,
    rate_minor: record.rateMinor,
    currency: record.currency,
    rate_note: record.rateNote,
    current_project_kind: record.projectKind,
    current_project_key: record.projectKey,
    current_project_name: record.projectName,
    current_external_json: external,
  };
}
