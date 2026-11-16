// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import {
  BILLABLE_SWITCH_EVENT_KINDS,
  isBillableSwitchReasonForKind,
  projectBaseKey,
  projectKeyKind,
  unloggedAmount,
  type BillableConfirm,
  type BillableSwitchActorKind,
  type BillableSwitchEvent,
  type BillableSwitchEventKind,
  type BillableSwitchHeader,
  type BillableSwitchKeyKind,
  type BillableSwitchStartKind,
  type BillableSwitchVia,
} from "@hapi/protocol";
import { safeJsonParse } from "./json";

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
};

const boolToInt = (v: boolean | null | undefined): number | null =>
  v === null || v === undefined ? null : v ? 1 : 0;
const intToBool = (v: number | null | undefined): boolean | null =>
  v === null || v === undefined ? null : v === 1;
const asConfirm = (v: string | null | undefined): BillableConfirm =>
  v === "pending" ? "pending" : null;

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
         timer_ms, unlogged_ms, logged_known, label_json, at
       ) VALUES (
         @namespace, @session_id, @project_key, @key_kind, @kind, @reason, @start_kind,
         @billable_before, @billable_after, @confirm_before, @confirm_after,
         @actor_kind, @actor_session_id, @actor_user_agent, @via, @entry_node_id,
         @timer_ms, @unlogged_ms, @logged_known, @label_json, @at
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
};

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
    };

export type BillableSwitchPick = {
  sessionId: string;
  timerMs: number;
  loggedMs: number | null;
};

export type BillableSwitchPickOutcome =
  | "ok"
  | "unchanged"
  | "not_found"
  | "not_in_project";

