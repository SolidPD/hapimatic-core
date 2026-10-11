// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shadow-mode parity harness core (issue #1669, epic #1662, Sub G).
 *
 * Orchestrates ONE nightly parity run: derive new-pipeline time (Task 1) + token
 * (Task 2) deltas, classify each bucket against asymmetric bias-aware thresholds
 * (Task 3), roll up to a per-metric verdict + streak, persist to `parity_runs`
 * (Task 5), and surface failures as exactly ONE error-log summary per run (Task 6).
 *
 * R7 — SHADOW MODE: this module is read-only w.r.t. legacy state. The ONLY writes
 * are the caller-provided `parityRuns` record and the single error summary. It
 * never mutates `timelog_entries`, the flush path, or A's views. The artifact
 * file write lives in the entrypoint (`server/scripts/parity-harness-run.ts`), not
 * here, so the core stays pure + unit-testable.
 *
 * Determinism: `nowMs` is injected (no `Date.now()` in the core), so tests are
 * reproducible and the module is safe to call from any scheduler.
 */

import type { Database } from "bun:sqlite";

import {
  ParityRunsStore,
  SYSTEM_WIDE_NAMESPACE,
  type ParityRunStatus,
} from "../store/parityRuns";
import {
  PARITY_METRICS,
  classifyDelta,
  worstStatus,
  type ParityMetric,
  type ParityStatus,
  type ParityThresholds,
} from "./parityThresholds";
import {
  bucketKey,
  deriveNewPipelineDailyTime,
  localDateForTimestamp,
  readLegacyDailyTime,
  resolveNamespaceTimezone,
} from "./timeParityDerivation";
import {
  TOKEN_CLASSES,
  computeDeltaPct,
  computeTokenParity,
  type TokenClass,
} from "./tokenParity";

export interface TimeParityBucket {
  namespace: string;
  localDate: string;
  newMs: number;
  legacyMs: number;
  deltaPct: number;
  status: ParityStatus;
}

export interface TokenParityBucket {
  namespace: string;
  tokenClass: TokenClass;
  dbValue: number;
  clientValue: number;
  deltaPct: number;
  status: ParityStatus;
}

export interface RedBucketDetail {
  metric: ParityMetric;
  namespace: string;
  /** localDate for time buckets; tokenClass label for token buckets. */
  key: string;
  deltaPct: number;
  offendingTurnIds: string[];
}

/**
 * A comparator-input wiring anomaly (issue #2188 V2/V3, D2 widened + A1 scoped):
 * the run's inputs are structurally broken (an extraction/wiring bug), not a
 * tolerance miss.
 *
 *   - `disjoint-namespaces` (either comparator): both sides carry data but
 *     their namespace sets do not intersect — the #2187 class (NULL-vs-real
 *     namespace keying) where every bucket one-sided-diffs against zero.
 *   - `uniformly-zero-input` (TOKEN comparator ONLY, ruling D-A/A1): one token
 *     side is uniformly zero while the other is non-zero — the live
 *     `extractUsageFromContent` nesting-path class where both sides share a
 *     namespace yet every client value is 0. NEVER applied to the time
 *     comparator: its sides are independent sources (`turns` = CLI-reported;
 *     `timelog_entries` = web-client timer), so a headless-only day
 *     legitimately zeroes the legacy side.
 */
export interface WiringAnomaly {
  comparator: "time" | "tokens";
  kind: "disjoint-namespaces" | "uniformly-zero-input";
  detail: string;
}

export interface ParityRunResult {
  runDate: string;
  nodeId: string;
  generatedAtMs: number;
  timeBuckets: TimeParityBucket[];
  tokenBuckets: TokenParityBucket[];
  /** System-wide worst status per gated metric. */
  metricStatuses: Record<ParityMetric, ParityStatus>;
  /** System-wide streak length per gated metric (after this run is recorded). */
  metricStreaks: Record<ParityMetric, number>;
  redBuckets: RedBucketDetail[];
  /** Comparator-input wiring anomalies detected this run (issue #2188 V3). */
  wiringAnomalies: WiringAnomaly[];
  overallStatus: ParityStatus;
  thresholds: ParityThresholds;
}

