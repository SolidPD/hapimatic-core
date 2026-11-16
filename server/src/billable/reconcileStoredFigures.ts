// SPDX-License-Identifier: AGPL-3.0-only
import type { Database } from "bun:sqlite";
import type { IntervalWriteCounters } from "./intervalWriteService";

/**
 * The daily check's stored figures (issue #6670): the lost-write totals of the
 * `writes` section (`compareLostWrites`), the balance rows of the `balance` section
 * (`compareBalance`), and the count of runs written by a build with #6670
 * (`isRunOf6670`, `countRunsOf6670InWindow`). It holds only code issue #6670 added
 * to the daily check (ruling R-CAP); `reconcile.ts` imports it and stays the one
 * entry that the server, the manual script and the tests call. Nothing here
 * writes a timer or an interval.
 */

/** The totals stored in `billable_lost_writes` when a run read them. */
export interface LostWritesTotals {
  setAsideTotal: number;
  leftAtStopTotal: number;
}

/** Adds one run-level `unexplained` row (no session, no namespace). */
export type RunLevelRow = (
  reason: string,
  extra: Record<string, unknown>
) => void;

/** The lost-write figures of the latest run row that holds stored totals (M7). */
interface PreviousLostWrites extends LostWritesTotals {
  pendingSetAside: number;
  bootId: string | null;
}

/**
 * Read from the latest run row that holds `lostWrites`, not from the latest run
 * row: after a revert and a second landing, or after a run whose read failed,
 * the latest row holds none, and the whole stored history would read as new.
 */
