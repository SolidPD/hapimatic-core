// SPDX-License-Identifier: AGPL-3.0-only
import {
  QUOTA_ESTIMATE_LABEL,
  SupervisedLoop,
  utcDayOf,
  type AccountUsage,
  type JobFailureEvent,
  type JobRegistry,
  type QuotaAccount,
  type QuotaModel,
  type QuotaWeights,
} from "@hapi/protocol";
import type {
  QuotaDayRow,
  ThroughputRollupStore,
} from "../store/throughput/rollupStore";
import type {
  UsageHistoryStore,
  UsageSnapshotRow,
} from "../store/usageHistoryStore";
import { UNATTRIBUTED_ACCOUNT } from "./rollup";

/**
 * The weekly-quota model (issue #6164, A1 — R7). Fleet job, one node.
 *
 * Only the `seven_day` window is used (the 5-hour window is gone or
 * synthetic, `isSyntheticWindow`). Two parts:
 *
 *   - Runway, at read time: per account, the slope of `seven_day`
 *     utilization over the last 24 h of `usage_snapshots` (pp/hour, drops
 *     ignored), `runway = (100 − U) / slope` (null when the slope is not
 *     positive) and whether that comes before the reset; for the fleet,
 *     Σ(100 − U) over Σ slope. `computeProjection` is not reused: it fits 2 h
 *     and has no reset handling.
 *
 *   - Weights, from the daily upkeep: one `throughput_quota_daily` row per
 *     account per completed UTC day — the first and last `seven_day` sample,
 *     whether a reset fell inside the day (a drop of more than 5 pp), that
 *     account's tokens by category from the cost rollups (every origin) and
 *     the day's unattributed tokens. The rows outlive the 14-day snapshot
 *     retention. A non-negative least-squares fit (in-house Lawson-Hanson; no
 *     new dependency) of each day's utilization change on its tokens, in
 *     millions, by category gives percentage points per million tokens, with
 *     R² and n; under 10 usable account-days (one row per account and day)
 *     it reports `insufficient`. Every surface
 *     says "estimated (Tier 3)".
 */

export const QUOTA_LOOP_NAME = "throughput-quota";
export const QUOTA_WINDOW = "seven_day";
/** A drop of more than this many points between samples is a weekly reset. */
export const RESET_DROP_PP = 5;
/**
 * Fewer usable account-days (rows of one account and day) than this report
 * `insufficient`.
 */
export const MIN_FIT_DAYS = 10;
/** A day counts only when its samples span at least this long. */
export const MIN_DAY_SPAN_MS = 20 * 3_600_000;
const SLOPE_WINDOW_MS = 24 * 3_600_000;
const MIN_SLOPE_SPAN_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Days re-derived on every upkeep (late mirror rows change their tokens). */
const REFRESH_DAYS = 3;
/** How far back the upkeep can derive days (the snapshot retention). */
const SNAPSHOT_RETENTION_DAYS = 14;
const FIT_WINDOW_DAYS = 60;
const QUOTA_RETENTION_DAYS = 400;
const INTERVAL_MS = 60 * 60_000;

export const WEIGHT_CATEGORIES = ["in", "out", "cr", "w1", "w5", "wu"] as const;
type Category = (typeof WEIGHT_CATEGORIES)[number];

function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

// ─────────────────────────── runway ───────────────────────────

/**
 * Utilization slope in pp/hour over samples (oldest first): the sum of the
 * rises over the time they cover. Drops (a reset, or a downward correction)
 * add nothing. Null with fewer than two samples or under an hour of span.
 */
export function slopePpPerHour(
  samples: ReadonlyArray<Pick<UsageSnapshotRow, "utilization" | "sampledAt">>
): number | null {
  if (samples.length < 2) return null;
  const span = samples[samples.length - 1]!.sampledAt - samples[0]!.sampledAt;
  if (span < MIN_SLOPE_SPAN_MS) return null;
  let rise = 0;
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]!.utilization - samples[i - 1]!.utilization;
    if (d > 0) rise += d;
  }
  return rise / (span / 3_600_000);
}

/** One account's runway: null when the slope is unknown or not positive. */
export function accountRunway(
  utilization: number | null,
  resetsAtMs: number | null,
  slope: number | null,
  nowMs: number
): { runwayHours: number | null; exhaustsBeforeReset: boolean | null } {
  if (utilization === null || slope === null || slope <= 0) {
    return { runwayHours: null, exhaustsBeforeReset: null };
  }
  const runwayHours = Math.max(0, 100 - utilization) / slope;
  return {
    runwayHours,
    exhaustsBeforeReset:
      resetsAtMs === null ? null : nowMs + runwayHours * 3_600_000 < resetsAtMs,
  };
}