/** Minimal sink so the core depends on a method shape, not the ErrorLogger class. */
export interface ParityErrorSink {
  error(
    message: string,
    opts: { category: string; context: Record<string, unknown> }
  ): void;
}

export interface ParityHarnessDeps {
  db: Database;
  /** YYYY-MM-DD label for this run's `parity_runs` rows + artifact. */
  runDate: string;
  nodeId: string;
  thresholds: ParityThresholds;
  defaultTimezone: string;
  /** Injected wall-clock (no Date.now() in the core). */
  nowMs: number;
  /** Restrict to these namespaces (omitted → all present). */
  namespaces?: string[];
  /** Epoch-ms scope for turns/messages (omitted → all history). */
  startMs?: number;
  endMs?: number;
  /** YYYY-MM-DD scope for legacy `timelog_entries.date` (omitted → all). */
  startDate?: string;
  endDate?: string;
  /** Persist run-records + streaks when provided. */
  parityRuns?: ParityRunsStore;
  /** Surface a single red summary when provided. */
  errorSink?: ParityErrorSink;
  /** Max offending turn IDs to attach per red time bucket (default 20). */
  maxOffendersPerBucket?: number;
  /** Recorded into the system-wide `parity_runs` rows (the artifact location). */
  artifactPath?: string | null;
}

export const PARITY_ERROR_CATEGORY = "parity-harness";

/**
 * Distinct high-severity category for wiring anomalies (issue #2188 R4) —
 * separate from {@link PARITY_ERROR_CATEGORY} so the wiring signal gets its own
 * per-category rate-limit budget (#1141) and its own log signature.
 */
export const PARITY_WIRING_ERROR_CATEGORY = "parity-harness-wiring";

const TOKEN_CLASS_TO_METRIC: Record<TokenClass, ParityMetric> = {
  tokIn: "tokIn",
  tokOut: "tokOut",
  tokCacheRead: "tokCacheRead",
  tokCacheWrite: "tokCacheWrite",
};

interface TurnIdRow {
  id: string;
  started_at_ms: number;
}

/**
 * Collect up to `limit` finalized-turn IDs that fall in a red time bucket
 * `(namespace, localDate)`, for the error summary's turn references (R6). Bounded
 * + only called for red buckets, so the hot path stays lean. READ-ONLY.
 */
function collectOffendingTurnIds(
  db: Database,
  namespace: string,
  localDate: string,
  defaultTimezone: string,
  limit: number
): string[] {
  const tz = resolveNamespaceTimezone(db, namespace, defaultTimezone);
  const rows = db
    .prepare(
      `SELECT id, started_at_ms FROM turns
       WHERE status = 'completed' AND duration_ms IS NOT NULL
         AND COALESCE(namespace, '') = ?
       ORDER BY started_at_ms ASC`
    )
    .all(namespace) as TurnIdRow[];
  const ids: string[] = [];
  for (const row of rows) {
    if (localDateForTimestamp(row.started_at_ms, tz) === localDate) {
      ids.push(row.id);
      if (ids.length >= limit) break;
    }
  }
  return ids;
}

interface TimeBucketsResult {
  buckets: TimeParityBucket[];
  /** Namespaces with in-window NEW-side (turns) data — for V3 wiring detection. */
  newNamespaces: Set<string>;
  /** Namespaces with in-window LEGACY-side (timelog_entries) data. */
  legacyNamespaces: Set<string>;
}

