// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Persisted shadow-mode parity run-records (issue #1669, epic #1662, Sub G).
 *
 * `parity_runs` is the durable ledger that lets the N-day green-streak and the
 * cutover-gate report survive daemon restarts and be queried per node (R8). The
 * full per-bucket diff lives in the nightly artifact (`<HAPI_HOME>/parity/<date>.json`);
 * this table holds the rolled-up per-metric verdict + the running streak so Sub H
 * (#1670) / Sub I (#1671) can read `getCutoverGateReport()` cheaply.
 *
 * Migration shape mirrors `turns/schema.ts` `applyTurnsMigrations`: a fail-open
 * idempotent `CREATE TABLE IF NOT EXISTS` block called from `Store.runMigrations()`
 * (the #1122 fix runs `runMigrations()` on every boot — fresh AND existing — so all
 * new tables belong there). It MUST NOT bump `SCHEMA_VERSION` (D7: `user_version`
 * is a frozen mismatch gate). The store class mirrors `MidnightResetStateStore`.
 * (DDL uses `prepare().run()` per statement rather than `db.exec` so the migration
 * surface stays one-statement-per-call.)
 *
 * SCOPE convention: one row per `(run_date, namespace, metric)`. `namespace = '*'`
 * is the SYSTEM-WIDE aggregate (worst status across all real namespaces for that
 * metric) — the streak/gate read the `'*'` rows; real-namespace rows are kept for
 * diagnostics.
 */

import type { Database } from "bun:sqlite";

/** Sentinel namespace for the system-wide aggregate row that drives the gate. */
export const SYSTEM_WIDE_NAMESPACE = "*";

export type ParityRunStatus = "green" | "within-bias" | "red";

/** One verdict to persist for a (run_date, namespace, metric) tuple. */
export interface ParityRunRecord {
  runDate: string; // YYYY-MM-DD
  namespace: string; // '*' = system-wide aggregate
  metric: string; // ParityMetric value
  status: ParityRunStatus;
  deltaPct: number | null;
  thresholdOverPct: number | null;
  thresholdUnderPct: number | null;
  artifactPath: string | null;
  nodeId: string;
}

export interface CutoverGateReport {
  perMetric: Record<
    string,
    { streakLen: number; status: ParityRunStatus; ready: boolean }
  >;
  /** True when EVERY gated metric's system-wide streak ≥ streakDays. */
  overallReady: boolean;
  streakDays: number;
}

/**
 * Soak-health readout consumed by the V4 `cutover-status` enrichment
 * (issue #2188 R5). `ready` uses the SAME predicate as {@link CutoverGateReport}
 * (`overallReady`), so the route's pre-existing `ready` boolean is unchanged.
 */
export interface SoakHealthReport {
  perMetric: Record<
    string,
    {
      streakLen: number;
      status: ParityRunStatus;
      ready: boolean;
      /** Most recent NON-RED run date, or "never" — see getLastGreenDate. */
      lastGreen: string;
      daysToGate: number;
    }
  >;
  /** True when EVERY gated metric's system-wide streak ≥ streakDays. */
  ready: boolean;
  streakDays: number;
  /** Max per-metric daysToGate (0 when ready). */
  daysToGate: number;
}

interface ParityRunDbRow {
  id: string;
  run_date: string;
  namespace: string;
  metric: string;
  status: string;
  delta_pct: number | null;
  threshold_over_pct: number | null;
  threshold_under_pct: number | null;
  streak_len: number;
  artifact_path: string | null;
  node_id: string;
  schema_version: number;
  created_at: number;
}

/**
 * Create the `parity_runs` table + index. Idempotent; fail-open (logs but never
 * aborts daemon boot). Called from `Store.runMigrations()`.
 */
export function applyParityMigrations(db: Database): void {
  try {
    db.prepare(
      `CREATE TABLE IF NOT EXISTS parity_runs (
        id                   TEXT PRIMARY KEY,
        run_date             TEXT NOT NULL,
        namespace            TEXT NOT NULL,
        metric               TEXT NOT NULL,
        status               TEXT NOT NULL,
        delta_pct            REAL,
        threshold_over_pct   REAL,
        threshold_under_pct  REAL,
        streak_len           INTEGER NOT NULL DEFAULT 0,
        artifact_path        TEXT,
        node_id              TEXT NOT NULL,
        schema_version       INTEGER NOT NULL DEFAULT 1,
        created_at           INTEGER NOT NULL,
        UNIQUE(run_date, namespace, metric)
      )`
    ).run();
    db.prepare(
      `CREATE INDEX IF NOT EXISTS idx_parity_runs_metric_ns
        ON parity_runs(metric, namespace, run_date)`
    ).run();
  } catch (error) {
    console.error(`[Store] Migration failed: CREATE TABLE parity_runs:`, error);
  }
}

function isPass(status: ParityRunStatus): boolean {
  return status !== "red";
}

let monotonicCounter = 0;

/** Per-row id (avoids Date.now()/Math.random() in the hot path). */
function nextId(runDate: string, namespace: string, metric: string): string {
  monotonicCounter += 1;
  return `pr_${runDate}_${namespace}_${metric}_${monotonicCounter}`;
}

export class ParityRunsStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Persist one verdict, computing its streak from the most recent PRIOR
   * run-date for the same (metric, namespace). A PASS (`green`/`within-bias`)
   * increments the prior streak; a `red` resets it to 0. Idempotent on
   * `(run_date, namespace, metric)` — re-running the same date recomputes the
   * streak from strictly-earlier dates, so a re-run does not double-count.
   */
  recordRun(record: ParityRunRecord, nowMs: number): { streakLen: number } {
    const prior = this.db
      .prepare(
        `SELECT streak_len FROM parity_runs
         WHERE metric = ? AND namespace = ? AND run_date < ?
         ORDER BY run_date DESC LIMIT 1`
      )
      .get(record.metric, record.namespace, record.runDate) as
      | { streak_len: number }
      | undefined;

    const priorStreak = prior?.streak_len ?? 0;
    const streakLen = isPass(record.status) ? priorStreak + 1 : 0;

    this.db
      .prepare(
        `INSERT INTO parity_runs
           (id, run_date, namespace, metric, status, delta_pct,
            threshold_over_pct, threshold_under_pct, streak_len,
            artifact_path, node_id, schema_version, created_at)
         VALUES
           (@id, @run_date, @namespace, @metric, @status, @delta_pct,
            @threshold_over_pct, @threshold_under_pct, @streak_len,
            @artifact_path, @node_id, 1, @created_at)
         ON CONFLICT(run_date, namespace, metric) DO UPDATE SET
           status = excluded.status,
           delta_pct = excluded.delta_pct,
           threshold_over_pct = excluded.threshold_over_pct,
           threshold_under_pct = excluded.threshold_under_pct,
           streak_len = excluded.streak_len,
           artifact_path = excluded.artifact_path,
           node_id = excluded.node_id,
           created_at = excluded.created_at`
      )
      .run({
        id: nextId(record.runDate, record.namespace, record.metric),
        run_date: record.runDate,
        namespace: record.namespace,
        metric: record.metric,
        status: record.status,
        delta_pct: record.deltaPct,
        threshold_over_pct: record.thresholdOverPct,
        threshold_under_pct: record.thresholdUnderPct,
        streak_len: streakLen,
        artifact_path: record.artifactPath,
        node_id: record.nodeId,
        created_at: nowMs,
      });

    return { streakLen };
  }

  /** Latest persisted row for a (metric, namespace), or null. */
  getLatestRun(
    metric: string,
    namespace: string = SYSTEM_WIDE_NAMESPACE
  ): ParityRunDbRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM parity_runs
         WHERE metric = ? AND namespace = ?
         ORDER BY run_date DESC LIMIT 1`
      )
      .get(metric, namespace) as ParityRunDbRow | undefined;
    return row ?? null;
  }

  /** Current streak length for a (metric, namespace) — 0 if no rows. */
  getStreak(metric: string, namespace: string = SYSTEM_WIDE_NAMESPACE): number {
    return this.getLatestRun(metric, namespace)?.streak_len ?? 0;
  }

  /**
   * Machine-readable cutover-gate report (R5). Readiness per metric = system-wide
   * (`'*'`) streak ≥ `streakDays`; overall ready = all metrics ready. Consumed by
   * Sub H (#1670) / Sub I (#1671) before any read-path switch.
   */
  getCutoverGateReport(
    metrics: readonly string[],
    streakDays: number
  ): CutoverGateReport {
    const perMetric: CutoverGateReport["perMetric"] = {};
    let overallReady = true;
    for (const metric of metrics) {
      const latest = this.getLatestRun(metric, SYSTEM_WIDE_NAMESPACE);
      const streakLen = latest?.streak_len ?? 0;
      const status = (latest?.status as ParityRunStatus) ?? "red";
      const ready = streakLen >= streakDays;
      perMetric[metric] = { streakLen, status, ready };
      if (!ready) overallReady = false;
    }
    return { perMetric, overallReady, streakDays };
  }

  /**
   * Most recent `run_date` whose status was a PASS for `(metric, namespace)`,
   * or null when no pass has ever been recorded.
   *
   * Semantics (issue #2188): `status != 'red'` is the store's own pass
   * predicate (see {@link isPass}) — `within-bias` counts as a pass. So a
   * consumer's `lastGreen` field reads "last non-red", NOT "last exact-green".
   */
  getLastGreenDate(
    metric: string,
    namespace: string = SYSTEM_WIDE_NAMESPACE
  ): string | null {
    const row = this.db
      .prepare(
        `SELECT run_date FROM parity_runs
         WHERE metric = ? AND namespace = ? AND status != 'red'
         ORDER BY run_date DESC LIMIT 1`
      )
      .get(metric, namespace) as { run_date: string } | undefined;
    return row?.run_date ?? null;
  }

  /**
   * D1 sliding-window "structurally stuck" check (issue #2188 V1): over the
   * most recent `minDays` system-wide run-dates, is every gated metric's
   * MAX(streak_len) zero on EVERY one of them? (Also catches a regression to
   * all-red after a prior success — no soak-start marker exists or is needed.)
   *
   * Window semantics: run-consecutive, NOT calendar-consecutive — the query
   * takes the most recent N run-dates PRESENT, so a scheduler outage flanked
   * by red runs still reads "stuck" (acceptable, arguably desirable — do not
   * later "fix" this as a bug).
   *
   * The `metrics` param is deliberately bound into the WHERE clause: today
   * only PARITY_METRICS write `'*'` rows, but an unfiltered MAX(streak_len)
   * would silently poison the window if the gated set ever changes.
   */
  getStuckAtZeroWindow(
    metrics: readonly string[],
    minDays: number
  ): { stuck: boolean; runDatesChecked: number } {
    if (metrics.length === 0 || minDays <= 0) {
      return { stuck: false, runDatesChecked: 0 };
    }
    const placeholders = metrics.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT run_date, MAX(streak_len) AS max_streak
         FROM parity_runs
         WHERE namespace = ? AND metric IN (${placeholders})
         GROUP BY run_date
         ORDER BY run_date DESC
         LIMIT ?`
      )
      .all(SYSTEM_WIDE_NAMESPACE, ...metrics, minDays) as Array<{
      run_date: string;
      max_streak: number;
    }>;
    const stuck = rows.length >= minDays && rows.every(r => r.max_streak === 0);
    return { stuck, runDatesChecked: rows.length };
  }

  /**
   * Per-metric soak health + overall gate readiness (issue #2188 R5). Reuses
   * the {@link getCutoverGateReport} readiness predicate per metric
   * (`streak >= streakDays`), so `ready` here always agrees with
   * `getCutoverGateReport(...).overallReady` (R6).
   */
  getSoakHealth(
    metrics: readonly string[],
    streakDays: number
  ): SoakHealthReport {
    const perMetric: SoakHealthReport["perMetric"] = {};
    let ready = true;
    let maxDaysToGate = 0;
    for (const metric of metrics) {
      const latest = this.getLatestRun(metric, SYSTEM_WIDE_NAMESPACE);
      const streakLen = latest?.streak_len ?? 0;
      const status = (latest?.status as ParityRunStatus) ?? "red";
      const metricReady = streakLen >= streakDays;
      const daysToGate = Math.max(0, streakDays - streakLen);
      perMetric[metric] = {
        streakLen,
        status,
        ready: metricReady,
        lastGreen: this.getLastGreenDate(metric) ?? "never",
        daysToGate,
      };
      if (!metricReady) ready = false;
      if (daysToGate > maxDaysToGate) maxDaysToGate = daysToGate;
    }
    return { perMetric, ready, streakDays, daysToGate: maxDaysToGate };
  }
}
