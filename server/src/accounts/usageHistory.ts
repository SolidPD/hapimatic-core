// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AccountUsage,
  AccountUsageHistory,
  UsageHistoryPoint,
  UsageLimitKey,
  UsageProjection,
  UsageWindowHistory,
  Utilization,
} from "@hapi/protocol";
import type { UsageHistoryStore } from "../store/usageHistoryStore";
import type { ErrorLogger } from "../logging/errorLogger";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";

/**
 * Usage history sampler + projection (epic #1855, Sub-Issue I / #1864).
 *
 * Two concerns live here, beside the sibling `usageService.ts`:
 *  - `UsageSampler` — a drift-free setTimeout loop that periodically samples
 *    `UsageService.listUsage()` and persists ok-account snapshots via the
 *    `UsageHistoryStore`, then prunes to a bounded retention horizon. Modeled on
 *    `extensions/watchdog/stallWatchdogService.ts` (start / stop / scheduleNext / runSample).
 *  - `computeProjection` / `buildHistoryResponse` — pure, clock-injectable
 *    functions that shape the history endpoint's per-window series + a
 *    projected-exhaustion estimate from the recent slope. The card only formats
 *    the result (keeping it pure-presentational).
 */

/** The canonical `oauth/usage` window keys persisted per snapshot. */
export const USAGE_LIMIT_KEYS: readonly UsageLimitKey[] = [
  "five_hour",
  "seven_day",
  "seven_day_sonnet",
  "seven_day_opus",
  "seven_day_oauth_apps",
];

/** Default sampler interval (2 min) — refresh + alert cadence (#1909). */
export const DEFAULT_SAMPLER_INTERVAL_MS = 2 * 60 * 1000;
/**
 * Default history-row persistence cadence (10 min) — decoupled from the
 * (faster) refresh interval so the 14-day history table stays bounded (#1909).
 */
export const DEFAULT_HISTORY_PERSIST_MS = 10 * 60 * 1000;
/** Default bounded retention (14 days) — exceeds the weekly window horizon. */
export const DEFAULT_RETENTION_DAYS = 14;
/** History lookback for the endpoint series (7 days — enough for the weekly sparkline). */
export const DEFAULT_HISTORY_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Slope is computed over the most recent points within this window. */
export const PROJECTION_LOOKBACK_MS = 2 * 60 * 60 * 1000;

/** Minimal `UsageService` surface the sampler needs (test seam). */
export interface UsageLister {
  refresh(): Promise<AccountUsage[]>;
}

/**
 * Compute a projected-exhaustion estimate for one window from its recent slope.
 * Returns null when there is nothing to project from (< 2 points). When the
 * slope is non-positive, `exhaustionAt` is null (never a fabricated time).
 */
export function computeProjection(
  points: UsageHistoryPoint[],
  resetsAt: string | null,
  now: number
): UsageProjection | null {
  if (points.length < 2) return null;

  // Recent window for the slope (fall back to the last two points).
  let recent = points.filter(p => p.sampledAt >= now - PROJECTION_LOOKBACK_MS);
  if (recent.length < 2) recent = points.slice(-2);

  const n = recent.length;
  const meanX = recent.reduce((s, p) => s + p.sampledAt, 0) / n;
  const meanY = recent.reduce((s, p) => s + p.utilization, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of recent) {
    const dx = p.sampledAt - meanX;
    num += dx * (p.utilization - meanY);
    den += dx * dx;
  }

  const latestUtil = recent[recent.length - 1].utilization;
  const slopePerMs = den === 0 ? 0 : num / den;
  const slopePerHour = slopePerMs * 3_600_000;

  // Non-positive (or undefined) slope → not trending toward the limit.
  if (slopePerMs <= 0) {
    return {
      exhaustionAt: null,
      slopePerHour,
      reachesLimitBeforeReset: false,
      pointCount: n,
    };
  }

  const remaining = Math.max(0, 100 - latestUtil);
  const exhaustionAt = now + remaining / slopePerMs;

  const resetTime = resetsAt ? Date.parse(resetsAt) : NaN;
  const reachesLimitBeforeReset = Number.isFinite(resetTime)
    ? exhaustionAt <= resetTime
    : true;

  return {
    exhaustionAt,
    slopePerHour,
    reachesLimitBeforeReset,
    pointCount: n,
  };
}