export type BillableSwitchApplyHeaderResult = {
  header: {
    namespace: string;
    projectKey: string;
    keyKind: BillableSwitchKeyKind;
    billable: boolean;
    updatedAt: number;
  };
  headerChanged: boolean;
  sessions: Array<{ id: string; outcome: BillableSwitchPickOutcome }>;
  /** The sessions whose switch changed (for the caller's cache refresh). */
  changedSessionIds: string[];
};

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
   * Set one session's switch and append its event, in one IMMEDIATE
   * transaction. "Changed" is judged on the pair (switch, confirm state): a
   * write that leaves both as they are writes no event. The event's own fields
   * are decided by `event(before)` INSIDE the transaction, so the kind (`off`
   * or `reverse`, `on` or `keep`) is judged on the value that is replaced. A
   * row of another namespace is not found and changes nothing.
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
          "SELECT billable, billable_confirm FROM sessions WHERE id = ? AND namespace = ?"
        )
        .get(sessionId, namespace) as {
        billable: number | null;
        billable_confirm: string | null;
      } | null;
      if (row == null) return { found: false };
      const before: BillableSwitchState = {
        billable: row.billable === 1,
        confirm: asConfirm(row.billable_confirm),
      };
      const after: BillableSwitchState = {
        billable: next.billable,
        confirm: next.billable ? next.confirm : null,
      };
      if (
        before.billable === after.billable &&
        before.confirm === after.confirm
      ) {
        return { found: true, changed: false, before, after, eventId: null };
      }
      const fields = event(before);
      this.db
        .prepare(
          `UPDATE sessions SET billable = ?, billable_confirm = ?, seq = seq + 1
            WHERE id = ? AND namespace = ?`
        )
        .run(after.billable ? 1 : 0, after.confirm, sessionId, namespace);
      const eventId = insertBillableSwitchEvent(this.db, {
        ...fields,
        namespace,
        sessionId,
        projectKey: fields.projectKey ?? null,
        keyKind: fields.keyKind ?? null,
        billableBefore: before.billable,
        billableAfter: after.billable,
        confirmBefore: before.confirm,
        confirmAfter: after.confirm,
      });
      return { found: true, changed: true, before, after, eventId };
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

  /** A session's events, oldest first; only `namespace`'s when given. */
  listEvents(sessionId: string, namespace?: string): BillableSwitchEvent[] {
    const rows = (
      namespace === undefined
        ? this.db
            .prepare(
              "SELECT * FROM billable_switch_events WHERE session_id = ? ORDER BY at ASC, id ASC"
            )
            .all(sessionId)
        : this.db
            .prepare(
              "SELECT * FROM billable_switch_events WHERE session_id = ? AND namespace = ? ORDER BY at ASC, id ASC"
            )
            .all(sessionId, namespace)
    ) as EventRow[];
    return rows.map(rowToEvent);
  }

  /** A namespace's events after an id, ascending; optionally only some kinds. */
  listEventsSince(
    namespace: string,
    afterId: number,
    opts?: { kinds?: readonly string[]; limit?: number }
  ): BillableSwitchEvent[] {
    const kinds = (opts?.kinds ?? []).filter(k =>
      (BILLABLE_SWITCH_EVENT_KINDS as readonly string[]).includes(k)
    );
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 1000));
    const kindClause =
      kinds.length > 0
        ? ` AND kind IN (${kinds.map(() => "?").join(", ")})`
        : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM billable_switch_events
          WHERE namespace = ? AND id > ?${kindClause}
          ORDER BY id ASC LIMIT ${limit}`
      )
      .all(namespace, afterId, ...kinds) as EventRow[];
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
   * Set this node's header for a project and switch the picked sessions on,
   * all in ONE IMMEDIATE transaction (R12): a failed write rolls back the
   * header and every pick. No header event when the header is already at the
   * requested value; the picks still apply. Every pick must be a session of
   * this namespace whose project key and key kind equal the header's; a pick
   * that is not found, of another project, or already billable is reported and
   * skipped. Picks are allowed only when switching the header on.
   */
  applyHeader(input: {
    namespace: string;
    projectKey: string;
    keyKind: BillableSwitchKeyKind;
    billable: boolean;
    picks: readonly BillableSwitchPick[];
    actor: {
      kind: BillableSwitchActorKind;
      sessionId?: string | null;
      userAgent?: string | null;
    };
    via: BillableSwitchVia;
    entryNodeId: string | null;
    now?: number;
  }): BillableSwitchApplyHeaderResult {
    if (!input.billable && input.picks.length > 0) {
      throw new Error(
        "billable switch: picks are allowed only when switching a header on"
      );
    }
    const now = input.now ?? Date.now();
    const run = this.db.transaction((): BillableSwitchApplyHeaderResult => {
      const prior = readProjectDefaultRow(
        this.db,
        input.namespace,
        input.projectKey
      );
      const headerChanged = prior === null || prior.billable !== input.billable;
      const actorFields = {
        actorKind: input.actor.kind,
        actorSessionId: input.actor.sessionId ?? null,
        actorUserAgent: input.actor.userAgent ?? null,
        via: input.via,
        entryNodeId: input.entryNodeId,
      };
      if (headerChanged) {
        upsertProjectDefaultRow(
          this.db,
          input.namespace,
          input.projectKey,
          input.keyKind,
          input.billable,
          now
        );
        insertBillableSwitchEvent(this.db, {
          ...actorFields,
          namespace: input.namespace,
          sessionId: null,
          projectKey: input.projectKey,
          keyKind: input.keyKind,
          kind: input.billable ? "header-on" : "header-off",
          reason: "switch",
          billableBefore: prior === null ? null : prior.billable,
          billableAfter: input.billable,
          label: {
            projectKey: input.projectKey,
            keyKind: input.keyKind,
            picks: input.picks.length,
          },
          at: now,
        });
      }

      const sessions: BillableSwitchApplyHeaderResult["sessions"] = [];
      const changedSessionIds: string[] = [];
      for (const pick of input.picks) {
        const row = this.db
          .prepare(
            "SELECT metadata, billable FROM sessions WHERE id = ? AND namespace = ?"
          )
          .get(pick.sessionId, input.namespace) as {
          metadata: string | null;
          billable: number | null;
        } | null;
        if (row == null) {
          sessions.push({ id: pick.sessionId, outcome: "not_found" });
          continue;
        }
        const metadata = safeJsonParse(row.metadata) as Parameters<
          typeof projectBaseKey
        >[0];
        if (
          projectBaseKey(metadata) !== input.projectKey ||
          projectKeyKind(metadata) !== input.keyKind
        ) {
          sessions.push({ id: pick.sessionId, outcome: "not_in_project" });
          continue;
        }
        if (row.billable === 1) {
          sessions.push({ id: pick.sessionId, outcome: "unchanged" });
          continue;
        }
        const amount = unloggedAmount({
          timerMs: pick.timerMs,
          loggedMs: pick.loggedMs,
        });
        const meta = (metadata ?? {}) as { name?: unknown; path?: unknown };
        // A nested `transaction()` is a savepoint, so a throw here rolls back
        // the header and every earlier pick with the outer transaction.
        const result = this.setSwitch(
          pick.sessionId,
          input.namespace,
          { billable: true, confirm: null },
          () => ({
            ...actorFields,
            kind: "on",
            reason: "pick",
            projectKey: input.projectKey,
            keyKind: input.keyKind,
            timerMs: pick.timerMs,
            unloggedMs: amount.ms,
            loggedKnown: amount.loggedKnown,
            label: {
              name: typeof meta.name === "string" ? meta.name : null,
              projectKey: input.projectKey,
              path: typeof meta.path === "string" ? meta.path : null,
            },
            at: now,
          })
        );
        if (result.found && result.changed) {
          sessions.push({ id: pick.sessionId, outcome: "ok" });
          changedSessionIds.push(pick.sessionId);
        } else {
          sessions.push({ id: pick.sessionId, outcome: "unchanged" });
        }
      }
      const stored = readProjectDefaultRow(
        this.db,
        input.namespace,
        input.projectKey
      );
      return {
        header: {
          namespace: input.namespace,
          projectKey: input.projectKey,
          keyKind: stored?.keyKind ?? input.keyKind,
          billable: stored?.billable ?? input.billable,
          updatedAt: stored?.updatedAt ?? now,
        },
        headerChanged,
        sessions,
        changedSessionIds,
      };
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

  /** Rows with `id > cursor`, ascending, `limit` clamped to 1..1000. */
  getEventFeedPage(
    cursor: number,
    limit: number
  ): { events: BillableSwitchEvent[]; nextCursor: number } {
    const n = Math.max(1, Math.min(Math.floor(limit) || 500, 1000));
    const rows = this.db
      .prepare(
        `SELECT * FROM billable_switch_events WHERE id > ? ORDER BY id ASC LIMIT ${n}`
      )
      .all(Math.max(0, Math.floor(cursor) || 0)) as EventRow[];
    const events = rows.map(rowToEvent);
    const nextCursor =
      events.length > 0 ? events[events.length - 1].id : cursor;
    return { events, nextCursor };
  }

  getMaxEventId(): number {
    const row = this.db
      .prepare("SELECT MAX(id) AS max_id FROM billable_switch_events")
      .get() as { max_id: number | null } | null;
    return row?.max_id ?? 0;
  }

  // ---- the copy of other nodes' events -----------------------------------

  /**
   * Copy a page of another node's events. An event never changes, so a row
   * already copied collides on (origin, incarnation, event id, time) and is
   * skipped; an id a restored database issues again has another time and is
   * kept as a second row. Returns how many rows were added.
   */
  upsertMirrorEvents(
    originNodeId: string,
    incarnation: string,
    rows: readonly BillableSwitchEvent[],
    now: number
  ): number {
    if (rows.length === 0) return 0;
    const run = this.db.transaction((): number => {
      const stmt = this.db.prepare(
        `INSERT INTO billable_switch_events_mirror (
           origin_node_id, origin_incarnation, event_id, namespace, session_id,
           kind, at, row_json, mirrored_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (origin_node_id, origin_incarnation, event_id, at) DO NOTHING`
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

  getMirrorCursor(originNodeId: string): BillableSwitchMirrorCursor | null {
    const row = this.db
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

  setMirrorCursor(
    originNodeId: string,
    cursor: BillableSwitchMirrorCursor
  ): void {
    this.db
      .prepare(
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
      )
      .run(
        originNodeId,
        cursor.originIncarnation,
        cursor.cursor,
        cursor.feedState,
        cursor.lastOriginMaxId,
        cursor.lastSyncAt,
        cursor.lastAttemptAt
      );
  }

  /** The copied events of a session id, oldest first; only `namespace`'s when given. */
  listMirrorEvents(
    sessionId: string,
    namespace?: string
  ): BillableSwitchMirrorEvent[] {
    const rows = (
      namespace === undefined
        ? this.db
            .prepare(
              "SELECT * FROM billable_switch_events_mirror WHERE session_id = ? ORDER BY at ASC, mirror_seq ASC"
            )
            .all(sessionId)
        : this.db
            .prepare(
              "SELECT * FROM billable_switch_events_mirror WHERE session_id = ? AND namespace = ? ORDER BY at ASC, mirror_seq ASC"
            )
            .all(sessionId, namespace)
    ) as MirrorRow[];
    return rows
      .map(mirrorRowToEvent)
      .filter((e): e is BillableSwitchMirrorEvent => e !== null);
  }

  /** A namespace's copied events after a mirror sequence, by arrival. */
  listMirrorEventsSince(
    namespace: string,
    afterMirrorSeq: number,
    opts?: { kinds?: readonly string[]; limit?: number }
  ): BillableSwitchMirrorEvent[] {
    const kinds = (opts?.kinds ?? []).filter(k =>
      (BILLABLE_SWITCH_EVENT_KINDS as readonly string[]).includes(k)
    );
    const limit = Math.max(1, Math.min(opts?.limit ?? 500, 1000));
    const kindClause =
      kinds.length > 0
        ? ` AND kind IN (${kinds.map(() => "?").join(", ")})`
        : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM billable_switch_events_mirror
          WHERE namespace = ? AND mirror_seq > ?${kindClause}
          ORDER BY mirror_seq ASC LIMIT ${limit}`
      )
      .all(namespace, afterMirrorSeq, ...kinds) as MirrorRow[];
    return rows
      .map(mirrorRowToEvent)
      .filter((e): e is BillableSwitchMirrorEvent => e !== null);
  }

  /** The namespaces under which copied events exist for a session id. */
  mirrorNamespacesForSession(sessionId: string): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT namespace FROM billable_switch_events_mirror WHERE session_id = ?"
      )
      .all(sessionId) as Array<{ namespace: string }>;
    return rows.map(r => r.namespace);
  }

  /** The copied header events of a namespace, by arrival. */
  listMirrorHeaderEvents(namespace: string): BillableSwitchMirrorEvent[] {
    const rows = this.db
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
