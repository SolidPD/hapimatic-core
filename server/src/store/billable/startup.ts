// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { BillableMode } from "../../billable/mode";
import { safeJsonParse } from "../json";
import { newUuidV7 } from "../turns/ids";

/**
 * The billable-time start-up step (issue #6586, R17). The entry point calls it
 * once per boot, in every mode, before `new SyncEngine` and so before the web
 * server listens: no CLI can be connected yet, so every open row belongs to a
 * previous process. It is not run from `runMigrations()`, which knows neither the
 * node id nor the mode.
 *
 * Five parts, in this order, inside ONE `BEGIN IMMEDIATE` transaction (it reads
 * before it writes, and a read-then-write under a deferred BEGIN returns
 * SQLITE_BUSY with no wait; the marker, the rows and the timers commit together
 * or not at all):
 *
 * 1. Opening balance (every mode, once): one `opening_balance` row per session
 *    whose timer is above zero, then the marker.
 * 2. Repair of rows recorded in `shadow` (every mode): an open row, or a
 *    `hub_restart` row last seen after its end, is closed at its last-seen time as
 *    `hub_restart`. No timer write: in `shadow` the old clock owned the timer and
 *    lost that stretch at the restart.
 * 3. Carry-forward (`on` only): one undated `carried_forward` row for the amount
 *    by which a session's timer exceeds the sum of its closed rows.
 * 4. Repair of rows recorded in `on` (every mode): as part 2; a boot in `shadow` or
 *    `off` also credits the session's timer with the time each row gained,
 *    because that time accrued while intervals drove the timer and today's code,
 *    which owns the timer in this boot, cannot add it.
 * 5. Timer set (`on` only): every session's timer becomes the sum of its closed
 *    rows.
 *
 * Why this order: part 1 before part 3, so a first boot in `on` records the
 * opening balance and not a carry-forward; part 2 before part 3, because a
 * `shadow` row's time is not in the old-clock timer; part 3 before part 4,
 * because an `on` row's time is owed to the timer and repairing it first would
 * subtract it from the carried amount (worked case: timer 1,500,000 ms, closed
 * sum 600,000 ms, one open `on` row of 45,000 ms → carry 900,000 ms, timer
 * 1,545,000 ms; repair-first would carry 855,000 and end at 1,500,000); part 5
 * last, so it sees every row the others wrote.
 *
 * It does not catch: any throw rolls back all five parts and propagates, and the
 * caller runs that boot as `off`, because exactly one writer may own the timer in
 * a boot.
 */

export const OPENING_BALANCE_MARKER = "billable_opening_balance_v1";

export interface BillableStartupOptions {
  /** The node id `server/src/index.ts` resolves; never `sessions.node_id`, which is NULL. */
  nodeId: string;
  mode: BillableMode;
  nowMs: number;
}

export interface BillableStartupResult {
  openingBalanceRows: number;
  carriedForwardRows: number;
  repairedRows: number;
  timersChanged: number;
}

interface SessionTimerRow {
  id: string;
  namespace: string;
  metadata: string | null;
  timer: number;
}

interface RepairCandidate {
  id: string;
  hapi_session_id: string;
  started_at_ms: number;
  last_seen_at_ms: number;
  ended_at_ms: number | null;
  duration_ms: number | null;
}

/** `metadata.launcherKind` when it is a string, else `'unknown'`; never throws. */
function launcherKindOf(metadata: string | null): string {
  const parsed = safeJsonParse(metadata);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const kind = (parsed as { launcherKind?: unknown }).launcherKind;
    if (typeof kind === "string" && kind.length > 0) return kind;
  }
  return "unknown";
}

