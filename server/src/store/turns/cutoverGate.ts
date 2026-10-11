// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from "node:fs/promises";

import { loadTimelogCutoverConfig } from "../../config/timelogCutoverConfig";
import {
  PARITY_METRICS,
  loadParityThresholds,
} from "../../parity/parityThresholds";
import type {
  CutoverGateReport,
  ParityRunsStore,
  SoakHealthReport,
} from "../parityRuns";

/**
 * Time-log read-path cutover gate (issue #1670, Sub H1, epic #1662).
 *
 * The displayed time log does NOT switch to the derived read path
 * (`timelogDerivation.ts`) until this gate opens. Originally the only opener was
 * Sub-G's nightly parity harness reporting an N-day green streak across every
 * gated metric — `getCutoverGateReport(...).overallReady`, with the streak
 * length from the operator-tunable `streakDays` (settings.json
 * `parityThresholds`, default 7).
 *
 * #2247 (per the #1892 "Gate re-scope #2 (2026-07-19)" decision record) adds an
 * OPERATOR OVERRIDE: settings.json `{ "timelogCutover": { "force": true } }`
 * forces the gate open regardless of parity streaks. Parity data stays REAL
 * (the harness continues as a non-gating background self-audit) — only the
 * composite readiness is forced. All exported helpers honor the override
 * uniformly so a split-brain gate is impossible.
 *
 * Live wiring: `GET /timelogs/cutover-status` (`timeLog.ts`) calls
 * `getTimelogSoakStatus`; the web client branches its read path on the returned
 * `ready`. `isTimelogCutoverReady` / `getTimelogCutoverGate` currently have no
 * production callers (retained for #1892 H2's gate check).
 */

/** Minimal store shape — accepts the real `Store` or a test stub. */
export interface CutoverGateStore {
  parityRuns: Pick<ParityRunsStore, "getCutoverGateReport">;
}

/**
 * Full machine-readable cutover-gate report: per-metric streak + readiness, and
 * the overall `overallReady` flag. Loads `streakDays` fresh from the parity
 * thresholds (mirrors the parity harness entrypoint) so an operator override
 * takes effect without a restart.
 *
 * #2247: the operator cutover override (`timelogCutover.force`) forces
 * `overallReady` to true; the per-metric streak data stays real.
 */
export async function getTimelogCutoverGate(
  store: CutoverGateStore,
  dataDir: string
): Promise<CutoverGateReport> {
  const thresholds = await loadParityThresholds(dataDir);
  const cutover = await loadTimelogCutoverConfig(dataDir);
  const report = store.parityRuns.getCutoverGateReport(
    PARITY_METRICS,
    thresholds.streakDays
  );
  // OR, never replace: the override only ADDS readiness — it can never turn an
  // organically-green gate red. Unset → the raw report, byte-identical.
  return cutover.force ? { ...report, overallReady: true } : report;
}

/**
 * Convenience boolean: is the time-log read-path cutover gate open? PR-2's
 * read-path switch checks this before reading the derived path; while false, the
 * legacy path is served (R1 dormancy).
 */
export async function isTimelogCutoverReady(
  store: CutoverGateStore,
  dataDir: string
): Promise<boolean> {
  const report = await getTimelogCutoverGate(store, dataDir);
  return report.overallReady;
}

/** Store shape for the soak-status readout (issue #2188 V4). */
export interface SoakStatusStore {
  parityRuns: Pick<ParityRunsStore, "getSoakHealth" | "getLatestRun">;
}

/** One red bucket from the latest run's artifact (`{metric, namespace, key, deltaPct}`). */
export interface SoakRedBucket {
  metric: string;
  namespace: string;
  key: string;
  deltaPct: number;
  offendingTurnIds?: string[];
}

/**
 * Enriched `cutover-status` payload (issue #2188 R5). `ready` is the SAME
 * predicate as {@link isTimelogCutoverReady} (every gated metric's system-wide
 * streak ≥ streakDays) — backward-compatible by construction (R6).
 */
export interface TimelogSoakStatus {
  ready: boolean;
  /**
   * Present (true) only when the operator override (settings.json
   * `timelogCutover.force`, #2247) forces the gate open. `perMetric` /
   * `redBuckets` keep reporting real parity data — future monitoring must key
   * off those, not the composite `ready`.
   */
  forced?: boolean;
  streakDays: number;
  daysToGate: number;
  perMetric: SoakHealthReport["perMetric"];
  redBuckets: SoakRedBucket[];
}

function asSoakRedBuckets(value: unknown): SoakRedBucket[] {
  if (!Array.isArray(value)) return [];
  const out: SoakRedBucket[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.metric !== "string" ||
      typeof r.namespace !== "string" ||
      typeof r.key !== "string" ||
      typeof r.deltaPct !== "number"
    ) {
      continue;
    }
    out.push({
      metric: r.metric,
      namespace: r.namespace,
      key: r.key,
      deltaPct: r.deltaPct,
      ...(Array.isArray(r.offendingTurnIds)
        ? {
            offendingTurnIds: r.offendingTurnIds.filter(
              (id): id is string => typeof id === "string"
            ),
          }
        : {}),
    });
  }
  return out;
}

/**
 * Soak-health readout for `GET /timelogs/cutover-status` (issue #2188 V4).
 *
 * `redBuckets` is sourced from the latest system-wide run's RECORDED artifact:
 * the most recent `namespace='*'` row's `artifact_path` (written by
 * `recordRun`), NOT a per-request scan of `<dataDir>/parity/` — the route is
 * polled every 60s per open client, and a `--full` backfill artifact shares the
 * `<runDate>.json` naming and can be MBs. Defensive read: a null/missing/
 * unparseable artifact yields `redBuckets: []`, never a throw.
 */
export async function getTimelogSoakStatus(
  store: SoakStatusStore,
  dataDir: string
): Promise<TimelogSoakStatus> {
  const thresholds = await loadParityThresholds(dataDir);
  const health = store.parityRuns.getSoakHealth(
    PARITY_METRICS,
    thresholds.streakDays
  );

  // Latest '*' row's artifact_path across the gated metrics (all system-wide
  // rows of one run share the same artifact path — take the max run_date).
  let latestDate = "";
  let artifactPath: string | null = null;
  for (const metric of PARITY_METRICS) {
    const row = store.parityRuns.getLatestRun(metric);
    if (row && row.run_date >= latestDate && row.artifact_path) {
      latestDate = row.run_date;
      artifactPath = row.artifact_path;
    }
  }

  let redBuckets: SoakRedBucket[] = [];
  if (artifactPath) {
    try {
      const raw = await readFile(artifactPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      redBuckets = asSoakRedBuckets(parsed.redBuckets);
    } catch {
      redBuckets = []; // missing/unreadable artifact — degrade, never throw
    }
  }

  // #2247: load the operator override AFTER computing real health/artifact data
  // — the self-audit must stay live under force. OR, never replace: force only
  // ADDS readiness. The conditional spread keeps the unforced payload
  // byte-identical to the pre-#2247 shape (no `forced` key emitted).
  const cutover = await loadTimelogCutoverConfig(dataDir);

  return {
    ready: cutover.force || health.ready,
    streakDays: health.streakDays,
    daysToGate: health.daysToGate,
    perMetric: health.perMetric,
    redBuckets,
    ...(cutover.force ? { forced: true } : {}),
  };
}