/**
 * Read the recent snapshot series for an account and build the per-window
 * history + projection envelope returned by the history endpoint.
 */
export function buildHistoryResponse(
  store: UsageHistoryStore,
  accountUuid: string,
  currentUtilization: Utilization | null,
  now: number,
  lookbackMs: number = DEFAULT_HISTORY_LOOKBACK_MS
): AccountUsageHistory {
  const rows = store.getSeries(accountUuid, now - lookbackMs);

  // Group ascending-by-time points per limit key.
  const byKey = new Map<UsageLimitKey, UsageHistoryPoint[]>();
  for (const row of rows) {
    const key = row.limitKey as UsageLimitKey;
    if (!USAGE_LIMIT_KEYS.includes(key)) continue;
    const list = byKey.get(key) ?? [];
    list.push({ sampledAt: row.sampledAt, utilization: row.utilization });
    byKey.set(key, list);
  }

  const windows: UsageWindowHistory[] = [];
  for (const limitKey of USAGE_LIMIT_KEYS) {
    const points = byKey.get(limitKey) ?? [];
    if (points.length === 0) continue;
    const resetsAt = currentUtilization?.[limitKey]?.resets_at ?? null;
    windows.push({
      limitKey,
      points,
      projection: computeProjection(points, resetsAt, now),
    });
  }

  return { accountUuid, windows, generatedAt: now };
}

/**
 * Minimal usage-alert surface the sampler invokes after each sample (epic #1855,
 * Sub H / #1863). Structural type — keeps the sampler decoupled from the concrete
 * `UsageAlertService` and test-isolated. Optional: when absent, the sampler only
 * persists snapshots (unchanged pre-#1863 behavior).
 */
export interface UsageAlerter {
  checkAndNotify(usages: AccountUsage[]): Promise<number>;
}

export interface UsageSamplerOptions {
  usageService: UsageLister;
  store: UsageHistoryStore;
  intervalMs?: number;
  /**
   * History-row persistence cadence in ms (#1909). Defaults to 10 min — gated
   * independently of the (faster) refresh interval.
   */
  historyPersistMs?: number;
  retentionDays?: number;
  enabled?: boolean;
  now?: () => number;
  errorLogger?: ErrorLogger | null;
  /** Optional usage-threshold alerter (#1863); when set, runs after each sample. */
  alertService?: UsageAlerter;
  /** Federation nodeId this sampler runs on (#1963 job registry). Default "standalone". */
  node?: string;
  /** Runtime job registry to register the supervised loop into (#1963). */
  jobRegistry?: JobRegistry;
}

export class UsageSampler {
  private readonly usageService: UsageLister;
  private readonly store: UsageHistoryStore;
  private readonly intervalMs: number;
  private readonly historyPersistMs: number;
  private readonly retentionDays: number;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly errorLogger: ErrorLogger | null;
  private readonly alertService: UsageAlerter | null;
  private readonly node: string;
  private readonly jobRegistry: JobRegistry | null;
  /**
   * #1963: the supervised-loop wrapper that owns scheduling — it provides the
   * #1962 finally-guarded reschedule PLUS a stall watchdog, heartbeat, and
   * runtime-job-registry registration. `sampleNow()` remains the unit of work.
   */
  private readonly loop: SupervisedLoop;
  /**
   * Wall-clock ms of the last history-row persist; 0 so the first sample after
   * boot persists, then gated to `historyPersistMs` thereafter (#1909).
   */
  private lastPersistAt = 0;

