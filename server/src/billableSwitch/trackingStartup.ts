// SPDX-License-Identifier: AGPL-3.0-only
import {
  applyOldRoute,
  partialBillableRecord,
  trackingProjectOf,
  type OldRouteAction,
  type ProjectKeyMetadata,
  type TrackingProject,
  type TrackingRecordDraft,
} from "@hapi/protocol";
import type { Store } from "../store";
import { writeTrackingState } from "../store/billableTrackingStore";
import { safeJsonParse } from "../store/json";

/**
 * Issue #6778 (plan section 3.4, "Rows at start-up"): the ONE function that
 * writes billable-tracking rows at start-up. `server/src/index.ts` calls it
 * once, between `new Store` and `resolveBillableSwitchGate`, inside a `try`.
 * The Store's migrations write no row ("DDL only", #6586's rule), because they
 * also run in every test, rig and tool that opens a Store.
 *
 * PR-A runs step 4 only, the header retirement (R12): every header row that is
 * on is switched off with one `header-off` event (reason `retired`), and every
 * stored header row of another node's report is deleted
 * (`BillableSwitchStore.retireHeaders`), so a previous binary after a roll back
 * starts nothing billable from either. It runs only when the switch schema is
 * there (`billableSwitchStorageReady`). A failure is written to the error log,
 * leaves the gate as it is (PR-A's start rule reads no header) and is tried
 * again at the next boot.
 *
 * PR-B adds steps 5 and 6, the reconcile (3.3 item 4). A previous binary, after
 * a roll back, writes the two `sessions` columns and appends history rows with
 * no snapshot and a null `origin`; it never writes the record. So the reconcile
 * REPLAYS those rows rather than comparing the columns: every row with a null
 * origin above this node's replay watermark (the highest event id at its first
 * start-up on PR-B, stored once) is applied to the record through the old-route
 * mapping, with one `tracking` row (reason `reconciled`, label `{ replayOf }`,
 * the replayed row's `at`) per replayed row. At the first start-up a session
 * whose switch is on gains a partial Billable record (one `reconciled` row);
 * no other existing session gains one (R2). Only sessions whose row exists in
 * the namespace are reconciled (an inner join). Each session is its own
 * transaction with a bounded retry; one that cannot be settled is listed
 * (`failedSessionIds`), answers `reconcilePending` and refuses writes with 409
 * `tracking_reconcile_pending` until a retry settles it. Nothing else is held.
 */

/** The meta key of the replay watermark. */
export const BILLABLE_TRACKING_WATERMARK_KEY = "replay_watermark";

/** The reconcile's result, carried into the gate as an explicit flag (3.4 step 6). */
export type BillableTrackingReconcileSummary = {
  ok: boolean;
  reconciled: number;
  failedSessionIds: string[];
  mismatches: number;
};

export type BillableTrackingStartupResult =
  | { ran: false; reason: "schema-not-ready" }
  | {
      ran: true;
      ok: true;
      headersSwitchedOff: number;
      peerHeadersDeleted: number;
      reconcile: BillableTrackingReconcileSummary;
    }
  | {
      ran: true;
      ok: false;
      error: string;
      /** The reconcile still runs when the header retirement failed (H2). */
      reconcile: BillableTrackingReconcileSummary;
    };

/** The error log category of a failed step. */
export const BILLABLE_TRACKING_STARTUP_CATEGORY = "billable-tracking-startup";

