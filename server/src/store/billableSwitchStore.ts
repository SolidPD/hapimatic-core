// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  BILLABLE_SWITCH_EVENT_KINDS,
  BILLABLE_SWITCH_LEGACY_EVENT_KINDS,
  isBillableSwitchReasonForKind,
  type BillableConfirm,
  type BillableSwitchActorKind,
  type BillableSwitchEvent,
  type BillableSwitchEventKind,
  type BillableSwitchHeader,
  type BillableSwitchKeyKind,
  type BillableSwitchStartKind,
  type BillableSwitchVia,
  type OldRouteAction,
  type TrackingProject,
  type TrackingRecord,
  applyOldRoute,
  partialBillableRecord,
} from "@hapi/protocol";
import { safeJsonParse } from "./json";
import * as mirror from "./billableSwitchMirrorStore";
import { writeTrackingState } from "./billableTrackingStore";
import type {
  BillableSwitchMirrorCursor,
  BillableSwitchMirrorEvent,
} from "./billableSwitchMirrorStore";

// The billable switch's storage (issue #6646, Task 3). Two columns on each
// node's own `sessions` row (`billable`, `billable_confirm`) and six tables:
// this node's header defaults, the last header report of every other node (two
// tables), the append-only event record, and the copy of other nodes' events
// with its per-origin cursor. Nothing here has a foreign key to `sessions`, so
// the record survives a session's deletion (OFF-2), and no retention loop
// sweeps any of these tables (rows are removed only by hand, the plan's
// Rollback step 4).
//
// Statements are prepared on use, never in the constructor (the `pinStore.ts`
// precedent): a constructor that prepared against an absent table would stop
// the server from starting on a database whose storage is not ready.

/** The six tables the readiness check requires. */
export const BILLABLE_SWITCH_TABLES = [
  "billable_switch_project_defaults",
  "billable_switch_peer_headers",
  "billable_switch_peer_reports",
  "billable_switch_events",
  "billable_switch_events_mirror",
  "billable_switch_event_mirror_cursor",
] as const;

const BILLABLE_SWITCH_TABLE_DDL: Record<
  (typeof BILLABLE_SWITCH_TABLES)[number],
  string
> = {
  billable_switch_project_defaults: `
    CREATE TABLE IF NOT EXISTS billable_switch_project_defaults (
      namespace TEXT NOT NULL,
      project_key TEXT NOT NULL,
      key_kind TEXT NOT NULL CHECK (key_kind IN ('repo','path')),
      billable INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (namespace, project_key)
    )`,
  billable_switch_peer_headers: `
    CREATE TABLE IF NOT EXISTS billable_switch_peer_headers (
      node_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      project_key TEXT NOT NULL,
      key_kind TEXT NOT NULL,
      billable INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (node_id, namespace, project_key)
    )`,
  billable_switch_peer_reports: `
    CREATE TABLE IF NOT EXISTS billable_switch_peer_reports (
      node_id TEXT PRIMARY KEY,
      node_label TEXT,
      reported_at INTEGER NOT NULL,
      header_count INTEGER NOT NULL
    )`,
  billable_switch_events: `
    CREATE TABLE IF NOT EXISTS billable_switch_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL,
      session_id TEXT,
      project_key TEXT,
      key_kind TEXT,
      kind TEXT NOT NULL,
      reason TEXT,
      start_kind TEXT,
      billable_before INTEGER,
      billable_after INTEGER,
      confirm_before TEXT,
      confirm_after TEXT,
      actor_kind TEXT NOT NULL,
      actor_session_id TEXT,
      actor_user_agent TEXT,
      via TEXT NOT NULL,
      entry_node_id TEXT,
      timer_ms INTEGER,
      unlogged_ms INTEGER,
      logged_known INTEGER NOT NULL DEFAULT 0,
      label_json TEXT,
      at INTEGER NOT NULL
    )`,
  billable_switch_events_mirror: `
    CREATE TABLE IF NOT EXISTS billable_switch_events_mirror (
      mirror_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_node_id TEXT NOT NULL,
      origin_incarnation TEXT NOT NULL,
      event_id INTEGER NOT NULL,
      namespace TEXT NOT NULL,
      session_id TEXT,
      kind TEXT NOT NULL,
      at INTEGER NOT NULL,
      row_json TEXT NOT NULL,
      mirrored_at INTEGER NOT NULL,
      UNIQUE (origin_node_id, origin_incarnation, event_id, at)
    )`,
  billable_switch_event_mirror_cursor: `
    CREATE TABLE IF NOT EXISTS billable_switch_event_mirror_cursor (
      origin_node_id TEXT PRIMARY KEY,
      origin_incarnation TEXT NOT NULL,
      cursor INTEGER NOT NULL,
      feed_state TEXT NOT NULL,
      last_origin_max_id INTEGER,
      last_sync_at INTEGER,
      last_attempt_at INTEGER
    )`,
};

const BILLABLE_SWITCH_INDEX_DDL = [
  "CREATE INDEX IF NOT EXISTS idx_billable_switch_events_session ON billable_switch_events(session_id, at)",
  "CREATE INDEX IF NOT EXISTS idx_billable_switch_events_ns ON billable_switch_events(namespace, id)",
  "CREATE INDEX IF NOT EXISTS idx_billable_switch_events_mirror_session ON billable_switch_events_mirror(session_id, at)",
  "CREATE INDEX IF NOT EXISTS idx_billable_switch_events_mirror_ns ON billable_switch_events_mirror(namespace, mirror_seq)",
];