/** Per-account runway rows from the latest usage and each account's last 24 h. */
export function quotaAccounts(
  latest: readonly AccountUsage[],
  seriesFor: (accountUuid: string, sinceMs: number) => UsageSnapshotRow[],
  nowMs: number
): QuotaAccount[] {
  const out: QuotaAccount[] = [];
  for (const a of latest) {
    const week = a.utilization?.seven_day;
    const utilization =
      typeof week?.utilization === "number" ? week.utilization : null;
    const resets = week?.resets_at ? Date.parse(week.resets_at) : NaN;
    const resetsAtMs = Number.isNaN(resets) ? null : resets;
    const samples = seriesFor(a.accountUuid, nowMs - SLOPE_WINDOW_MS).filter(
      s => s.limitKey === QUOTA_WINDOW
    );
    const slope = slopePpPerHour(samples);
    out.push({
      accountId: a.accountUuid,
      label: a.nickname ?? a.displayLabel ?? null,
      utilization,
      resetsAtMs,
      slopePpPerHour: slope,
      ...accountRunway(utilization, resetsAtMs, slope, nowMs),
    });
  }
  return out;
}

/** The fleet: Σ headroom, Σ slope, and the runway of the two. */
export function fleetRunway(accounts: readonly QuotaAccount[]): {
  accounts: number;
  accountsWithHeadroom: number;
  headroomPp: number;
  slopePpPerHour: number | null;
  runwayHours: number | null;
} {
  const known = accounts.filter(a => a.utilization !== null);
  const headroomPp = known.reduce(
    (s, a) => s + Math.max(0, 100 - a.utilization!),
    0
  );
  const slopes = known
    .map(a => a.slopePpPerHour)
    .filter((s): s is number => s !== null);
  const slope = slopes.length ? slopes.reduce((s, x) => s + x, 0) : null;
  return {
    accounts: known.length,
    accountsWithHeadroom: known.filter(a => a.utilization! < 100).length,
    headroomPp,
    slopePpPerHour: slope,
    runwayHours: slope !== null && slope > 0 ? headroomPp / slope : null,
  };
}

// ─────────────────────────── daily rows ───────────────────────────

/** True when consecutive samples (oldest first) drop by more than 5 pp. */
export function resetCrossed(
  samples: ReadonlyArray<Pick<UsageSnapshotRow, "utilization">>
): boolean {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1]!.utilization - samples[i]!.utilization > RESET_DROP_PP) {
      return true;
    }
  }
  return false;
}

/** One account-day row from that day's `seven_day` samples and tokens. */
export function quotaDayRow(input: {
  accountId: string;
  day: string;
  samples: ReadonlyArray<Pick<UsageSnapshotRow, "utilization" | "sampledAt">>;
  tokens: {
    tokIn: number;
    tokOut: number;
    tokCr: number;
    tokW1: number;
    tokW5: number;
    tokWu: number;
  } | null;
  unattributedTok: number;
}): QuotaDayRow {
  const s = [...input.samples].sort((a, b) => a.sampledAt - b.sampledAt);
  const first = s[0];
  const last = s[s.length - 1];
  const t = input.tokens;
  return {
    accountId: input.accountId,
    day: input.day,
    firstUtil: first?.utilization ?? null,
    lastUtil: last?.utilization ?? null,
    firstMs: first?.sampledAt ?? null,
    lastMs: last?.sampledAt ?? null,
    samples: s.length,
    resetCrossed: resetCrossed(s),
    tokIn: t?.tokIn ?? 0,
    tokOut: t?.tokOut ?? 0,
    tokCr: t?.tokCr ?? 0,
    tokW1: t?.tokW1 ?? 0,
    tokW5: t?.tokW5 ?? 0,
    tokWu: t?.tokWu ?? 0,
    unattributedTok: input.unattributedTok,
  };
}

// ─────────────────────────── the fit ───────────────────────────

