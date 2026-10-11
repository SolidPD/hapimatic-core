// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shadow-mode parity thresholds (issue #1669, epic #1662, Sub G).
 *
 * Asymmetric, bias-aware acceptance thresholds for the nightly parity harness
 * (KD4). The legacy time/token side is biased in BOTH directions and #1508 is
 * unfixed, so a single symmetric tolerance + an N-day green streak would
 * deadlock and block the read-path cutover (Sub H) indefinitely (OR2). Each
 * metric therefore carries SEPARATE over/under tolerances keyed to the KNOWN
 * legacy biases:
 *
 *   - TIME: legacy OVER-counts (MAX-lock at `timeLog.ts:192` + client wall-clock
 *     `accumulatedMs` + #1508 midnight re-inflation) and UNDER-counts (no
 *     session-end flush + first-flush baseline-skip + 5-min sweep tail loss).
 *     The new derivation (`Σ turns.duration_ms`) is the cleaner signal, so the
 *     legacy-vs-new delta is expected to run legacy-high → a wider over-tolerance.
 *   - TOKENS (bias model REVISED by #2229): both sides now count each API
 *     `message.id` once (the parser dedups transcript per-block lines; the
 *     client side folds per-run via `@hapi/protocol/tokenUsageAggregation`),
 *     and a result-closed run sources `modelUsage`, which is
 *     sub-agent-INCLUSIVE — so for SDK-launcher sessions the OR3 sub-agent
 *     surplus largely disappears on ALL four classes. Residual expected
 *     biases: (a) tmux/pty sessions and result-less trailing runs
 *     (interrupted turns) — per-message data excludes sub-agent files and
 *     carries placeholder output in the SDK-interrupted case → DB ≥ client;
 *     (b) pre-#2229 history stays structurally divergent (placeholder output,
 *     no result usage) — historical days cannot retro-green.
 *
 *     RECALIBRATION PROCEDURE (deferred remedy (c) of #2229): after ≥3
 *     post-#2229 nightly runs, read the per-class deltas from `parity_runs`
 *     (the #2229 status-aware representative delta) and/or
 *     `<HAPI_HOME>/parity/<date>.json`, then tighten `overPct` per class via
 *     the `parityThresholds` settings key first (config-only, zero-deploy),
 *     and fold the measured values into these defaults once stable. The
 *     numeric defaults below are UNCHANGED by #2229 (measure, then tune).
 *
 * G MEASURES these biases; it does NOT fix them (that is Sub H / #1508 scope).
 *
 * Config is loaded fresh on each call (mirrors `config/timeLogConfig.ts`) from
 * the `parityThresholds` key in settings.json, merged over conservative defaults.
 */

import { getSettingsFile, readSettings } from "../config/settings";

/** The gated metrics the harness tracks streaks for. */
export type ParityMetric =
  | "time"
  | "tokIn"
  | "tokOut"
  | "tokCacheRead"
  | "tokCacheWrite";

export const PARITY_METRICS: readonly ParityMetric[] = [
  "time",
  "tokIn",
  "tokOut",
  "tokCacheRead",
  "tokCacheWrite",
] as const;

/**
 * Per-metric asymmetric tolerance. `deltaPct` is `(new - legacy) / legacy * 100`
 * (signed). A POSITIVE delta means the new pipeline reports MORE than legacy;
 * NEGATIVE means less.
 *
 *   - `exactPct`  — |delta| within this band → `green` (a clean match).
 *   - `overPct`   — a positive delta up to this bound is `within-bias` (PASS) —
 *                   the known "new ≥ legacy" direction (e.g. token sub-agent roll-up).
 *   - `underPct`  — a negative delta down to this bound is `within-bias` (PASS) —
 *                   the known "new ≤ legacy" direction (e.g. legacy time over-count).
 *
 * Anything beyond `overPct` / `underPct` is `red` (FAIL — an unexplained divergence).
 */
export interface MetricTolerance {
  exactPct: number;
  overPct: number;
  underPct: number;
}

export interface ParityThresholds {
  tolerances: Record<ParityMetric, MetricTolerance>;
  /** Consecutive PASS runs required per metric before the cutover gate opens. */
  streakDays: number;
}

/**
 * Conservative, bias-aware defaults. The asymmetry encodes the documented
 * legacy biases (KD4) so a within-bias divergence PASSES and only an
 * unexplained divergence trips a RED.
 */
export const DEFAULT_PARITY_THRESHOLDS: ParityThresholds = {
  tolerances: {
    // Legacy time can run high (over-count) OR low (tail loss); the new
    // duration sum is cleaner, so allow a wide legacy-high (negative delta:
    // new < legacy) band and a moderate new-high band.
    time: { exactPct: 2, overPct: 15, underPct: 40 },
    // Post-#2229 the sub-agent surplus persists only for tmux/pty sessions
    // and result-less trailing runs (see header) → keep the wide over band
    // until the post-fix residual is measured; the under direction stays tight.
    tokIn: { exactPct: 2, overPct: 50, underPct: 5 },
    tokOut: { exactPct: 2, overPct: 50, underPct: 5 },
    tokCacheRead: { exactPct: 2, overPct: 50, underPct: 5 },
    tokCacheWrite: { exactPct: 2, overPct: 50, underPct: 5 },
  },
  streakDays: 7,
};

/** Verdict for a single (metric, bucket) comparison. */
export type ParityStatus = "green" | "within-bias" | "red";

/** A `green` or `within-bias` verdict counts as a PASS for streak purposes. */
export function isPass(status: ParityStatus): boolean {
  return status === "green" || status === "within-bias";
}

/**
 * Classify a signed delta% for a metric against its asymmetric tolerance.
 *
 * A seeded/synthetic divergence beyond the bias band is detected as `red`
 * (R4); a within-bias divergence passes.
 */
export function classifyDelta(
  metric: ParityMetric,
  deltaPct: number,
  thresholds: ParityThresholds
): ParityStatus {
  const tol = thresholds.tolerances[metric];
  if (Math.abs(deltaPct) <= tol.exactPct) return "green";
  if (deltaPct > 0) return deltaPct <= tol.overPct ? "within-bias" : "red";
  return -deltaPct <= tol.underPct ? "within-bias" : "red";
}

/** Worst-of reducer: red dominates within-bias dominates green. */
export function worstStatus(statuses: readonly ParityStatus[]): ParityStatus {
  if (statuses.includes("red")) return "red";
  if (statuses.includes("within-bias")) return "within-bias";
  return "green";
}

function isTolerance(value: unknown): value is Partial<MetricTolerance> {
  return typeof value === "object" && value !== null;
}

/**
 * Load parity thresholds from settings.json (`parityThresholds` key), merged
 * over {@link DEFAULT_PARITY_THRESHOLDS}. Unknown/malformed entries fall back to
 * the conservative default for that field — a bad config never throws inside the
 * nightly job. Fresh read each call (no cache), matching `loadTimeLogConfig`.
 */
export async function loadParityThresholds(
  dataDir: string
): Promise<ParityThresholds> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  if (!settings) return DEFAULT_PARITY_THRESHOLDS;

  const raw = (settings as Record<string, unknown>).parityThresholds;
  if (!raw || typeof raw !== "object") return DEFAULT_PARITY_THRESHOLDS;

  const prefs = raw as Record<string, unknown>;
  const merged: ParityThresholds = {
    tolerances: { ...DEFAULT_PARITY_THRESHOLDS.tolerances },
    streakDays: DEFAULT_PARITY_THRESHOLDS.streakDays,
  };

  if (typeof prefs.streakDays === "number" && prefs.streakDays > 0) {
    merged.streakDays = Math.floor(prefs.streakDays);
  }

  const rawTol = prefs.tolerances;
  if (rawTol && typeof rawTol === "object") {
    for (const metric of PARITY_METRICS) {
      const candidate = (rawTol as Record<string, unknown>)[metric];
      if (!isTolerance(candidate)) continue;
      const base = merged.tolerances[metric];
      merged.tolerances[metric] = {
        exactPct:
          typeof candidate.exactPct === "number" && candidate.exactPct >= 0
            ? candidate.exactPct
            : base.exactPct,
        overPct:
          typeof candidate.overPct === "number" && candidate.overPct >= 0
            ? candidate.overPct
            : base.overPct,
        underPct:
          typeof candidate.underPct === "number" && candidate.underPct >= 0
            ? candidate.underPct
            : base.underPct,
      };
    }
  }

  return merged;
}