/**
 * Create the six tables and their indexes, each statement in its own
 * log-and-continue `try`, so a failure can never stop the server from starting
 * (the readiness check then turns the gate off for the process). Idempotent.
 * Called from `Store.runMigrations` after the two `sessions` columns.
 */
export function migrateBillableSwitchTables(db: Database): void {
  for (const table of BILLABLE_SWITCH_TABLES) {
    try {
      db.exec(BILLABLE_SWITCH_TABLE_DDL[table]);
    } catch (error) {
      console.error(
        `[Store] Migration failed: CREATE TABLE ${table} (#6646):`,
        error
      );
    }
  }
  // A missing index is slow, not wrong: the readiness check leaves indexes out.
  for (const ddl of BILLABLE_SWITCH_INDEX_DDL) {
    try {
      db.exec(ddl);
    } catch (error) {
      console.error(`[Store] Migration failed: ${ddl} (#6646):`, error);
    }
  }
}

/**
 * True only when both `sessions` columns and all six `billable_switch_*`
 * tables exist. The Store's readiness check, and the test a script that opens
 * the database file itself runs before touching sessions (the cleanup script of
 * #6484, carry-over K20): it stops when this is false.
 */
export function hasBillableSwitchStorage(db: Database): boolean {
  try {
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map(c => c.name));
    if (!names.has("billable") || !names.has("billable_confirm")) return false;
    const placeholders = BILLABLE_SWITCH_TABLES.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
      )
      .all(...BILLABLE_SWITCH_TABLES) as Array<{ name: string }>;
    return rows.length === BILLABLE_SWITCH_TABLES.length;
  } catch {
    return false;
  }
}

// Readiness per database handle: the Store sets it once after its check, and
// every reader of a `sessions` row (`store/sessions.ts`) asks it, so the two
// fields are present on every summary of a ready node and absent on every
// summary of a node whose storage is not ready ("unknown", never "off").
const storageReadyByDb = new WeakMap<Database, boolean>();

export function setBillableSwitchStorageReady(
  db: Database,
  ready: boolean
): void {
  storageReadyByDb.set(db, ready);
}

export function isBillableSwitchStorageReady(db: Database): boolean {
  return storageReadyByDb.get(db) === true;
}

// ---------------------------------------------------------------------------
// Event rows

export type BillableSwitchLabel = Record<string, unknown>;

/** One event to append. `at` defaults to now. */
export type BillableSwitchEventInsert = {
  namespace: string;
  sessionId: string | null;
  projectKey: string | null;
  keyKind: BillableSwitchKeyKind | null;
  kind: BillableSwitchEventKind;
  reason: string;
  startKind?: BillableSwitchStartKind | null;
  billableBefore?: boolean | null;
  billableAfter?: boolean | null;
  confirmBefore?: BillableConfirm;
  confirmAfter?: BillableConfirm;
  actorKind: BillableSwitchActorKind;
  actorSessionId?: string | null;
  actorUserAgent?: string | null;
  via: BillableSwitchVia;
  entryNodeId?: string | null;
  timerMs?: number | null;
  unloggedMs?: number | null;
  loggedKnown?: boolean;
  label?: BillableSwitchLabel | null;
  at?: number;
  /** #6778 (3.2): the whole record before and after, the origin, the tracking start. */
  settingsBefore?: object | null;
  settingsAfter?: object | null;
  origin?: string | null;
  trackFrom?: number | null;
};

const boolToInt = (v: boolean | null | undefined): number | null =>
  v === null || v === undefined ? null : v ? 1 : 0;
const intToBool = (v: number | null | undefined): boolean | null =>
  v === null || v === undefined ? null : v === 1;
const asConfirm = (v: string | null | undefined): BillableConfirm =>
  v === "pending" ? "pending" : null;

/**
 * The `kind` clause of an event read. No filter, or an empty one, reads every
 * kind. A filter that names only kinds this build does not know reads nothing
 * (`null`): before #6778 (F2) its unknown kinds were dropped and the empty rest
 * read every kind, the opposite of what was asked.
 */
function kindFilter(
  requested: readonly string[] | undefined
): { clause: string; kinds: string[] } | null {
  if (!requested || requested.length === 0) return { clause: "", kinds: [] };
  const kinds = requested.filter(k =>
    (BILLABLE_SWITCH_EVENT_KINDS as readonly string[]).includes(k)
  );
  if (kinds.length === 0) return null;
  return {
    clause: ` AND kind IN (${kinds.map(() => "?").join(", ")})`,
    kinds,
  };
}

/**
 * Append one event. Throws when the kind and reason are not a pair of the
 * event table (section 6 item 3), so a bad pair rolls back the write it
 * belongs to. Returns the new id.
 */