function computeTimeBuckets(deps: ParityHarnessDeps): TimeBucketsResult {
  const newBuckets = deriveNewPipelineDailyTime(deps.db, {
    defaultTimezone: deps.defaultTimezone,
    namespaces: deps.namespaces,
    startMs: deps.startMs,
    endMs: deps.endMs,
  });
  const legacyBuckets = readLegacyDailyTime(deps.db, {
    namespaces: deps.namespaces,
    startDate: deps.startDate,
    endDate: deps.endDate,
  });

  // #2188: harvest per-side namespace sets from the bucket VALUES (bucket keys
  // are `namespace|localDate` composites) — zero re-query. Harvested INSIDE the
  // merge loop so the sets reflect the same localDate window the comparator
  // actually diffs (an off-window foreign-TZ bucket must not count as present).
  const newNamespaces = new Set<string>();
  const legacyNamespaces = new Set<string>();

  const keys = new Set<string>([...newBuckets.keys(), ...legacyBuckets.keys()]);
  const out: TimeParityBucket[] = [];
  for (const key of keys) {
    const nb = newBuckets.get(key);
    const lb = legacyBuckets.get(key);
    const namespace = nb?.namespace ?? lb?.namespace ?? "";
    const localDate = nb?.localDate ?? lb?.localDate ?? "";
    // Scope BOTH sides to the target local-date window when given. The new-side
    // epoch pre-filter is server-TZ-based, but bucket keys are per-namespace-TZ
    // correct — filtering on localDate here keeps a foreign-TZ namespace's
    // off-window bucket from diffing against an (absent) legacy counterpart.
    if (deps.startDate && localDate < deps.startDate) continue;
    if (deps.endDate && localDate > deps.endDate) continue;
    if (nb) newNamespaces.add(nb.namespace);
    if (lb) legacyNamespaces.add(lb.namespace);
    const newMs = nb?.durationMs ?? 0;
    const legacyMs = lb?.durationMs ?? 0;
    const deltaPct = computeDeltaPct(newMs, legacyMs);
    out.push({
      namespace,
      localDate,
      newMs,
      legacyMs,
      deltaPct,
      status: classifyDelta("time", deltaPct, deps.thresholds),
    });
  }
  // Stable order: namespace, then date.
  out.sort((a, b) =>
    a.namespace === b.namespace
      ? a.localDate.localeCompare(b.localDate)
      : a.namespace.localeCompare(b.namespace)
  );
  return { buckets: out, newNamespaces, legacyNamespaces };
}

interface TokenBucketsResult {
  buckets: TokenParityBucket[];
  /** Namespaces with ≥1 non-zero DB-side (turns.tok_*) class total. */
  dbValueNamespaces: Set<string>;
  /** Namespaces with ≥1 non-zero client-equivalent (messages.usage) total. */
  clientValueNamespaces: Set<string>;
}

function computeTokenBuckets(deps: ParityHarnessDeps): TokenBucketsResult {
  const results = computeTokenParity(deps.db, {
    namespaces: deps.namespaces,
    startMs: deps.startMs,
    endMs: deps.endMs,
  });
  // #2188: per-side "value-bearing" namespace sets, derived from the results
  // already in hand (zero re-query) — computeTokenParity zero-fills a missing
  // side, so side presence is judged by non-zero totals, which is exactly the
  // signal the V3 wiring checks need.
  const dbValueNamespaces = new Set<string>();
  const clientValueNamespaces = new Set<string>();
  const out: TokenParityBucket[] = [];
  for (const r of results) {
    for (const cls of TOKEN_CLASSES) {
      if (r.dbTotals[cls] > 0) dbValueNamespaces.add(r.namespace);
      if (r.clientTotals[cls] > 0) clientValueNamespaces.add(r.namespace);
      const deltaPct = r.deltas[cls];
      out.push({
        namespace: r.namespace,
        tokenClass: cls,
        dbValue: r.dbTotals[cls],
        clientValue: r.clientTotals[cls],
        deltaPct,
        status: classifyDelta(
          TOKEN_CLASS_TO_METRIC[cls],
          deltaPct,
          deps.thresholds
        ),
      });
    }
  }
  out.sort((a, b) =>
    a.namespace === b.namespace
      ? a.tokenClass.localeCompare(b.tokenClass)
      : a.namespace.localeCompare(b.namespace)
  );
  return { buckets: out, dbValueNamespaces, clientValueNamespaces };
}

