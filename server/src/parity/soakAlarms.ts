// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Soak alarm decision core (issue #2188 V1/V2 — R1, R2, R3).
 *
 * A GENUINELY pure, testable function: it takes the stuck-window result as
 * pre-computed DATA (no store handle, no I/O of any kind), so the alarm logic
 * isn't buried in the un-unit-tested entrypoint (mirrors the harness's
 * pure-core / thin-shell pattern). The entrypoint
 * (`server/scripts/parity-harness-run.ts`) performs the store read
 * (`parityRuns.getStuckAtZeroWindow(PARITY_METRICS, MIN_STUCK_DAYS)`) and
 * passes the result in; it also owns the `notify-pm.sh` spawn, the env gate,
 * and the try/catch (R6 — alarms never throw into the harness).
 *
 * Dedup contract: at most ONE alarm per run — a wiring anomaly already
 * explains a stuck soak, so `wiring-anomaly` wins over `stuck-at-zero`.
 * Returns `[]` when healthy (R2). No I/O, no `Date.now()`.
 */

import type { ParityRunResult } from "./parityHarness";

/**
 * D1 sliding-window size: consecutive all-streak-zero nightly runs before the
 * soak is declared structurally stuck (issue #2188 V1). Exported so the
 * entrypoint's `getStuckAtZeroWindow` read uses the same constant.
 */
export const MIN_STUCK_DAYS = 2;

export interface SoakAlarm {
  kind: "wiring-anomaly" | "stuck-at-zero";
  severity: "high";
  subject: string;
  body: string;
}

export interface SoakAlarmDeps {
  /** Pre-computed result of `parityRuns.getStuckAtZeroWindow(...)` — data, not a handle. */
  stuckWindow: { stuck: boolean; runDatesChecked: number };
  /** Operator-tunable gate streak length (parity thresholds). */
  streakDays: number;
}

/**
 * Decide which (single) alarm this run warrants:
 *
 *   (a) wiring anomalies present → one `wiring-anomaly` alarm (R3) — the run
 *       is not a valid soak data point (wiring bug, not a tolerance miss);
 *       note the red rows ARE still recorded and DO reset `streak_len`.
 *   (b) else stuck window → one `stuck-at-zero` alarm (R1).
 *   (c) else → `[]` (R2).
 */
export function evaluateSoakAlarms(
  result: ParityRunResult,
  deps: SoakAlarmDeps
): SoakAlarm[] {
  if (result.wiringAnomalies.length > 0) {
    const kinds = [...new Set(result.wiringAnomalies.map(a => a.kind))].join(
      ", "
    );
    const lines = result.wiringAnomalies.map(
      a => `- [${a.comparator}] ${a.kind}: ${a.detail}`
    );
    return [
      {
        kind: "wiring-anomaly",
        severity: "high",
        subject: `🚨 Parity harness WIRING BUG (${kinds}) — ${result.runDate} @ ${result.nodeId}`,
        body:
          `The nightly parity harness detected comparator-input wiring ` +
          `anomalies on ${result.runDate} (node ${result.nodeId}). This run is ` +
          `not a valid soak data point (wiring bug, not a tolerance miss); its ` +
          `red rows still reset the streaks.\n\n` +
          `${lines.join("\n")}\n\n` +
          `See error-log category "parity-harness-wiring" and the run artifact ` +
          `for full context.`,
      },
    ];
  }

  if (deps.stuckWindow.stuck) {
    return [
      {
        kind: "stuck-at-zero",
        severity: "high",
        subject: `🚨 Parity soak STUCK at zero for ${deps.stuckWindow.runDatesChecked}+ runs — ${result.runDate} @ ${result.nodeId}`,
        body:
          `Every gated parity metric's system-wide streak has been 0 for the ` +
          `most recent ${deps.stuckWindow.runDatesChecked} consecutive nightly ` +
          `runs (latest: ${result.runDate}, node ${result.nodeId}). The ` +
          `${deps.streakDays}-day cutover soak is structurally stuck — it can ` +
          `never open from this state without intervention.\n\n` +
          `Check the latest run artifact's redBuckets and the ` +
          `/api/timelogs/cutover-status readout for which metrics are red and why.`,
      },
    ];
  }

  return [];
}