export function insertBillableSwitchEvent(
  db: Database,
  ev: BillableSwitchEventInsert
): number {
  if (!isBillableSwitchReasonForKind(ev.kind, ev.reason)) {
    throw new Error(
      `billable switch: reason ${JSON.stringify(ev.reason)} is not allowed for kind ${JSON.stringify(ev.kind)}`
    );
  }
  const result = db
    .prepare(
      `INSERT INTO billable_switch_events (
         namespace, session_id, project_key, key_kind, kind, reason, start_kind,
         billable_before, billable_after, confirm_before, confirm_after,
         actor_kind, actor_session_id, actor_user_agent, via, entry_node_id,
         timer_ms, unlogged_ms, logged_known, label_json, at,
         settings_before_json, settings_after_json, origin, track_from
       ) VALUES (
         @namespace, @session_id, @project_key, @key_kind, @kind, @reason, @start_kind,
         @billable_before, @billable_after, @confirm_before, @confirm_after,
         @actor_kind, @actor_session_id, @actor_user_agent, @via, @entry_node_id,
         @timer_ms, @unlogged_ms, @logged_known, @label_json, @at,
         @settings_before_json, @settings_after_json, @origin, @track_from
       )`
    )
    .run({
      namespace: ev.namespace,
      session_id: ev.sessionId,
      project_key: ev.projectKey,
      key_kind: ev.keyKind,
      kind: ev.kind,
      reason: ev.reason,
      start_kind: ev.startKind ?? null,
      billable_before: boolToInt(ev.billableBefore),
      billable_after: boolToInt(ev.billableAfter),
      confirm_before: ev.confirmBefore ?? null,
      confirm_after: ev.confirmAfter ?? null,
      actor_kind: ev.actorKind,
      actor_session_id: ev.actorSessionId ?? null,
      actor_user_agent: ev.actorUserAgent ?? null,
      via: ev.via,
      entry_node_id: ev.entryNodeId ?? null,
      timer_ms: ev.timerMs ?? null,
      unlogged_ms: ev.unloggedMs ?? null,
      logged_known: ev.loggedKnown ? 1 : 0,
      label_json:
        ev.label === null || ev.label === undefined
          ? null
          : JSON.stringify(ev.label),
      at: ev.at ?? Date.now(),
      settings_before_json: ev.settingsBefore
        ? JSON.stringify(ev.settingsBefore)
        : null,
      settings_after_json: ev.settingsAfter
        ? JSON.stringify(ev.settingsAfter)
        : null,
      origin: ev.origin ?? null,
      track_from: ev.trackFrom ?? null,
    });
  return Number(result.lastInsertRowid);
}

type EventRow = {
  id: number;
  namespace: string;
  session_id: string | null;
  project_key: string | null;
  key_kind: string | null;
  kind: string;
  reason: string | null;
  start_kind: string | null;
  billable_before: number | null;
  billable_after: number | null;
  confirm_before: string | null;
  confirm_after: string | null;
  actor_kind: string;
  actor_session_id: string | null;
  actor_user_agent: string | null;
  via: string;
  entry_node_id: string | null;
  timer_ms: number | null;
  unlogged_ms: number | null;
  logged_known: number;
  label_json: string | null;
  at: number;
  settings_before_json?: string | null;
  settings_after_json?: string | null;
  origin?: string | null;
  track_from?: number | null;
};

const asObject = (json: string | null | undefined): object | null => {
  const v = safeJsonParse(json ?? null);
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
};

/** #6778 (6.3): the kinds and fields a build before PR-B can parse. */
export function toLegacyEvent(ev: BillableSwitchEvent): BillableSwitchEvent {
  const {
    settingsBefore: _b,
    settingsAfter: _a,
    origin: _o,
    trackFrom: _t,
    ...rest
  } = ev;
  return rest as BillableSwitchEvent;
}

const LEGACY_KIND_CLAUSE = ` AND kind IN (${BILLABLE_SWITCH_LEGACY_EVENT_KINDS.map(k => `'${k}'`).join(", ")})`;

function rowToEvent(row: EventRow): BillableSwitchEvent {
  const label = safeJsonParse(row.label_json);
  return {
    id: row.id,
    at: row.at,
    namespace: row.namespace,
    kind: row.kind as BillableSwitchEventKind,
    reason: row.reason,
    sessionId: row.session_id,
    projectKey: row.project_key,
    keyKind: (row.key_kind as BillableSwitchKeyKind | null) ?? null,
    startKind: (row.start_kind as BillableSwitchStartKind | null) ?? null,
    billableBefore: intToBool(row.billable_before),
    billableAfter: intToBool(row.billable_after),
    confirmBefore: asConfirm(row.confirm_before),
    confirmAfter: asConfirm(row.confirm_after),
    actor: {
      kind: row.actor_kind as BillableSwitchActorKind,
      sessionId: row.actor_session_id,
      userAgent: row.actor_user_agent,
    },
    via: row.via as BillableSwitchVia,
    entryNodeId: row.entry_node_id,
    timerMs: row.timer_ms,
    unloggedMs: row.unlogged_ms,
    loggedKnown: row.logged_known === 1,
    label:
      label !== null && typeof label === "object" && !Array.isArray(label)
        ? (label as Record<string, unknown>)
        : null,
    settingsBefore: asObject(row.settings_before_json) as Record<
      string,
      unknown
    > | null,
    settingsAfter: asObject(row.settings_after_json) as Record<
      string,
      unknown
    > | null,
    origin: row.origin ?? null,
    trackFrom: row.track_from ?? null,
  };
}

/** Upsert one header row of THIS node (no event: the caller writes it). */
export function upsertProjectDefaultRow(
  db: Database,
  namespace: string,
  projectKey: string,
  keyKind: BillableSwitchKeyKind,
  billable: boolean,
  now: number
): void {
  db.prepare(
    `INSERT INTO billable_switch_project_defaults
       (namespace, project_key, key_kind, billable, updated_at)
     VALUES (@namespace, @project_key, @key_kind, @billable, @updated_at)
     ON CONFLICT (namespace, project_key) DO UPDATE SET
       key_kind = excluded.key_kind,
       billable = excluded.billable,
       updated_at = excluded.updated_at`
  ).run({
    namespace,
    project_key: projectKey,
    key_kind: keyKind,
    billable: billable ? 1 : 0,
    updated_at: now,
  });
}