function fmtNamespaces(set: Set<string>, cap = 10): string {
  const names = [...set].map(ns => (ns === "" ? '""' : ns));
  const shown = names.slice(0, cap).join(", ");
  return names.length > cap
    ? `[${shown}, … +${names.length - cap} more]`
    : `[${shown}]`;
}

/**
 * V2/V3 wiring-anomaly detection (issue #2188, D2 widened + ruling D-A/A1):
 *
 *   - `disjoint-namespaces` — both sides of a comparator carry data but their
 *     namespace sets do not intersect (both comparators).
 *   - `uniformly-zero-input` — TOKEN comparator ONLY: exactly one side has zero
 *     value-bearing namespaces while the other has ≥1. Never applied to the
 *     time comparator (headless-only days legitimately zero the legacy side —
 *     see {@link WiringAnomaly}). A fully-idle window (both sides empty) is a
 *     clean no-data day, NOT an anomaly (OR-3).
 */
function detectWiringAnomalies(
  time: TimeBucketsResult,
  tokens: TokenBucketsResult
): WiringAnomaly[] {
  const anomalies: WiringAnomaly[] = [];

  const timeIntersects = [...time.newNamespaces].some(ns =>
    time.legacyNamespaces.has(ns)
  );
  if (
    time.newNamespaces.size > 0 &&
    time.legacyNamespaces.size > 0 &&
    !timeIntersects
  ) {
    anomalies.push({
      comparator: "time",
      kind: "disjoint-namespaces",
      detail:
        `new-side (turns) namespaces ${fmtNamespaces(time.newNamespaces)} vs ` +
        `legacy-side (timelog_entries) ${fmtNamespaces(time.legacyNamespaces)} — ` +
        `no overlap; every bucket one-sided-diffs against zero (the #2187 class)`,
    });
  }

  const tokenIntersects = [...tokens.dbValueNamespaces].some(ns =>
    tokens.clientValueNamespaces.has(ns)
  );
  if (
    tokens.dbValueNamespaces.size > 0 &&
    tokens.clientValueNamespaces.size > 0 &&
    !tokenIntersects
  ) {
    anomalies.push({
      comparator: "tokens",
      kind: "disjoint-namespaces",
      detail:
        `db-side (turns.tok_*) namespaces ${fmtNamespaces(tokens.dbValueNamespaces)} vs ` +
        `client-side (messages.usage) ${fmtNamespaces(tokens.clientValueNamespaces)} — no overlap`,
    });
  } else if (
    tokens.clientValueNamespaces.size === 0 &&
    tokens.dbValueNamespaces.size > 0
  ) {
    anomalies.push({
      comparator: "tokens",
      kind: "uniformly-zero-input",
      detail:
        `client side (messages.usage recompute) is uniformly zero while the db side ` +
        `(turns.tok_*) is non-zero across ${fmtNamespaces(tokens.dbValueNamespaces)} — ` +
        `extraction/wiring bug (the tokenParity nesting-path class), not a tolerance miss`,
    });
  } else if (
    tokens.dbValueNamespaces.size === 0 &&
    tokens.clientValueNamespaces.size > 0
  ) {
    anomalies.push({
      comparator: "tokens",
      kind: "uniformly-zero-input",
      detail:
        `db side (turns.tok_*) is uniformly zero while the client side ` +
        `(messages.usage recompute) is non-zero across ${fmtNamespaces(tokens.clientValueNamespaces)} — ` +
        `extraction/wiring bug, not a tolerance miss`,
    });
  }

  return anomalies;
}

/**
 * Run one parity pass. Pure compute + (optional) persistence + (optional) one
 * error summary. Returns the structured result the entrypoint serializes to the
 * artifact.
 */