  constructor(opts: UsageSamplerOptions) {
    this.usageService = opts.usageService;
    this.store = opts.store;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SAMPLER_INTERVAL_MS;
    this.historyPersistMs = opts.historyPersistMs ?? DEFAULT_HISTORY_PERSIST_MS;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.enabled = opts.enabled ?? true;
    this.now = opts.now ?? Date.now;
    this.errorLogger = opts.errorLogger ?? null;
    this.alertService = opts.alertService ?? null;
    this.node = opts.node ?? "standalone";
    this.jobRegistry = opts.jobRegistry ?? null;
    this.loop = new SupervisedLoop({
      name: "usage-sampler",
      node: this.node,
      intervalMs: this.intervalMs,
      enabled: this.enabled,
      immediate: true, // sample immediately on start — no cold-start gap (#1909)
      now: this.now,
      registry: this.jobRegistry ?? undefined,
      tick: () => this.runSampleTick(),
    });
  }

  /** Start the periodic sampling loop if enabled. */
  start(): void {
    if (!this.enabled) {
      console.log("[UsageSampler] Disabled in config, not starting");
      // Register the loop (as stopped) so a config-disabled sampler is still
      // visible in the job registry for Sub-Issue D (#1964).
      this.loop.start();
      return;
    }
    console.log(
      `[UsageSampler] Starting with ${this.intervalMs / 1000}s interval, ` +
        `${this.retentionDays}d retention`
    );
    // #1909: SupervisedLoop runs the first sample immediately (immediate:true).
    this.loop.start();
  }

  /** Stop the loop. Idempotent — a second stop() is a no-op. */
  stop(): void {
    this.loop.stop();
  }

  /**
   * One supervised tick: run a sample, surface any failure to the error-logger,
   * then rethrow so the SupervisedLoop records `lastError` and re-arms via its
   * `finally`. The #1962 self-heal guarantee now lives in the primitive: a
   * throwing logger here cannot strand the loop because the primitive's
   * try/finally is OUTSIDE this method.
   */
  private async runSampleTick(): Promise<void> {
    try {
      await this.sampleNow();
    } catch (error) {
      try {
        this.errorLogger?.warn("Usage sample failed", {
          category: "usage-sampler",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } catch {
        // Logging must never kill the loop (the primitive guards this too).
      }
      throw error;
    }
  }

  /**
   * Run a single sample: persist one snapshot row per (ok account, non-null
   * window), then prune. Exposed for tests / manual one-shot triggering.
   * Returns the number of rows written.
   */
  async sampleNow(): Promise<number> {
    const sampledAt = this.now();
    const usages = await this.usageService.refresh();
    const rows: {
      accountUuid: string;
      limitKey: string;
      utilization: number;
      sampledAt: number;
    }[] = [];

    for (const usage of usages) {
      if (usage.status !== "ok") continue;
      for (const key of USAGE_LIMIT_KEYS) {
        const util = usage.utilization?.[key]?.utilization;
        if (typeof util === "number" && Number.isFinite(util)) {
          rows.push({
            accountUuid: usage.accountUuid,
            limitKey: key,
            utilization: util,
            sampledAt,
          });
        }
      }
    }

    // History persistence is gated to its own (slower) cadence so the 14-day
    // table stays bounded even though refresh/alerts run every 2 min (#1909).
    // lastPersistAt starts at 0, so the first sample after boot persists.
    if (sampledAt - this.lastPersistAt >= this.historyPersistMs) {
      this.store.insertMany(rows);
      // Prune even when this sample wrote nothing (bounded growth invariant).
      this.store.pruneOlderThan(this.retentionDays);
      this.lastPersistAt = sampledAt;
    }

    // Epic #1855, Sub H (#1863): fire de-duped usage-threshold alerts off the
    // SAME fetched list (no extra upstream call). Failure-isolated — a push
    // error must NOT lose the snapshot rows persisted above, nor abort the loop.
    if (this.alertService) {
      try {
        await this.alertService.checkAndNotify(usages);
      } catch (error) {
        this.errorLogger?.warn("Usage alert check failed", {
          category: "usage-alert",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    return rows.length;
  }
}