/** Solve the small dense system `M x = v` (Gaussian elimination, partial pivoting). */
function solve(M: number[][], v: number[]): number[] | null {
  const n = v.length;
  const a = M.map((row, i) => [...row, v[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(a[pivot]![col]!) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / a[col]![col]!;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[n]! / row[i]!);
}

/**
 * Non-negative least squares, `min ‖A x − b‖` with `x ≥ 0` — the
 * Lawson-Hanson active-set method. Columns are scaled to unit norm first (the
 * categories differ by orders of magnitude); an all-zero column gets weight 0.
 */
export function nnls(A: readonly number[][], b: readonly number[]): number[] {
  const n = A[0]?.length ?? 0;
  const norms = Array.from({ length: n }, (_, j) =>
    Math.sqrt(A.reduce((s, row) => s + row[j]! * row[j]!, 0))
  );
  const usable = norms.map(x => x > 0);
  const S = A.map(row => row.map((v, j) => (usable[j] ? v / norms[j]! : 0)));
  const ata = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      S.reduce((s, row) => s + row[i]! * row[j]!, 0)
    )
  );
  const atb = Array.from({ length: n }, (_, j) =>
    S.reduce((s, row, k) => s + row[j]! * b[k]!, 0)
  );
  const gradient = (x: number[]) =>
    atb.map((g, i) => g - ata[i]!.reduce((s, v, j) => s + v * x[j]!, 0));
  const tol = 1e-10 * Math.max(1, Math.sqrt(b.reduce((s, v) => s + v * v, 0)));

  const x = new Array<number>(n).fill(0);
  const passive = new Set<number>();
  // Columns whose subproblem was singular (collinear with the passive set).
  const blocked = new Set<number>();
  const subsetSolve = (): number[] | null => {
    const idx = [...passive].sort((p, q) => p - q);
    const z = solve(
      idx.map(i => idx.map(j => ata[i]![j]!)),
      idx.map(i => atb[i]!)
    );
    if (!z) return null;
    const full = new Array<number>(n).fill(0);
    idx.forEach((i, k) => (full[i] = z[k]!));
    return full;
  };

  for (let outer = 0; outer < 3 * n + 3; outer++) {
    const w = gradient(x);
    let best = -1;
    for (let j = 0; j < n; j++) {
      if (!usable[j] || passive.has(j) || blocked.has(j)) continue;
      if (w[j]! > tol && (best < 0 || w[j]! > w[best]!)) best = j;
    }
    if (best < 0) break;
    passive.add(best);
    for (let inner = 0; inner < 3 * n + 3; inner++) {
      const z = subsetSolve();
      if (!z) {
        passive.delete(best);
        blocked.add(best);
        break;
      }
      const negative = [...passive].filter(i => z[i]! <= 0);
      if (negative.length === 0) {
        for (let i = 0; i < n; i++) x[i] = z[i]!;
        break;
      }
      let alpha = 1;
      for (const i of negative) {
        const denom = x[i]! - z[i]!;
        if (denom > 0) alpha = Math.min(alpha, x[i]! / denom);
      }
      for (let i = 0; i < n; i++) x[i] = x[i]! + alpha * (z[i]! - x[i]!);
      for (const i of [...passive]) {
        if (x[i]! <= tol) {
          x[i] = 0;
          passive.delete(i);
        }
      }
    }
  }
  return x.map((v, j) => (usable[j] ? Math.max(0, v) / norms[j]! : 0));
}

/** A day the fit can use: no reset inside it, and samples spanning ≥ 20 h. */
export function isUsableDay(d: QuotaDayRow): boolean {
  return (
    !d.resetCrossed &&
    d.firstUtil !== null &&
    d.lastUtil !== null &&
    d.firstMs !== null &&
    d.lastMs !== null &&
    d.lastMs - d.firstMs >= MIN_DAY_SPAN_MS
  );
}

function tokensOf(d: QuotaDayRow): Record<Category, number> {
  return {
    in: d.tokIn,
    out: d.tokOut,
    cr: d.tokCr,
    w1: d.tokW1,
    w5: d.tokW5,
    wu: d.tokWu,
  };
}

/** Fit percentage points per million tokens by category (NNLS, usable days). */
export function fitQuotaWeights(days: readonly QuotaDayRow[]): QuotaWeights {
  const usable = days.filter(isUsableDay);
  const n = usable.length;
  if (n < MIN_FIT_DAYS)
    return { status: "insufficient", n, r2: null, ppPerMTok: null };
  const A = usable.map(d => {
    const t = tokensOf(d);
    return WEIGHT_CATEGORIES.map(c => t[c] / 1_000_000);
  });
  const y = usable.map(d => d.lastUtil! - d.firstUtil!);
  const x = nnls(A, y);
  const mean = y.reduce((s, v) => s + v, 0) / n;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const fit = A[i]!.reduce((s, v, j) => s + v * x[j]!, 0);
    ssRes += (y[i]! - fit) ** 2;
    ssTot += (y[i]! - mean) ** 2;
  }
  const weights = Object.fromEntries(
    WEIGHT_CATEGORIES.map((c, j) => [c, x[j]!])
  ) as Record<Category, number>;
  return {
    status: "ok",
    n,
    r2: ssTot > 0 ? 1 - ssRes / ssTot : null,
    ppPerMTok: weights,
  };
}

// ─────────────────────────── the model and the loop ───────────────────────────