export function runBillableStartup(
  db: Database,
  options: BillableStartupOptions
): BillableStartupResult {
  const { nodeId, mode, nowMs } = options;

  const insertBalance = db.prepare(
    "INSERT INTO thinking_intervals (" +
      "id, hapi_session_id, namespace, node_id, launcher_kind, recorded_mode, " +
      "stretch_started_at_ms, started_at_ms, last_seen_at_ms, ended_at_ms, " +
      "duration_ms, start_cause, end_cause, session_name, linked_issue, cwd, flags" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'balance', ?, NULL, NULL, NULL, " +
      `'{"noIntervalHistory":true}')`
  );
  const addBalance = (
    session: SessionTimerRow,
    amountMs: number,
    endCause: "opening_balance" | "carried_forward"
  ): void => {
    insertBalance.run(
      // Review finding F3 (ruling 2026-11-12): an opening balance's id is
      // derived from its session id and nothing else, so a row made again after
      // a restore from an older backup reaches a puller under the same
      // interval_id and is counted once. Part 1 writes at most one per session
      // (the marker and its NOT EXISTS test), so the id cannot collide. A
      // carried_forward row keeps a random id in this build: a rule for it is
      // the third condition for switching a node to `on` (reconcile.ts).
      endCause === "opening_balance"
        ? `opening_balance:${session.id}`
        : newUuidV7(),
      session.id,
      session.namespace,
      nodeId,
      launcherKindOf(session.metadata),
      mode,
      nowMs,
      nowMs,
      nowMs,
      nowMs,
      amountMs,
      endCause
    );
  };

  const repair = (recordedMode: "shadow" | "on"): RepairCandidate[] => {
    const rows = db
      .prepare(
        "SELECT id, hapi_session_id, started_at_ms, last_seen_at_ms, ended_at_ms, " +
          "duration_ms FROM thinking_intervals WHERE recorded_mode = ? AND (" +
          "ended_at_ms IS NULL OR (end_cause = 'hub_restart' AND " +
          "last_seen_at_ms > ended_at_ms))"
      )
      .all(recordedMode) as RepairCandidate[];
    const close = db.prepare(
      "UPDATE thinking_intervals SET end_cause = 'hub_restart', " +
        "duration_ms = MAX(0, last_seen_at_ms - started_at_ms), " +
        "ended_at_ms = MAX(last_seen_at_ms, started_at_ms) WHERE id = ?"
    );
    for (const row of rows) close.run(row.id);
    return rows;
  };

  const run = db.transaction((): BillableStartupResult => {
    let openingBalanceRows = 0;
    let carriedForwardRows = 0;
    const credited = new Set<string>();
    let timersChanged = 0;

    // The sequence floor (review finding F1, ruling 2026-11-12), first and in
    // every mode: raise the change counter to this boot's time, never lower it.
    // A database restored from a backup has the backup's counter, below numbers
    // the lost process went on to issue; without the floor the rows closed after
    // the restore would get numbers a puller has already passed and, once the
    // counter climbed back past its cursor, would never be mirrored. From here on
    // the triggers give every row closed in this boot a change_seq above nowMs,
    // this step's own rows included. It rolls back with the five parts. It ships
    // only with the opening-balance id rule (part 1), because with the floor a
    // balance row made again after a restore always reaches the puller.
    db.prepare(
      "UPDATE thinking_interval_change_seq SET value = MAX(value, ?) WHERE id = 1"
    ).run(nowMs);

    // Part 1 — opening balance. A missing `_migration_markers` table throws here.
    const marker = db
      .prepare("SELECT key FROM _migration_markers WHERE key = ?")
      .get(OPENING_BALANCE_MARKER);
    if (marker == null) {
      const sessions = db
        .prepare(
          "SELECT s.id, s.namespace, s.metadata, " +
            "COALESCE(s.server_accumulated_ms, 0) AS timer FROM sessions s " +
            "WHERE COALESCE(s.server_accumulated_ms, 0) > 0 AND NOT EXISTS (" +
            "SELECT 1 FROM thinking_intervals t WHERE t.hapi_session_id = s.id " +
            "AND t.end_cause = 'opening_balance')"
        )
        .all() as SessionTimerRow[];
      for (const session of sessions) {
        addBalance(session, session.timer, "opening_balance");
        openingBalanceRows++;
      }
      db.prepare(
        "INSERT INTO _migration_markers " +
          "(key, applied_at, rows_affected, strategy, metadata) " +
          "VALUES (?, ?, ?, ?, ?)"
      ).run(
        OPENING_BALANCE_MARKER,
        nowMs,
        openingBalanceRows,
        "billable-opening-balance",
        JSON.stringify({ issue: 6586, nodeId, mode })
      );
    }

    // Part 2 — repair of rows recorded in `shadow`; no timer write in any mode.
    const shadowRepaired = repair("shadow");

    // Part 3 — carry-forward (`on` only), before the `on` rows are repaired.
    if (mode === "on") {
      const sessions = db
        .prepare(
          "SELECT s.id, s.namespace, s.metadata, " +
            "COALESCE(s.server_accumulated_ms, 0) - (" +
            "SELECT COALESCE(SUM(t.duration_ms), 0) FROM thinking_intervals t " +
            "WHERE t.hapi_session_id = s.id AND t.ended_at_ms IS NOT NULL" +
            ") AS excess FROM sessions s"
        )
        .all() as Array<Omit<SessionTimerRow, "timer"> & { excess: number }>;
      for (const session of sessions) {
        if (session.excess > 0) {
          addBalance(
            { ...session, timer: session.excess },
            session.excess,
            "carried_forward"
          );
          carriedForwardRows++;
        }
      }
    }

    // Part 4 — repair of rows recorded in `on`; outside `on`, credit the timer
    // with what each row gained (its whole duration for a row that was open; the
    // increase for a `hub_restart` row closed again).
    const onRepaired = repair("on");
    if (mode !== "on") {
      const credit = db.prepare(
        "UPDATE sessions SET server_accumulated_ms = " +
          "COALESCE(server_accumulated_ms, 0) + ? WHERE id = ?"
      );
      const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?");
      for (const row of onRepaired) {
        const newDuration = Math.max(
          0,
          row.last_seen_at_ms - row.started_at_ms
        );
        const gained =
          row.ended_at_ms === null
            ? newDuration
            : newDuration - (row.duration_ms ?? 0);
        if (gained <= 0) continue;
        credit.run(gained, row.hapi_session_id);
        if (exists.get(row.hapi_session_id) != null) {
          credited.add(row.hapi_session_id);
        }
      }
      timersChanged += credited.size;
    }

    // Part 5 — timer set (`on` only).
    if (mode === "on") {
      const sumSql =
        "(SELECT COALESCE(SUM(t.duration_ms), 0) FROM thinking_intervals t " +
        "WHERE t.hapi_session_id = sessions.id AND t.ended_at_ms IS NOT NULL)";
      timersChanged += (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM sessions WHERE server_accumulated_ms IS NOT ${sumSql}`
          )
          .get() as { n: number }
      ).n;
      db.prepare(
        `UPDATE sessions SET server_accumulated_ms = ${sumSql} ` +
          `WHERE server_accumulated_ms IS NOT ${sumSql}`
      ).run();
    }

    return {
      openingBalanceRows,
      carriedForwardRows,
      repairedRows: shadowRepaired.length + onRepaired.length,
      timersChanged,
    };
  });

  return run.immediate();
}