/** The header row of THIS node for a project, or null when it was never set. */
export function readProjectDefaultRow(
  db: Database,
  namespace: string,
  projectKey: string
): {
  billable: boolean;
  keyKind: BillableSwitchKeyKind;
  updatedAt: number;
} | null {
  const row = db
    .prepare(
      `SELECT billable, key_kind, updated_at FROM billable_switch_project_defaults
        WHERE namespace = ? AND project_key = ?`
    )
    .get(namespace, projectKey) as {
    billable: number;
    key_kind: string;
    updated_at: number;
  } | null;
  if (row == null) return null;
  return {
    billable: row.billable === 1,
    keyKind: row.key_kind as BillableSwitchKeyKind,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Types the store returns

export type BillableSwitchState = {
  billable: boolean;
  confirm: BillableConfirm;
};

/** The fields of a session event that the caller decides; the store fills the rest. */
export type BillableSwitchSessionEventFields = Omit<
  BillableSwitchEventInsert,
  | "namespace"
  | "sessionId"
  | "billableBefore"
  | "billableAfter"
  | "confirmBefore"
  | "confirmAfter"
  | "keyKind"
  | "projectKey"
> & { projectKey?: string | null; keyKind?: BillableSwitchKeyKind | null };

export type BillableSwitchSetResult =
  | { found: false }
  | {
      found: true;
      changed: boolean;
      before: BillableSwitchState;
      after: BillableSwitchState;
      eventId: number | null;
      /** #6778: the record after the write (null: untracked). */
      record?: TrackingRecord | null;
    };

/** An old-route write (#6778): also `notWaiting` for a Keep or Reverse of a record that is not waiting. */
export type BillableSwitchRouteResult =
  | BillableSwitchSetResult
  | { found: true; notWaiting: true };

export type BillableSwitchPeerReport = {
  nodeId: string;
  nodeLabel: string | null;
  reportedAt: number;
  headerCount: number;
  headers: BillableSwitchHeader[];
};

export type BillableSwitchListedSession = {
  sessionId: string;
  billable: boolean;
  confirm: BillableConfirm;
  lastEventId: number | null;
  lastEventAt: number | null;
};

export type {
  BillableSwitchMirrorCursor,
  BillableSwitchMirrorEvent,
} from "./billableSwitchMirrorStore";

const sameHeaders = (
  a: ReadonlyArray<
    Pick<
      BillableSwitchHeader,
      "namespace" | "projectKey" | "keyKind" | "billable"
    >
  >,
  b: ReadonlyArray<
    Pick<
      BillableSwitchHeader,
      "namespace" | "projectKey" | "keyKind" | "billable"
    >
  >
): boolean => {
  if (a.length !== b.length) return false;
  const key = (h: (typeof a)[number]) =>
    `${h.namespace}\u0000${h.projectKey}\u0000${h.keyKind}\u0000${h.billable ? 1 : 0}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
};

/** How often an unchanged report may refresh its `reported_at` (Task 4). */
export const BILLABLE_SWITCH_REPORT_REFRESH_MS = 60_000;

export class BillableSwitchStore {
  constructor(private readonly db: Database) {}

  /**
   * True when this database's switch storage passed the boot readiness check
   * (both columns and every billable_switch_* table). A loop that reads the
   * tables checks it before it starts (PR-2 item E3).
   */
  storageReady(): boolean {
    return isBillableSwitchStorageReady(this.db);
  }

  // ---- the switch ---------------------------------------------------------

  /** This session's switch, or null when the row does not exist. */
  getSwitch(sessionId: string): BillableSwitchState | null {
    const row = this.db
      .prepare("SELECT billable, billable_confirm FROM sessions WHERE id = ?")
      .get(sessionId) as {
      billable: number | null;
      billable_confirm: string | null;
    } | null;
    if (row == null) return null;
    return {
      billable: row.billable === 1,
      confirm: asConfirm(row.billable_confirm),
    };
  }

  /**
   * #6646's switch routes as a shorthand on the tracking record (#6778, 3.3,
   * C2 = a): one old-route action through the one writer
   * (`writeTrackingState`), in one IMMEDIATE transaction. "Waiting" is judged
   * on the record, any status; the kind (`on`, `off`, `keep`, `reverse`, or
   * `tracking` for a write that leaves the projection alone) is chosen inside
   * the transaction. A write that changes nothing writes nothing. A row of
   * another namespace is not found. `requireWaiting` (Keep and Reverse)
   * answers `notWaiting` for a record that is not waiting.
   */
  setByOldRoute(
    sessionId: string,
    namespace: string,
    input: {
      action: OldRouteAction;
      reason: string;
      requireWaiting?: boolean;
      /** The session's project and start, for a partial record (switch-on of an untracked session). */
      project: TrackingProject;
      trackFrom: number;
      event: Omit<BillableSwitchSessionEventFields, "kind" | "reason">;
    }
  ): BillableSwitchRouteResult {
    const run = this.db.transaction((): BillableSwitchRouteResult => {
      const exists = this.db
        .prepare("SELECT 1 AS one FROM sessions WHERE id = ? AND namespace = ?")
        .get(sessionId, namespace);
      if (exists == null) return { found: false };
      const { projectKey, keyKind, ...fields } = input.event;
      const result = writeTrackingState(this.db, {
        namespace,
        sessionId,
        next: prior =>
          applyOldRoute(prior, input.action, {
            project: input.project,
            createdVia: "switch",
            trackFrom: input.trackFrom,
          }),
        requireWaiting: input.requireWaiting,
        // A Keep or Reverse that leaves the projection alone (a waiting copy
        // that is not Billable) is `tracking` with its own reason (3.2).
        reasonFor: (kind, prior) =>
          kind !== "tracking"
            ? input.reason
            : prior?.confirm !== "pending"
              ? "settings"
              : input.action === "keep" || input.action === "switch-on"
                ? "confirm-kept"
                : "confirm-reversed",
        origin: "switch",
        event: {
          ...fields,
          projectKey: projectKey ?? null,
          keyKind: keyKind ?? null,
        },
      });
      if (!result.ok) {
        return result.code === "not_waiting"
          ? { found: true, notWaiting: true }
          : { found: false };
      }
      const before: BillableSwitchState = {
        billable: result.before.billable,
        confirm: result.before.billableConfirm,
      };
      const after: BillableSwitchState = {
        billable: result.after.billable,
        confirm: result.after.billableConfirm,
      };
      return {
        found: true,
        changed: result.changed,
        before,
        after,
        eventId: result.eventId,
        record: result.record,
      };
    });
    return run.immediate();
  }

  /**
   * Set one session's switch to a pair (switch, confirm state), through the one
   * writer: the record is derived from the pair (switched on with no record: a
   * partial Billable record; switched off: a Billable record turns
   * Non-billable and is kept). The event's fields are decided by
   * `event(before)` on the pair the write replaces. A write that changes
   * nothing records nothing. The switch routes go through `setByOldRoute`.
   */
  setSwitch(
    sessionId: string,
    namespace: string,
    next: BillableSwitchState,
    event: (before: BillableSwitchState) => BillableSwitchSessionEventFields
  ): BillableSwitchSetResult {
    const run = this.db.transaction((): BillableSwitchSetResult => {
      const row = this.db
        .prepare(
          "SELECT billable, billable_confirm, created_at FROM sessions WHERE id = ? AND namespace = ?"
        )
        .get(sessionId, namespace) as {
        billable: number | null;
        billable_confirm: string | null;
        created_at: number;
      } | null;
      if (row == null) return { found: false };
      const before: BillableSwitchState = {
        billable: row.billable === 1,
        confirm: asConfirm(row.billable_confirm),
      };
      const { kind, reason, projectKey, keyKind, ...fields } = event(before);
      const key = projectKey ?? "Other";
      const result = writeTrackingState(this.db, {
        namespace,
        sessionId,
        next: prior => {
          if (next.billable) {
            const base =
              prior ??
              partialBillableRecord({
                project: { kind: keyKind ?? "path", key, name: key },
                createdVia: "switch",
                trackFrom: row.created_at,
              });
            return {
              ...base,
              billingStatus: "billable",
              confirm: next.confirm,
            };
          }
          if (prior === null) return null;
          return prior.billingStatus === "billable"
            ? { ...prior, billingStatus: "non-billable", confirm: null }
            : { ...prior, confirm: null };
        },
        kind,
        reasonFor: () => reason,
        origin: "switch",
        event: {
          ...fields,
          projectKey: projectKey ?? null,
          keyKind: keyKind ?? null,
        },
      });
      if (!result.ok) return { found: false };
      return {
        found: true,
        changed: result.changed,
        before,
        after: {
          billable: result.after.billable,
          confirm: result.after.billableConfirm,
        },
        eventId: result.eventId,
        record: result.record,
      };
    });
    return run.immediate();
  }

  /** This node's sessions of a namespace with the switch on, for a billing reader. */
  listBillableSessions(namespace: string): BillableSwitchListedSession[] {
    const rows = this.db
      .prepare(
        `SELECT s.id AS session_id, s.billable, s.billable_confirm,
                (SELECT MAX(e.id) FROM billable_switch_events e WHERE e.session_id = s.id) AS last_event_id,
                (SELECT MAX(e.at) FROM billable_switch_events e WHERE e.session_id = s.id) AS last_event_at
           FROM sessions s
          WHERE s.namespace = ? AND s.billable = 1
          ORDER BY s.id`
      )
      .all(namespace) as Array<{
      session_id: string;
      billable: number;
      billable_confirm: string | null;
      last_event_id: number | null;
      last_event_at: number | null;
    }>;
    return rows.map(r => ({
      sessionId: r.session_id,
      billable: r.billable === 1,
      confirm: asConfirm(r.billable_confirm),
      lastEventId: r.last_event_id ?? null,
      lastEventAt: r.last_event_at ?? null,
    }));
  }

  // ---- events -------------------------------------------------------------

  /**
   * A session's events, oldest first; only `namespace`'s when given.
   * `legacyOnly` (#6778, 6.3): the seven old kinds without the four new fields.
   */
  listEvents(
    sessionId: string,
    namespace?: string,
    opts?: { legacyOnly?: boolean }
  ): BillableSwitchEvent[] {
    const only = opts?.legacyOnly ? LEGACY_KIND_CLAUSE : "";
    const rows = (
      namespace === undefined
        ? this.db
            .prepare(
              `SELECT * FROM billable_switch_events WHERE session_id = ?${only} ORDER BY at ASC, id ASC`
            )
            .all(sessionId)
        : this.db
            .prepare(
              `SELECT * FROM billable_switch_events WHERE session_id = ? AND namespace = ?${only} ORDER BY at ASC, id ASC`
            )
            .all(sessionId, namespace)
    ) as EventRow[];
    const events = rows.map(rowToEvent);
    return opts?.legacyOnly ? events.map(toLegacyEvent) : events;
  }

  /** A namespace's events after an id, ascending; optionally only some kinds. */
  listEventsSince(
    namespace: string,
    afterId: number,
    opts?: { kinds?: readonly string[]; limit?: number }
  ): BillableSwitchEvent[] {
    const filter = kindFilter(opts?.kinds);
    if (!filter) return [];
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 1000));
    const rows = this.db
      .prepare(
        `SELECT * FROM billable_switch_events
          WHERE namespace = ? AND id > ?${filter.clause}
          ORDER BY id ASC LIMIT ${limit}`
      )
      .all(namespace, afterId, ...filter.kinds) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** The namespaces under which events exist for a session id. */
  namespacesForSessionEvents(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT namespace FROM billable_switch_events WHERE session_id = ?"
      )
      .all(sessionId) as Array<{ namespace: string }>;
    return rows.map(r => r.namespace);
  }

  /** True when this node has ever recorded a switch event (the gate's `closed` rule). */
  hasAnyEvent(): boolean {
    const row = this.db
      .prepare("SELECT 1 AS one FROM billable_switch_events LIMIT 1")
      .get() as { one: number } | null;
    return row != null;
  }

  /** This node's header events of a namespace, oldest first. */
  listHeaderEvents(namespace: string): BillableSwitchEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM billable_switch_events
          WHERE namespace = ? AND kind IN ('header-on', 'header-off')
          ORDER BY id ASC`
      )
      .all(namespace) as EventRow[];
    return rows.map(rowToEvent);
  }

  // ---- this node's headers -----------------------------------------------

  /** The header for a project; null means it was never set. */
  getHeader(
    namespace: string,
    projectKey: string
  ): {
    billable: boolean;
    keyKind: BillableSwitchKeyKind;
    updatedAt: number;
  } | null {
    return readProjectDefaultRow(this.db, namespace, projectKey);
  }

  /** Every header of this node, all namespaces (for the federation report). */
  listHeaders(): BillableSwitchHeader[] {
    const rows = this.db
      .prepare(
        `SELECT namespace, project_key, key_kind, billable, updated_at
           FROM billable_switch_project_defaults ORDER BY namespace, project_key`
      )
      .all() as Array<{
      namespace: string;
      project_key: string;
      key_kind: string;
      billable: number;
      updated_at: number;
    }>;
    return rows.map(r => ({
      namespace: r.namespace,
      projectKey: r.project_key,
      keyKind: r.key_kind as BillableSwitchKeyKind,
      billable: r.billable === 1,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * #6778 PR-A (section 3.4 step 4; reviews S6, H7, H9, T10): the header
   * retirement, run at every start-up by `runBillableTrackingStartup`, never by
   * a migration (the Store's migrations write no row). In ONE IMMEDIATE
   * transaction every header row that is on is switched off, with one
   * `header-off` event per row (reason `retired`, actor `system`, channel
   * `internal`), and every stored header row of another node's report is
   * deleted, so a previous binary after a roll back starts nothing billable
   * from either. The rows themselves stay, so D-1's "D-1 c" undo can switch
   * one back on. A second run finds nothing and writes nothing.
   */
  retireHeaders(opts: { entryNodeId: string | null; now?: number }): {
    switchedOff: number;
    peerHeadersDeleted: number;
  } {
    const now = opts.now ?? Date.now();
    const run = this.db.transaction(() => {
      const on = this.db
        .prepare(
          `SELECT namespace, project_key, key_kind
             FROM billable_switch_project_defaults
            WHERE billable = 1
            ORDER BY namespace, project_key`
        )
        .all() as Array<{
        namespace: string;
        project_key: string;
        key_kind: string;
      }>;
      for (const row of on) {
        const keyKind: BillableSwitchKeyKind =
          row.key_kind === "path" ? "path" : "repo";
        upsertProjectDefaultRow(
          this.db,
          row.namespace,
          row.project_key,
          keyKind,
          false,
          now
        );
        insertBillableSwitchEvent(this.db, {
          namespace: row.namespace,
          sessionId: null,
          projectKey: row.project_key,
          keyKind,
          kind: "header-off",
          reason: "retired",
          billableBefore: true,
          billableAfter: false,
          actorKind: "system",
          via: "internal",
          entryNodeId: opts.entryNodeId,
          label: { projectKey: row.project_key, keyKind, picks: 0 },
          at: now,
        });
      }
      const deleted = this.db
        .prepare("DELETE FROM billable_switch_peer_headers")
        .run().changes;
      return { switchedOff: on.length, peerHeadersDeleted: deleted };
    });
    return run.immediate();
  }

  // ---- other nodes' header reports ---------------------------------------

  /**
   * Replace one node's header rows with a report, wholesale, and upsert its
   * report row, in one transaction. An empty list clears the rows and keeps
   * the report row (a node that reported nothing is not a node that never
   * reported). A report equal to the stored rows only refreshes `reported_at`,
   * at most once per `BILLABLE_SWITCH_REPORT_REFRESH_MS`, so a node does not
   * rewrite every other node's rows at each poll; a node's first report always
   * writes its report row. Returns whether the stored headers changed (or the
   * node reported for the first time).
   */
  replacePeerReport(
    nodeId: string,
    nodeLabel: string | null,
    headers: readonly BillableSwitchHeader[],
    reportedAt: number
  ): { changed: boolean } {
    const run = this.db.transaction((): { changed: boolean } => {
      const report = this.db
        .prepare(
          "SELECT reported_at FROM billable_switch_peer_reports WHERE node_id = ?"
        )
        .get(nodeId) as { reported_at: number } | null;
      const stored = this.peerHeadersOf(nodeId);
      const same = report != null && sameHeaders(stored, headers);
      if (same) {
        if (
          reportedAt - report.reported_at >=
          BILLABLE_SWITCH_REPORT_REFRESH_MS
        ) {
          this.db
            .prepare(
              `UPDATE billable_switch_peer_reports
                  SET reported_at = ?, node_label = COALESCE(?, node_label)
                WHERE node_id = ?`
            )
            .run(reportedAt, nodeLabel, nodeId);
        }
        return { changed: false };
      }
      this.db
        .prepare("DELETE FROM billable_switch_peer_headers WHERE node_id = ?")
        .run(nodeId);
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO billable_switch_peer_headers
           (node_id, namespace, project_key, key_kind, billable, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const h of headers) {
        insert.run(
          nodeId,
          h.namespace,
          h.projectKey,
          h.keyKind,
          h.billable ? 1 : 0,
          h.updatedAt
        );
      }
      this.db
        .prepare(
          `INSERT INTO billable_switch_peer_reports (node_id, node_label, reported_at, header_count)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (node_id) DO UPDATE SET
             node_label = COALESCE(excluded.node_label, billable_switch_peer_reports.node_label),
             reported_at = excluded.reported_at,
             header_count = excluded.header_count`
        )
        .run(nodeId, nodeLabel, reportedAt, headers.length);
      return { changed: true };
    });
    return run.immediate();
  }

  /**
   * Update ONE header row of another node after a proxied header write. It
   * does not touch `reported_at`, and it creates no report row: a node that
   * never reported stays "never reported".
   */
  upsertPeerHeader(nodeId: string, header: BillableSwitchHeader): void {
    this.db
      .prepare(
        `INSERT INTO billable_switch_peer_headers
           (node_id, namespace, project_key, key_kind, billable, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (node_id, namespace, project_key) DO UPDATE SET
           key_kind = excluded.key_kind,
           billable = excluded.billable,
           updated_at = excluded.updated_at`
      )
      .run(
        nodeId,
        header.namespace,
        header.projectKey,
        header.keyKind,
        header.billable ? 1 : 0,
        header.updatedAt
      );
  }

  /** Delete a node's header rows and its report row (it left the mesh). */
  deletePeerNode(nodeId: string): boolean {
    const run = this.db.transaction((): boolean => {
      const a = this.db
        .prepare("DELETE FROM billable_switch_peer_headers WHERE node_id = ?")
        .run(nodeId);
      const b = this.db
        .prepare("DELETE FROM billable_switch_peer_reports WHERE node_id = ?")
        .run(nodeId);
      return a.changes + b.changes > 0;
    });
    return run.immediate();
  }

  /** Delete every stored node not in `keepNodeIds`; returns the removed ids. */
  prunePeerNodes(keepNodeIds: readonly string[]): string[] {
    const keep = new Set(keepNodeIds);
    const stored = new Set<string>();
    for (const r of this.db
      .prepare("SELECT node_id FROM billable_switch_peer_reports")
      .all() as Array<{ node_id: string }>) {
      stored.add(r.node_id);
    }
    for (const r of this.db
      .prepare("SELECT DISTINCT node_id FROM billable_switch_peer_headers")
      .all() as Array<{ node_id: string }>) {
      stored.add(r.node_id);
    }
    const removed = [...stored].filter(id => !keep.has(id)).sort();
    for (const id of removed) this.deletePeerNode(id);
    return removed;
  }

  /** Every stored report, with its headers. */
  listPeerReports(): BillableSwitchPeerReport[] {
    const reports = this.db
      .prepare(
        "SELECT node_id, node_label, reported_at, header_count FROM billable_switch_peer_reports ORDER BY node_id"
      )
      .all() as Array<{
      node_id: string;
      node_label: string | null;
      reported_at: number;
      header_count: number;
    }>;
    return reports.map(r => ({
      nodeId: r.node_id,
      nodeLabel: r.node_label,
      reportedAt: r.reported_at,
      headerCount: r.header_count,
      headers: this.peerHeadersOf(r.node_id),
    }));
  }

  /** Header rows stored for nodes that have no report row (proxied writes only). */
  listUnreportedPeerHeaders(): Array<{
    nodeId: string;
    header: BillableSwitchHeader;
  }> {
    const rows = this.db
      .prepare(
        `SELECT h.node_id, h.namespace, h.project_key, h.key_kind, h.billable, h.updated_at
           FROM billable_switch_peer_headers h
          WHERE NOT EXISTS (SELECT 1 FROM billable_switch_peer_reports r WHERE r.node_id = h.node_id)`
      )
      .all() as Array<{
      node_id: string;
      namespace: string;
      project_key: string;
      key_kind: string;
      billable: number;
      updated_at: number;
    }>;
    return rows.map(r => ({
      nodeId: r.node_id,
      header: {
        namespace: r.namespace,
        projectKey: r.project_key,
        keyKind: r.key_kind as BillableSwitchKeyKind,
        billable: r.billable === 1,
        updatedAt: r.updated_at,
      },
    }));
  }

  private peerHeadersOf(nodeId: string): BillableSwitchHeader[] {
    const rows = this.db
      .prepare(
        `SELECT namespace, project_key, key_kind, billable, updated_at
           FROM billable_switch_peer_headers WHERE node_id = ?
          ORDER BY namespace, project_key`
      )
      .all(nodeId) as Array<{
      namespace: string;
      project_key: string;
      key_kind: string;
      billable: number;
      updated_at: number;
    }>;
    return rows.map(r => ({
      namespace: r.namespace,
      projectKey: r.project_key,
      keyKind: r.key_kind as BillableSwitchKeyKind,
      billable: r.billable === 1,
      updatedAt: r.updated_at,
    }));
  }

  // ---- the feed (this node's events, read by other nodes) -----------------

  /**
   * Rows with `id > cursor`, ascending, `limit` clamped to 1..1000. Without
   * `includeTracking` (a puller that did not ask with `schema=2`, #6778 6.3) the
   * `tracking` rows are left out IN THE SQL, before the limit, so a page of
   * filtered rows can never wedge an older puller, and the four new fields are
   * left out of every row. With it, the page also carries `cursorAt`, the `at`
   * of the row whose id is the cursor (null when there is none, and for cursor
   * 0), so a puller can see an origin restored from a backup that re-issued
   * ids at or below its cursor (review S14).
   */
  getEventFeedPage(
    cursor: number,
    limit: number,
    opts?: { includeTracking?: boolean }
  ): {
    events: BillableSwitchEvent[];
    nextCursor: number;
    cursorAt?: number | null;
  } {
    const n = Math.max(1, Math.min(Math.floor(limit) || 500, 1000));
    const from = Math.max(0, Math.floor(cursor) || 0);
    const legacy = opts?.includeTracking !== true;
    const rows = this.db
      .prepare(
        `SELECT * FROM billable_switch_events WHERE id > ?${legacy ? LEGACY_KIND_CLAUSE : ""} ORDER BY id ASC LIMIT ${n}`
      )
      .all(from) as EventRow[];
    const events = legacy
      ? rows.map(rowToEvent).map(toLegacyEvent)
      : rows.map(rowToEvent);
    const nextCursor =
      events.length > 0 ? events[events.length - 1].id : cursor;
    if (legacy) return { events, nextCursor };
    const atRow =
      from > 0
        ? (this.db
            .prepare("SELECT at FROM billable_switch_events WHERE id = ?")
            .get(from) as { at: number } | null)
        : null;
    return { events, nextCursor, cursorAt: atRow?.at ?? null };
  }

  getMaxEventId(): number {
    const row = this.db
      .prepare("SELECT MAX(id) AS max_id FROM billable_switch_events")
      .get() as { max_id: number | null } | null;
    return row?.max_id ?? 0;
  }

  // ---- the copy of other nodes' events (`billableSwitchMirrorStore.ts`) ---

  upsertMirrorEvents(
    originNodeId: string,
    incarnation: string,
    rows: readonly BillableSwitchEvent[],
    now: number
  ): number {
    return mirror.upsertMirrorEvents(
      this.db,
      originNodeId,
      incarnation,
      rows,
      now
    );
  }

  getMirrorCursor(originNodeId: string): BillableSwitchMirrorCursor | null {
    return mirror.getMirrorCursor(this.db, originNodeId);
  }

  setMirrorCursor(
    originNodeId: string,
    cursor: BillableSwitchMirrorCursor
  ): void {
    mirror.setMirrorCursor(this.db, originNodeId, cursor);
  }

  /** `legacyOnly` (#6778, 6.3): the seven old kinds, for the old history read. */
  listMirrorEvents(
    sessionId: string,
    namespace?: string,
    opts?: { legacyOnly?: boolean }
  ): BillableSwitchMirrorEvent[] {
    return mirror.listMirrorEvents(
      this.db,
      sessionId,
      namespace,
      opts?.legacyOnly ? LEGACY_KIND_CLAUSE : ""
    );
  }

  /** The `at` of each copied row with this origin, incarnation and event id (S14). */
  getMirrorEventAts(
    originNodeId: string,
    incarnation: string,
    eventId: number
  ): number[] {
    return mirror.getMirrorEventAts(
      this.db,
      originNodeId,
      incarnation,
      eventId
    );
  }

  listMirrorEventsSince(
    namespace: string,
    afterMirrorSeq: number,
    opts?: { kinds?: readonly string[]; limit?: number }
  ): BillableSwitchMirrorEvent[] {
    const filter = kindFilter(opts?.kinds);
    if (!filter) return [];
    return mirror.listMirrorEventsSince(
      this.db,
      namespace,
      afterMirrorSeq,
      filter,
      opts?.limit
    );
  }

  mirrorNamespacesForSession(sessionId: string): string[] {
    return mirror.mirrorNamespacesForSession(this.db, sessionId);
  }

  listMirrorHeaderEvents(namespace: string): BillableSwitchMirrorEvent[] {
    return mirror.listMirrorHeaderEvents(this.db, namespace);
  }
}