export function runParityHarness(deps: ParityHarnessDeps): ParityRunResult {
  const limit = deps.maxOffendersPerBucket ?? 20;
  const timeResult = computeTimeBuckets(deps);
  const tokenResult = computeTokenBuckets(deps);
  const timeBuckets = timeResult.buckets;
  const tokenBuckets = tokenResult.buckets;
  const wiringAnomalies = detectWiringAnomalies(timeResult, tokenResult);

  // Per-metric system-wide worst status + a representative delta value.
  // #2229 in-path fix: the representative is chosen from the WORST-status
  // buckets first (red > within-bias > green), then largest |delta| within
  // that status. Under asymmetric tolerances a within-bias bucket can carry a
  // larger |delta| than the red bucket that actually tripped the metric —
  // picking by raw magnitude alone persisted a misleading delta to
  // `parity_runs`, corrupting exactly the diagnostic the post-#2229 threshold
  // recalibration reads.
  const metricStatuses = {} as Record<ParityMetric, ParityStatus>;
  const metricRepresentativeDelta = {} as Record<ParityMetric, number>;
  for (const metric of PARITY_METRICS) {
    const buckets =
      metric === "time"
        ? timeBuckets
        : tokenBuckets.filter(
            b => TOKEN_CLASS_TO_METRIC[b.tokenClass] === metric
          );
    const statuses = buckets.map(b => b.status);
    const worst = worstStatus(statuses);
    metricStatuses[metric] = worst;
    let rep = 0;
    for (const b of buckets) {
      if (b.status !== worst) continue;
      if (Math.abs(b.deltaPct) > Math.abs(rep)) rep = b.deltaPct;
    }
    metricRepresentativeDelta[metric] = rep;
  }

  // Red bucket details (with offending turn IDs for time buckets).
  const redBuckets: RedBucketDetail[] = [];
  for (const b of timeBuckets) {
    if (b.status !== "red") continue;
    redBuckets.push({
      metric: "time",
      namespace: b.namespace,
      key: b.localDate,
      deltaPct: b.deltaPct,
      offendingTurnIds: collectOffendingTurnIds(
        deps.db,
        b.namespace,
        b.localDate,
        deps.defaultTimezone,
        limit
      ),
    });
  }
  for (const b of tokenBuckets) {
    if (b.status !== "red") continue;
    redBuckets.push({
      metric: TOKEN_CLASS_TO_METRIC[b.tokenClass],
      namespace: b.namespace,
      key: b.tokenClass,
      deltaPct: b.deltaPct,
      offendingTurnIds: [],
    });
  }

  const overallStatus = worstStatus(PARITY_METRICS.map(m => metricStatuses[m]));

  // Persist per-metric system-wide rows (drive the gate) + per-namespace rows
  // (diagnostics). Streaks are computed inside the store.
  const metricStreaks = {} as Record<ParityMetric, number>;
  for (const metric of PARITY_METRICS) {
    metricStreaks[metric] = 0;
  }
  if (deps.parityRuns) {
    recordRunRecords(deps, {
      timeBuckets,
      tokenBuckets,
      metricStatuses,
      metricRepresentativeDelta,
      metricStreaks,
    });
  }

  // #2188 R4: the distinct wiring signal — emitted IN ADDITION TO the generic
  // red summary below, under its OWN guard (the summary's guard also requires
  // redBuckets; a wiring anomaly must still log even with zero red buckets).
  if (deps.errorSink && wiringAnomalies.length > 0) {
    deps.errorSink.error(
      `Parity harness ${deps.runDate}: comparator inputs are disjoint/zero; ` +
        `wiring bug, not a tolerance miss (${wiringAnomalies.length} anomaly/ies, ` +
        `node ${deps.nodeId}).`,
      {
        category: PARITY_WIRING_ERROR_CATEGORY,
        context: {
          runDate: deps.runDate,
          nodeId: deps.nodeId,
          wiringAnomalies,
        },
      }
    );
  }

  // R6: ONE summary entry per run, never per-row (the #1141 10/category limit
  // would swallow per-row entries).
  if (deps.errorSink && redBuckets.length > 0) {
    deps.errorSink.error(
      `Parity harness ${deps.runDate}: ${redBuckets.length} red bucket(s) across ` +
        `${new Set(redBuckets.map(r => r.metric)).size} metric(s) on node ${deps.nodeId}.`,
      {
        category: PARITY_ERROR_CATEGORY,
        context: {
          runDate: deps.runDate,
          nodeId: deps.nodeId,
          redBucketCount: redBuckets.length,
          redBuckets: redBuckets.map(r => ({
            metric: r.metric,
            namespace: r.namespace,
            key: r.key,
            deltaPct: r.deltaPct,
            offendingTurnIds: r.offendingTurnIds,
          })),
        },
      }
    );
  }

  return {
    runDate: deps.runDate,
    nodeId: deps.nodeId,
    generatedAtMs: deps.nowMs,
    timeBuckets,
    tokenBuckets,
    metricStatuses,
    metricStreaks,
    redBuckets,
    wiringAnomalies,
    overallStatus,
    thresholds: deps.thresholds,
  };
}