/** The aggregate quota model the summary carries (no account identities). */
export function buildQuotaModel(input: {
  accounts: readonly QuotaAccount[] | null;
  weights: QuotaWeights | null;
  unattributedShare: number | null;
}): QuotaModel & { unattributedShare: number | null } {
  // No accounts (the usage sampler has not run, or none are signed in) is
  // "no data yet", not a fleet of zero.
  const accounts = input.accounts ?? [];
  const available = accounts.some(a => a.utilization !== null);
  return {
    available,
    reason: available ? null : "No usage data on this node yet.",
    label: QUOTA_ESTIMATE_LABEL,
    window: QUOTA_WINDOW,
    fleet: fleetRunway(accounts),
    weights: input.weights,
    unattributedShare: input.unattributedShare,
  };
}

export interface QuotaUpkeepReport {
  daysWritten: number;
  rows: number;
  weights: QuotaWeights | null;
}

/**
 * The daily upkeep: derive the account-day rows for completed UTC days still
 * covered by the snapshots, re-derive the last three (late mirror rows), fit
 * the weights and keep the fit in state for the summary.
 */
export class ThroughputQuota {
  constructor(
    private readonly opts: {
      rollups: ThroughputRollupStore;
      usageHistory: Pick<UsageHistoryStore, "listByLimit">;
      now?: () => number;
    }
  ) {}

  private get nowMs(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The last fit, as stored by {@link upkeep}. */
  storedWeights(): QuotaWeights | null {
    const raw = this.opts.rollups.getState("quota.fit");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as QuotaWeights;
    } catch {
      return null;
    }
  }

  upkeep(): QuotaUpkeepReport {
    const { rollups } = this.opts;
    const now = this.nowMs;
    const today = utcDayOf(now);
    const yesterday = utcDayOf(now - DAY_MS);
    const oldest = utcDayOf(now - SNAPSHOT_RETENTION_DAYS * DAY_MS);
    const last = rollups.getState("quota.day");
    const refreshFrom = utcDayOf(now - REFRESH_DAYS * DAY_MS);
    let from = last && last >= oldest ? last : oldest;
    if (refreshFrom < from) from = refreshFrom;
    let daysWritten = 0;
    let rows = 0;
    for (let d = from; d <= yesterday; d = utcDayOf(dayStartMs(d) + DAY_MS)) {
      const start = dayStartMs(d);
      const samples = this.opts.usageHistory.listByLimit(
        QUOTA_WINDOW,
        start,
        start + DAY_MS
      );
      const byAccount = new Map<string, UsageSnapshotRow[]>();
      for (const s of samples) {
        let list = byAccount.get(s.accountUuid);
        if (!list) byAccount.set(s.accountUuid, (list = []));
        list.push(s);
      }
      const tokens = rollups.accountTokensForDay(d);
      const un = tokens.get(UNATTRIBUTED_ACCOUNT);
      const unattributedTok = un
        ? un.tokIn + un.tokOut + un.tokCr + un.tokW1 + un.tokW5 + un.tokWu
        : 0;
      for (const [accountId, list] of byAccount) {
        rollups.upsertQuotaDay(
          quotaDayRow({
            accountId,
            day: d,
            samples: list,
            tokens: tokens.get(accountId) ?? null,
            unattributedTok,
          })
        );
        rows += 1;
      }
      daysWritten += 1;
    }
    if (yesterday >= from) rollups.setState("quota.day", yesterday);
    if (rollups.getState("quota.pruned_day") !== today) {
      rollups.pruneQuotaBefore(utcDayOf(now - QUOTA_RETENTION_DAYS * DAY_MS));
      rollups.setState("quota.pruned_day", today);
    }
    const weights = fitQuotaWeights(
      rollups.listQuotaDays(utcDayOf(now - FIT_WINDOW_DAYS * DAY_MS))
    );
    rollups.setState("quota.fit", JSON.stringify(weights));
    return { daysWritten, rows, weights };
  }
}

/** Build the `throughput-quota` SupervisedLoop (hourly upkeep). */
export function createQuotaLoop(opts: {
  quota: ThroughputQuota;
  node: string;
  enabled: boolean;
  registry?: JobRegistry;
  onEvent?: (event: JobFailureEvent) => void;
  monotonic?: () => number;
}): SupervisedLoop {
  const monotonic = opts.monotonic ?? (() => performance.now());
  return new SupervisedLoop({
    name: QUOTA_LOOP_NAME,
    node: opts.node,
    intervalMs: INTERVAL_MS,
    enabled: opts.enabled,
    immediate: false,
    registry: opts.registry,
    onEvent: opts.onEvent,
    tick: () => {
      const t0 = monotonic();
      const r = opts.quota.upkeep();
      const ms = Math.round(monotonic() - t0);
      opts.registry?.update(QUOTA_LOOP_NAME, {
        throughput: {
          tickMs: ms,
          mbRead: 0,
          rowsWritten: r.rows,
          longestSyncMs: ms,
          fit: r.weights?.status ?? null,
          n: r.weights?.n ?? 0,
        },
      });
    },
  });
}
