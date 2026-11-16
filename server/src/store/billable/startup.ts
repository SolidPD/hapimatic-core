// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { ClockSynced } from "../../billable/clockSync";
import type { BillableMode } from "../../billable/mode";
import { safeJsonParse } from "../json";

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
 *    by which a session's timer exceeds the sum of its closed rows, under the id
 *    `carried_forward:<session id>:<n>:<anchor>` (issue #6651, `carriedForwardId`).
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

/**
 * The id of a `carried_forward` row (issue #6651, rule C):
 * `carried_forward:<session id>:<n>:<anchor>`.
 *
 * - `n` is one more than the session's count of `carried_forward` rows (under
 *   any id). No row is ever deleted, so it only grows, and two rows of one
 *   database never share an id, even when a clock set back repeats an anchor.
 * - `anchor` is the `started_at_ms` of the session's latest balance row
 *   (`opening_balance` or `carried_forward`), or 0 when it has none. Two copies of
 *   a database that both carry the excess held at the backup follow the same
 *   balance row with the same count, so a carry made again after a restore gets
 *   the same id as the first and a puller counts it once.
 * - The last two fields are integers, so the parts are recoverable even when a
 *   session id contains a colon; the prefix differs from `opening_balance:` and
 *   from a UUID.
 *
 * The rule does not rename rows written before it: a row under a random id keeps
 * that id, and counts in the next row's `n`.
 */
export function carriedForwardId(
  sessionId: string,
  ordinal: number,
  anchorMs: number
): string {
  return `carried_forward:${sessionId}:${ordinal}:${anchorMs}`;
}

/**
 * The name of what part 3 writes for a carried row. The daily check stores it in
 * every run row (`carriedForwardIdRule`, issue #6651, condition 3) and the boot
 * line prints it. A change to what part 3 writes for a carried row (the id, or
 * a key in its flags) changes this value, so that `evaluateBillableFlip` waits
 * for a daily check from the new release.
 */
export const CARRIED_FORWARD_ID_RULE =
  "carried_forward:<session id>:<n>:<anchor>; flags.cap v1; flags.clockSynced v1";

export interface BillableStartupOptions {
  /** The node id `server/src/index.ts` resolves; never `sessions.node_id`, which is NULL. */
  nodeId: string;
  mode: BillableMode;
  nowMs: number;
  /**
   * Whether the system clock was synchronized at this boot, as the entry point
   * read it (issue #6651); written into every carried row's flags. Default
   * `unknown`.
   */
  clockSynced?: ClockSynced;
}

export interface BillableStartupResult {
  openingBalanceRows: number;
  carriedForwardRows: number;
  repairedRows: number;
  timersChanged: number;
  /**
   * `carried_forward` rows whose id does not start with `carried_forward:` (or is
   * NULL): rows written before the id rule of #6651, which a restore from an
   * older backup would make again under a new id. Counted in every mode.
   */
  legacyCarriedForwardRows: number;
  /**
   * Sessions whose timer is above the sum of their closed rows after part 2 and
   * before part 3, and the sum of that excess, in every mode (#6651). After a
   * restore it says whether the restored backup held excess; in `on`,
   * `excessSessions` equals `carriedForwardRows`.
   */
  excessSessions: number;
  excessMs: number;
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
  const clockSynced: ClockSynced = options.clockSynced ?? "unknown";

  const insertBalance = db.prepare(
    "INSERT INTO thinking_intervals (" +
      "id, hapi_session_id, namespace, node_id, launcher_kind, recorded_mode, " +
      "stretch_started_at_ms, started_at_ms, last_seen_at_ms, ended_at_ms, " +
      "duration_ms, start_cause, end_cause, session_name, linked_issue, cwd, flags" +
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'balance', ?, NULL, NULL, NULL, ?)"
  );
  // The two reads of the carried_forward id rule (issue #6651), inside this
  // step's transaction, just before each insert.
  const countCarried = db.prepare(
    "SELECT COUNT(*) AS n FROM thinking_intervals " +
      "WHERE hapi_session_id = ? AND end_cause = 'carried_forward'"
  );
  // Under `ORDER BY change_seq DESC`, NULLs sort last, so a numbered balance row
  // is picked before an un-numbered one; un-numbered rows (a failed trigger DDL)
  // never reach a puller, because the feed serves `change_seq > cursor`.
  const latestBalanceStart = db.prepare(
    "SELECT started_at_ms FROM thinking_intervals WHERE hapi_session_id = ? " +
      "AND end_cause IN ('opening_balance', 'carried_forward') " +
      "ORDER BY change_seq DESC, started_at_ms DESC, id DESC LIMIT 1"
  );
  const addBalance = (
    session: SessionTimerRow,
    amountMs: number,
    endCause: "opening_balance" | "carried_forward",
    id: string,
    flags: string
  ): void => {
    insertBalance.run(
      // Both balance ids repeat when a row is made again after a restore, so a
      // puller counts it once. Review finding F3 (ruling 2026-11-12): an opening
      // balance's id is `opening_balance:<session id>`; part 1 writes at most one
      // per session (the marker and its NOT EXISTS test), so it cannot collide.
      // Issue #6651: a carried_forward row's id is `carriedForwardId` (part 3).
      id,
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
      endCause,
      flags
    );
  };
  // An opening balance's flags: its copy holds no dated row below it, so it
  // needs no cap key (plan of #6651, section 12 (i)).
  const OPENING_FLAGS = JSON.stringify({ noIntervalHistory: true });
  // The cap's key (issue #6651, Task C1): the copy's previous carried row, and
  // the closed dated `shadow` rows of this copy that started since it and before
  // this boot. Part 2 has just closed every open `shadow` row.
  const previousCarryStart = db.prepare(
    "SELECT started_at_ms FROM thinking_intervals WHERE hapi_session_id = ? " +
      "AND end_cause = 'carried_forward' " +
      "ORDER BY change_seq DESC, started_at_ms DESC, id DESC LIMIT 1"
  );
  const shadowSince = db.prepare(
    "SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM thinking_intervals " +
      "WHERE hapi_session_id = ? AND ended_at_ms IS NOT NULL " +
      "AND recorded_mode = 'shadow' " +
      "AND (end_cause IS NULL OR end_cause NOT IN ('opening_balance', 'carried_forward')) " +
      "AND started_at_ms >= ? AND started_at_ms < ?"
  );

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
        addBalance(
          session,
          session.timer,
          "opening_balance",
          `opening_balance:${session.id}`,
          OPENING_FLAGS
        );
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

    // The excess part 3 reads, counted in every mode for the boot line (#6651).
    const excess = db
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(excess), 0) AS ms FROM (" +
          "SELECT COALESCE(s.server_accumulated_ms, 0) - (" +
          "SELECT COALESCE(SUM(t.duration_ms), 0) FROM thinking_intervals t " +
          "WHERE t.hapi_session_id = s.id AND t.ended_at_ms IS NOT NULL" +
          ") AS excess FROM sessions s) WHERE excess > 0"
      )
      .get() as { n: number; ms: number };

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
          const n = 1 + (countCarried.get(session.id) as { n: number }).n;
          const anchor = latestBalanceStart.get(session.id) as {
            started_at_ms: number;
          } | null;
          const fromStartedAt =
            (
              previousCarryStart.get(session.id) as {
                started_at_ms: number;
              } | null
            )?.started_at_ms ?? 0;
          const shadowMs = (
            shadowSince.get(session.id, fromStartedAt, nowMs) as { ms: number }
          ).ms;
          addBalance(
            { ...session, timer: session.excess },
            session.excess,
            "carried_forward",
            carriedForwardId(session.id, n, anchor?.started_at_ms ?? 0),
            JSON.stringify({
              noIntervalHistory: true,
              cap: { v: 1, fromStartedAt, shadowMs },
              clockSynced,
            })
          );
          carriedForwardRows++;
        }
      }
    }

    // Rows written before the id rule (#6651). `substr`, not `LIKE`: `_` is a
    // LIKE wildcard; 16 is the length of `carried_forward:`.
    const legacy = db
      .prepare(
        "SELECT COUNT(*) AS n FROM thinking_intervals WHERE end_cause = 'carried_forward' " +
          "AND (id IS NULL OR substr(id, 1, 16) != 'carried_forward:')"
      )
      .get() as { n: number };

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
      legacyCarriedForwardRows: legacy.n,
      excessSessions: excess.n,
      excessMs: excess.ms,
    };
  });

  return run.immediate();
}