interface RecordContext {
  timeBuckets: TimeParityBucket[];
  tokenBuckets: TokenParityBucket[];
  metricStatuses: Record<ParityMetric, ParityStatus>;
  metricRepresentativeDelta: Record<ParityMetric, number>;
  metricStreaks: Record<ParityMetric, number>;
}

function recordRunRecords(deps: ParityHarnessDeps, ctx: RecordContext): void {
  const store = deps.parityRuns;
  if (!store) return;

  // System-wide ('*') rows — these drive getCutoverGateReport().
  for (const metric of PARITY_METRICS) {
    const tol = deps.thresholds.tolerances[metric];
    const { streakLen } = store.recordRun(
      {
        runDate: deps.runDate,
        namespace: SYSTEM_WIDE_NAMESPACE,
        metric,
        status: ctx.metricStatuses[metric] as ParityRunStatus,
        deltaPct: ctx.metricRepresentativeDelta[metric],
        thresholdOverPct: tol.overPct,
        thresholdUnderPct: tol.underPct,
        artifactPath: deps.artifactPath ?? null,
        nodeId: deps.nodeId,
      },
      deps.nowMs
    );
    ctx.metricStreaks[metric] = streakLen;
  }

  // Per-namespace diagnostic rows (worst status per namespace+metric).
  const perNs = new Map<string, Map<ParityMetric, ParityStatus[]>>();
  const pushNs = (ns: string, metric: ParityMetric, status: ParityStatus) => {
    let m = perNs.get(ns);
    if (!m) {
      m = new Map<ParityMetric, ParityStatus[]>();
      perNs.set(ns, m);
    }
    const arr = m.get(metric) ?? [];
    arr.push(status);
    m.set(metric, arr);
  };
  for (const b of ctx.timeBuckets) pushNs(b.namespace, "time", b.status);
  for (const b of ctx.tokenBuckets) {
    pushNs(b.namespace, TOKEN_CLASS_TO_METRIC[b.tokenClass], b.status);
  }
  for (const [ns, metricMap] of perNs) {
    if (ns === SYSTEM_WIDE_NAMESPACE) continue; // never collide with the aggregate
    for (const [metric, statuses] of metricMap) {
      const tol = deps.thresholds.tolerances[metric];
      store.recordRun(
        {
          runDate: deps.runDate,
          namespace: ns,
          metric,
          status: worstStatus(statuses) as ParityRunStatus,
          deltaPct: null,
          thresholdOverPct: tol.overPct,
          thresholdUnderPct: tol.underPct,
          artifactPath: null,
          nodeId: deps.nodeId,
        },
        deps.nowMs
      );
    }
  }
}