export function runBillableTrackingStartup(
  store: StartupStore,
  options: { entryNodeId?: string | null; now?: number } = {}
): BillableTrackingStartupResult {
  if (!store.billableSwitchStorageReady) {
    return { ran: false, reason: "schema-not-ready" };
  }
  let retired: { switchedOff: number; peerHeadersDeleted: number };
  try {
    retired = store.billableSwitch.retireHeaders({
      entryNodeId: options.entryNodeId ?? null,
      now: options.now,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    try {
      store.errorLogs.createEntry({
        severity: "error",
        category: BILLABLE_TRACKING_STARTUP_CATEGORY,
        source: "server",
        message: `The billable tracking start-up step failed; the header retirement runs again at the next boot: ${error}`,
        stack: err instanceof Error ? (err.stack ?? null) : null,
        context: JSON.stringify({ step: "header-retirement" }),
      });
    } catch (logError) {
      // The boot line still says so (review finding 78c033d3: never silent).
      errorLogFailed("the header retirement's failure", logError);
    }
    // The reconcile runs in its own `try` even when the retirement failed
    // (review finding H2): skipping it left every unreplayed session open to
    // writes that the next boot's replay would then overtake.
    return { ran: true, ok: false, error, reconcile: safeReconcile(store) };
  }
  return {
    ran: true,
    ok: true,
    headersSwitchedOff: retired.switchedOff,
    peerHeadersDeleted: retired.peerHeadersDeleted,
    reconcile: safeReconcile(store),
  };
}

/**
 * The reconcile summary the gate carries as its flag (3.4 step 6) whenever the
 * step ran, also when its header retirement failed: the reconcile runs then
 * too (review finding H2), and a session it holds must reach the gate's boot
 * line. Nothing when the step did not run (the schema is not there) or threw.
 */
export function trackingStartupGateFlag(
  result: BillableTrackingStartupResult | null
): BillableTrackingReconcileSummary | undefined {
  return result?.ran ? result.reconcile : undefined;
}

/** The boot line for the step's result. */
export function describeBillableTrackingStartup(
  result: BillableTrackingStartupResult
): string {
  if (!result.ran) {
    return "[Server] Billable tracking start-up: skipped (the switch storage is not ready)";
  }
  const r = result.reconcile;
  // Review finding M3: a reconcile that threw as a whole says so.
  const counts = `reconciled=${r.reconciled} failed=${r.failedSessionIds.length} projection mismatches=${r.mismatches}${r.mismatches === -1 ? " (reconcile FAILED as a whole; see the error log)" : ""}`;
  if (!result.ok) {
    return `[Server] Billable tracking start-up: header retirement FAILED (${result.error}); it runs again at the next boot; ${counts}`;
  }
  return `[Server] Billable tracking start-up: headers switched off=${result.headersSwitchedOff} peer header rows removed=${result.peerHeadersDeleted} ${counts}`;
}

// ---------------------------------------------------------------------------
// The reconcile (steps 5 and 6)

type StartupStore = Pick<
  Store,
  | "billableSwitch"
  | "billableTracking"
  | "billableSwitchStorageReady"
  | "errorLogs"
  | "getRawDb"
>;

type ReplayRow = {
  id: number;
  session_id: string;
  namespace: string;
  kind: string;
  billable_after: number | null;
  confirm_after: string | null;
  at: number;
};

const ACTION_OF: Record<string, OldRouteAction> = {
  on: "switch-on",
  off: "switch-off",
  keep: "keep",
  reverse: "reverse",
};

/** Sessions whose reconcile could not be settled; a write to one answers 409. */
const reconcilePending = new Set<string>();

export function isTrackingReconcilePending(sessionId: string): boolean {
  return reconcilePending.has(sessionId);
}

function sessionBasis(
  store: StartupStore,
  sessionId: string,
  namespace: string
): { project: TrackingProject; createdAt: number } | null {
  const row = store
    .getRawDb()
    .prepare(
      "SELECT metadata, created_at FROM sessions WHERE id = ? AND namespace = ?"
    )
    .get(sessionId, namespace) as {
    metadata: string | null;
    created_at: number;
  } | null;
  if (row == null) return null;
  const meta = safeJsonParse(row.metadata) as ProjectKeyMetadata;
  return { project: trackingProjectOf(meta), createdAt: row.created_at };
}

/** The record a replayed row leaves (the old-route mapping, 3.3). */
function replayed(
  prior: TrackingRecordDraft | null,
  row: ReplayRow,
  basis: { project: TrackingProject; createdAt: number }
): TrackingRecordDraft | null {
  const fresh = {
    project: basis.project,
    createdVia: "reconciled" as const,
    trackFrom: basis.createdAt,
  };
  if (row.kind === "start") {
    if (prior !== null || row.billable_after !== 1) return prior;
    return {
      ...partialBillableRecord(fresh),
      confirm: row.confirm_after === "pending" ? "pending" : null,
    };
  }
  const action = ACTION_OF[row.kind];
  return action ? applyOldRoute(prior, action, fresh) : prior;
}

/** One session's reconcile, in one IMMEDIATE transaction; returns the rows written. */
function reconcileSession(
  store: StartupStore,
  sessionId: string,
  namespace: string,
  rows: readonly ReplayRow[],
  initial: boolean
): number {
  const db = store.getRawDb();
  return db
    .transaction((): number => {
      const basis = sessionBasis(store, sessionId, namespace);
      if (basis === null) return 0;
      const event = {
        projectKey: basis.project.key,
        keyKind: basis.project.kind,
        actorKind: "system" as const,
        via: "internal" as const,
        loggedKnown: false,
      };
      let written = 0;
      if (initial) {
        const sw = store.billableSwitch.getSwitch(sessionId);
        writeTrackingState(db, {
          namespace,
          sessionId,
          next: prior =>
            prior ?? {
              ...partialBillableRecord({
                project: basis.project,
                createdVia: "reconciled",
                trackFrom: basis.createdAt,
              }),
              confirm: sw?.confirm ?? null,
            },
          always: true,
          kind: "tracking",
          reasonFor: () => "reconciled",
          origin: "reconciled",
          event: { ...event, label: { initial: true } },
        });
        written += 1;
      }
      for (const row of rows) {
        writeTrackingState(db, {
          namespace,
          sessionId,
          next: prior => replayed(prior, row, basis),
          always: true,
          kind: "tracking",
          reasonFor: () => "reconciled",
          origin: "reconciled",
          event: { ...event, label: { replayOf: row.id }, at: row.at },
        });
        written += 1;
      }
      return written;
    })
    .immediate();
}

/**
 * The reconcile with its own catch: a throw is logged and never darkens the
 * node. When it throws as a whole (review finding H2), the sessions that still
 * have rows to replay are held, so their writes answer 409 and the retry timer
 * is armed; before, nothing was held and a write could be overtaken by the
 * next boot's replay of an older row.
 */
function safeReconcile(store: StartupStore): BillableTrackingReconcileSummary {
  try {
    return reconcileBillableTracking(store);
  } catch (err) {
    const held = holdUnreplayedSessions(store);
    try {
      store.errorLogs.createEntry({
        severity: "error",
        category: BILLABLE_TRACKING_STARTUP_CATEGORY,
        source: "server",
        message: `The billable tracking reconcile failed; it runs again at the next boot: ${err instanceof Error ? err.message : String(err)}`,
        stack: err instanceof Error ? (err.stack ?? null) : null,
        context: JSON.stringify({ step: "reconcile" }),
      });
    } catch (logError) {
      // The boot line still says so (review finding 78c033d3: never silent).
      errorLogFailed("the reconcile's failure", logError);
    }
    return { ok: false, reconciled: 0, failedSessionIds: held, mismatches: -1 };
  }
}

/** A failed error-log write, on the console (review finding 78c033d3). */
function errorLogFailed(what: string, error: unknown): void {
  console.error(
    `[BillableTracking] The error log could not record ${what}:`,
    error instanceof Error ? error.message : String(error)
  );
}

/** The rows a previous binary wrote that the reconcile has not replayed yet. */
const UNREPLAYED_ROWS_SQL = `FROM billable_switch_events e
         JOIN sessions s ON s.id = e.session_id AND s.namespace = e.namespace
        WHERE e.origin IS NULL AND e.id > ?
          AND (e.kind IN ('on', 'off', 'keep', 'reverse')
               OR (e.kind = 'start' AND e.billable_after = 1))
          AND NOT EXISTS (
            SELECT 1 FROM billable_switch_events r
             WHERE r.session_id = e.session_id AND r.kind = 'tracking'
               AND r.reason = 'reconciled'
               AND json_extract(r.label_json, '$.replayOf') = e.id)`;

/**
 * The first-start to-do list (H1): a session whose switch is on and which has
 * no record. The pass and the hold both read it.
 */
const SWITCHED_ON_WITHOUT_RECORD_SQL = `SELECT s.id, s.namespace FROM sessions s
        WHERE s.billable = 1 AND NOT EXISTS (
          SELECT 1 FROM billable_tracking_settings t
           WHERE t.session_id = s.id AND t.namespace = s.namespace)`;

/**
 * H2: after a pass that throws as a whole, hold every session the pass would
 * have worked on, from both of its sources: the sessions whose switch is on
 * with no record, and (once a watermark exists) the sessions with rows to
 * replay. Before review finding A1 (69a68652) only the second was held, and
 * nothing at all while no watermark was written. Never throws.
 */
function holdUnreplayedSessions(store: StartupStore): string[] {
  try {
    const db = store.getRawDb();
    const switchedOn = db
      .prepare(SWITCHED_ON_WITHOUT_RECORD_SQL)
      .all() as Array<{ id: string }>;
    for (const r of switchedOn) reconcilePending.add(r.id);
    const watermark = store.billableTracking.getMeta(
      BILLABLE_TRACKING_WATERMARK_KEY
    );
    if (watermark === null) return [...reconcilePending];
    const rows = db
      .prepare(`SELECT DISTINCT e.session_id AS id ${UNREPLAYED_ROWS_SQL}`)
      .all(watermark) as Array<{ id: string }>;
    for (const r of rows) reconcilePending.add(r.id);
  } catch (err) {
    console.error(
      "[BillableTracking] Could not list the sessions still to replay after a failed reconcile; none is held until the next boot:",
      err instanceof Error ? err.message : err
    );
  }
  return [...reconcilePending];
}

/**
 * Steps 5 and 6: the watermark (once), the first-start projection pass (at
 * every call, H1), then the replay. `onlySessionId` limits a retry to one session.
 */
export function reconcileBillableTracking(
  store: StartupStore,
  options: { onlySessionId?: string; attempts?: number } = {}
): BillableTrackingReconcileSummary {
  const db = store.getRawDb();
  const attempts = options.attempts ?? 3;
  if (
    store.billableTracking.getMeta(BILLABLE_TRACKING_WATERMARK_KEY) === null
  ) {
    store.billableTracking.setMetaOnce(
      BILLABLE_TRACKING_WATERMARK_KEY,
      store.billableSwitch.getMaxEventId()
    );
  }
  // The first-start pass (a switch that is on, no record) runs at every
  // start-up and every retry, not only at the first (review finding H1): the
  // condition is its own durable to-do list, so a session whose attempts all
  // failed is settled by a retry or by the next start-up, never left without
  // its record. A session that also has rows to replay is rebuilt by the
  // replay instead (below).
  const initialIds = db.prepare(SWITCHED_ON_WITHOUT_RECORD_SQL).all() as Array<{
    id: string;
    namespace: string;
  }>;
  const watermark =
    store.billableTracking.getMeta(BILLABLE_TRACKING_WATERMARK_KEY) ?? 0;
  const rows = db
    .prepare(
      `SELECT e.id, e.session_id, e.namespace, e.kind, e.billable_after,
              e.confirm_after, e.at
         ${UNREPLAYED_ROWS_SQL}
        ORDER BY e.id ASC`
    )
    .all(watermark) as ReplayRow[];
  const bySession = new Map<
    string,
    { namespace: string; rows: ReplayRow[]; initial: boolean }
  >();
  for (const s of initialIds) {
    bySession.set(s.id, { namespace: s.namespace, rows: [], initial: true });
  }
  for (const r of rows) {
    const entry = bySession.get(r.session_id) ?? {
      namespace: r.namespace,
      rows: [],
      initial: false,
    };
    entry.initial = false;
    entry.rows.push(r);
    bySession.set(r.session_id, entry);
  }
  // Reflector ruling REFL-D (D2): a held session with nothing left to do (no
  // row to replay and no first-start record to write: its `sessions` row was
  // deleted, say) is released, so the retry timer can stop. Only a full pass
  // releases, and only here, after its to-do list was built without an error;
  // a pass that throws before this point releases nothing.
  if (options.onlySessionId === undefined) {
    for (const id of [...reconcilePending]) {
      if (!bySession.has(id)) reconcilePending.delete(id);
    }
  }
  let reconciled = 0;
  for (const [sessionId, entry] of bySession) {
    if (options.onlySessionId && sessionId !== options.onlySessionId) continue;
    let lastError: unknown = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        reconciled += reconcileSession(
          store,
          sessionId,
          entry.namespace,
          entry.rows,
          entry.initial
        );
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError === null) {
      reconcilePending.delete(sessionId);
      continue;
    }
    reconcilePending.add(sessionId);
    try {
      store.errorLogs.createEntry({
        severity: "error",
        category: BILLABLE_TRACKING_STARTUP_CATEGORY,
        source: "server",
        message: `The billable tracking reconcile could not settle a session; writes to it answer 409 until a retry settles it: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
        stack: lastError instanceof Error ? (lastError.stack ?? null) : null,
        context: JSON.stringify({ step: "reconcile", sessionId }),
      });
    } catch (logError) {
      // The boot line still counts it (review finding 78c033d3: never silent).
      errorLogFailed(`the unsettled session ${sessionId}`, logError);
    }
  }
  const failedSessionIds = [...reconcilePending];
  // Review finding M3: the count of failed sessions is taken first, and the
  // mismatch count has its own try, so a throw there cannot hide the held.
  let mismatches = -1;
  try {
    mismatches = store.billableTracking.projectionMismatches();
  } catch (err) {
    console.error(
      "[BillableTracking] The projection mismatch count could not be read:",
      err instanceof Error ? err.message : err
    );
  }
  return {
    ok: failedSessionIds.length === 0,
    reconciled,
    failedSessionIds,
    mismatches,
  };
}

/**
 * Retry the unsettled sessions every `intervalMs` (five minutes) until none is
 * left. Returns a stop function. A write to one of them retries it first
 * (`retryTrackingReconcileFor`).
 */
export function startTrackingReconcileRetry(
  store: StartupStore,
  intervalMs = 5 * 60_000
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = (): void => {
    timer = null;
    if (reconcilePending.size === 0) return;
    try {
      reconcileBillableTracking(store);
    } catch (err) {
      // Review finding M4: logged (once per distinct error); the next tick
      // tries again.
      logRetryError(store, err);
    }
    if (reconcilePending.size > 0) timer = setTimeout(tick, intervalMs);
  };
  if (reconcilePending.size > 0) timer = setTimeout(tick, intervalMs);
  return () => {
    if (timer) clearTimeout(timer);
  };
}

let lastRetryError: string | null = null;

/** M4: one error-log row per distinct retry error, never a row per tick. */
function logRetryError(store: StartupStore, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message === lastRetryError) return;
  lastRetryError = message;
  try {
    store.errorLogs.createEntry({
      severity: "error",
      category: BILLABLE_TRACKING_STARTUP_CATEGORY,
      source: "server",
      message: `The billable tracking reconcile retry failed; the held sessions answer 409 until a later retry settles them: ${message}`,
      context: JSON.stringify({ step: "reconcile-retry" }),
    });
  } catch {
    console.error("[BillableTracking] The reconcile retry failed:", message);
  }
}

/** Before a write to an unsettled session: retry it; true when it is settled now. */
export function retryTrackingReconcileFor(
  store: StartupStore,
  sessionId: string
): boolean {
  if (!reconcilePending.has(sessionId)) return true;
  try {
    reconcileBillableTracking(store, { onlySessionId: sessionId, attempts: 1 });
  } catch (err) {
    // Still unsettled (review finding M4: logged once per distinct error).
    logRetryError(store, err);
  }
  return !reconcilePending.has(sessionId);
}