function readPreviousLostWrites(db: Database): PreviousLostWrites | null {
  const row = db
    .prepare(
      "SELECT detail_json FROM billable_reconcile WHERE row_type = 'run' AND json_valid(detail_json) " +
        "AND json_type(detail_json, '$.lostWrites') = 'object' ORDER BY run_at_ms DESC LIMIT 1"
    )
    .get() as { detail_json: string } | null;
  if (!row) return null;
  try {
    const d = JSON.parse(row.detail_json) as {
      lostWrites?: { setAsideTotal?: unknown; leftAtStopTotal?: unknown };
      writeService?: { pendingSetAside?: unknown; bootId?: unknown } | null;
    };
    const lw = d.lostWrites;
    if (
      typeof lw?.setAsideTotal !== "number" ||
      typeof lw.leftAtStopTotal !== "number"
    ) {
      return null;
    }
    return {
      setAsideTotal: lw.setAsideTotal,
      leftAtStopTotal: lw.leftAtStopTotal,
      pendingSetAside:
        typeof d.writeService?.pendingSetAside === "number"
          ? d.writeService.pendingSetAside
          : 0,
      bootId:
        typeof d.writeService?.bootId === "string"
          ? d.writeService.bootId
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * The stored part of the `writes` section, in both modes (#6670 item 4, D2-4,
 * D6-1): the totals are stored, so a write lost by a process that stopped before
 * its next check is listed; a lower total means the table was edited or
 * re-created. Writes lost between a backup and its restore are not listed.
 * `counters` is the running server's view (null without it); `prev` is the
 * latest run row's, for the fallback when the totals cannot be read (R9).
 * Returns the totals read, which the run row stores as `lostWrites`.
 */
export function compareLostWrites(input: {
  db: Database;
  counters: IntervalWriteCounters | null;
  prev: { bootId: string | null; setAsideCount: number | null };
  runLevel: RunLevelRow;
}): LostWritesTotals | null {
  const { db, prev, runLevel } = input;
  const c = input.counters;
  let lost: LostWritesTotals | null = null;
  let unreadable: Record<string, unknown> = { cause: "row_absent" };
  try {
    const row = db
      .prepare(
        "SELECT set_aside_total, left_at_stop_total FROM billable_lost_writes WHERE id = 1"
      )
      .get() as {
      set_aside_total: number;
      left_at_stop_total: number;
    } | null;
    lost = row
      ? {
          setAsideTotal: row.set_aside_total,
          leftAtStopTotal: row.left_at_stop_total,
        }
      : null;
  } catch (error) {
    unreadable = {
      cause: "read_threw",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (lost === null) {
    // The totals cannot be read (#6670 F1). A check that cannot read its own
    // evidence must not read clean, so this is listed and the run is not clean.
    // The table and its row (1, 0, 0, 0) are made at every boot
    // (`applyBillableMigrations`), so a missing row is not a healthy state either;
    // a healthy node that never lost a write reads zeros and lists nothing.
    runLevel("lost_writes_unreadable", unreadable);
    // The in-memory count, compared within one boot (R9).
    if (c !== null) {
      const sameBoot = prev.bootId !== null && prev.bootId === c.bootId;
      if (
        c.setAsideCount > 0 &&
        (!sameBoot || c.setAsideCount !== prev.setAsideCount)
      ) {
        runLevel("set_aside", {
          setAsideCount: c.setAsideCount,
          previous: prev.setAsideCount,
          sameBoot,
        });
      }
    }
    return null;
  }
  const prevLost = readPreviousLostWrites(db);
  // The stored total and the pending count stay two figures: stored as one sum,
  // a crash made the next check write a false `reset` row. The comparison errs
  // high, never low.
  const pending = c?.pendingSetAside ?? 0;
  const sameBoot =
    c !== null &&
    prevLost !== null &&
    prevLost.bootId !== null &&
    prevLost.bootId === c.bootId;
  // None stored: the table began at this build's deploy.
  const prevStored = prevLost?.setAsideTotal ?? 0;
  const prevFigure =
    prevStored + (sameBoot ? (prevLost?.pendingSetAside ?? 0) : 0);
  const figure = lost.setAsideTotal + pending;
  if (lost.setAsideTotal < prevStored) {
    runLevel("set_aside", {
      setAsideTotal: lost.setAsideTotal,
      previousTotal: prevStored,
      reset: true,
    });
  } else if (figure > prevFigure) {
    runLevel("set_aside", {
      setAsideTotal: lost.setAsideTotal,
      pending,
      previousTotal: prevLost?.setAsideTotal ?? null,
      newSinceLastRun: figure - prevFigure,
      previousPendingOfAnotherBoot: !sameBoot
        ? (prevLost?.pendingSetAside ?? 0)
        : 0,
    });
  }
  const prevLS = prevLost?.leftAtStopTotal ?? 0;
  if (lost.leftAtStopTotal < prevLS) {
    runLevel("left_at_stop", {
      leftAtStopTotal: lost.leftAtStopTotal,
      previousTotal: prevLS,
      reset: true,
    });
  } else if (lost.leftAtStopTotal > prevLS) {
    runLevel("left_at_stop", {
      leftAtStopTotal: lost.leftAtStopTotal,
      newSinceLastRun: lost.leftAtStopTotal - prevLS,
    });
  }
  return lost;
}

/**
 * A run row written by a build with #6670: it holds the write service's boot id
 * and the stored lost-write totals (ruling M9, condition 4). A fixed build whose
 * `billable_lost_writes` table is missing stores `lostWrites: null` and does not
 * pass.
 */
export function isRunOf6670(detail: Record<string, unknown> | null): boolean {
  const ws = detail?.writeService as { bootId?: unknown } | null | undefined;
  const lost = detail?.lostWrites;
  return (
    typeof ws?.bootId === "string" && typeof lost === "object" && lost !== null
  );
}

/**
 * The run rows of the window ending at `nowMs` for which {@link isRunOf6670}
 * holds (`inWindow`), the number of run rows in that window (`runsInWindow`), and
 * the `run_at_ms` of the oldest run row of any age for which it holds
 * (`firstAtMs`). Reads `billable_reconcile` only (#6670 X5).
 */
export function countRunsOf6670InWindow(
  db: Database,
  nowMs: number,
  windowMs: number
): { inWindow: number; runsInWindow: number; firstAtMs: number | null } {
  const rows = db
    .prepare(
      "SELECT run_at_ms, detail_json FROM billable_reconcile WHERE row_type = 'run' ORDER BY run_at_ms"
    )
    .all() as Array<{ run_at_ms: number; detail_json: string | null }>;
  let inWindow = 0;
  let runsInWindow = 0;
  let firstAtMs: number | null = null;
  for (const r of rows) {
    let detail: Record<string, unknown> | null = null;
    try {
      detail = r.detail_json
        ? (JSON.parse(r.detail_json) as Record<string, unknown>)
        : null;
    } catch {
      detail = null;
    }
    const of6670 = isRunOf6670(detail);
    if (of6670 && firstAtMs === null) firstAtMs = r.run_at_ms;
    if (r.run_at_ms >= nowMs - windowMs) {
      runsInWindow++;
      if (of6670) inWindow++;
    }
  }
  return { inWindow, runsInWindow, firstAtMs };
}

/** The count and the sum of each kind of balance row, node-wide (#6670 X6). */
export interface BalanceFigures {
  openingCount: number;
  openingMs: number;
  carriedCount: number;
  carriedMs: number;
}

const BALANCE_KEYS = [
  "openingCount",
  "openingMs",
  "carriedCount",
  "carriedMs",
] as const;

/**
 * The `balance` section, in both modes (#6670 X6, R17). Only the start-up step
 * writes balance rows, and nothing deletes a row of `thinking_intervals`, so each
 * figure can only grow: a lower one than the latest run row that holds them lists
 * one `balance_lost` row. The figures are node-wide totals and hold no session
 * value. The read is not in a `try`: like the other reads of `thinking_intervals`,
 * a throw fails the run. A run with no earlier figures only stores them.
 */
export function compareBalance(input: {
  db: Database;
  runLevel: RunLevelRow;
}): BalanceFigures {
  const { db, runLevel } = input;
  const rows = db
    .prepare(
      "SELECT end_cause, COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM thinking_intervals " +
        "WHERE end_cause IN ('opening_balance', 'carried_forward') GROUP BY end_cause"
    )
    .all() as Array<{ end_cause: string; n: number; ms: number }>;
  const figures: BalanceFigures = {
    openingCount: 0,
    openingMs: 0,
    carriedCount: 0,
    carriedMs: 0,
  };
  for (const r of rows) {
    if (r.end_cause === "opening_balance") {
      figures.openingCount = r.n;
      figures.openingMs = r.ms;
    } else {
      figures.carriedCount = r.n;
      figures.carriedMs = r.ms;
    }
  }
  const prevRow = db
    .prepare(
      "SELECT detail_json FROM billable_reconcile WHERE row_type = 'run' AND json_valid(detail_json) " +
        "AND json_type(detail_json, '$.balanceRows') = 'object' ORDER BY run_at_ms DESC LIMIT 1"
    )
    .get() as { detail_json: string } | null;
  let previous: BalanceFigures | null = null;
  if (prevRow) {
    const p = (
      JSON.parse(prevRow.detail_json) as {
        balanceRows: Record<string, unknown>;
      }
    ).balanceRows;
    if (BALANCE_KEYS.every(k => typeof p[k] === "number")) {
      previous = p as unknown as BalanceFigures;
    }
  }
  if (previous && BALANCE_KEYS.some(k => figures[k] < previous[k])) {
    runLevel("balance_lost", {
      ...figures,
      previous: {
        openingCount: previous.openingCount,
        openingMs: previous.openingMs,
        carriedCount: previous.carriedCount,
        carriedMs: previous.carriedMs,
      },
    });
  }
  return figures;
}
