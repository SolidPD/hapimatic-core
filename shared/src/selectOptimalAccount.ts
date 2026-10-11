// SPDX-License-Identifier: AGPL-3.0-only
import { HARD_LOCK_UTILIZATION } from "./usage";
import type { AccountUsage } from "./usage";

/**
 * Shared candidate-filter + lowest-score account-selection core (issue #3611,
 * epic #3609 Sub-Issue B).
 *
 * ONE implementation of "which under-utilized healthy account wins an auto-pick",
 * consumed by BOTH the web create-page auto-select
 * (`web/src/lib/selectOptimalAccount.ts`) and the daemon's un-pinned spawn
 * resolver (`cli/src/accounts/selectHealthyAccount.ts`) — no divergent copies
 * (R6). Deliberately I/O-free: the `unrefreshable` signal is an INJECTED predicate
 * so the module has no store/network dependency and types cleanly in all three
 * packages (its `accounts` parameter is typed STRUCTURALLY so neither the web
 * `RedactedAccount` mirror nor the server type crosses the `@hapi/protocol`
 * boundary — R6/3611-17).
 *
 * Two composable halves:
 *   - the CANDIDATE FILTER (R8, hard-lock-safe) — promoted from `selectSwitchTarget`
 *     (`server/src/services/autoSwitchOnRateLimit.ts`), which refuses a hard-locked
 *     account BY NAME. The pre-#3611 browser selector admitted `score === 100`
 *     (its only filters were `status !== "ok"` and non-finite score); this core
 *     additionally excludes `score >= HARD_LOCK_UTILIZATION`, either window at/above
 *     the hard lock, and `unrefreshable` accounts.
 *   - the LOWEST-SCORE ORDERING (R9 tie-break) — lifted from the browser selector's
 *     `score < bestScore` ordering, extended with the deterministic other-window
 *     tie-break epic #3609 assigns to the selectors.
 */

/**
 * The minimal usage shape the candidate filter needs — a structural subset of both
 * `AccountUsage` (web/server) and the daemon's enriched utilization snapshot. The
 * two raw window utilizations are OPTIONAL: a caller without per-window data simply
 * skips those two guards, and `score >= HARD_LOCK_UTILIZATION` still catches a hard
 * lock because the post-#3610 served score is `round(max(weekly, fiveHour))` — a
 * window at cap forces `score === 100`.
 */
export interface OptimalCandidateUsage {
  accountUuid: string;
  /** Only `"ok"` qualifies; every other status carries a null score and is filtered. */
  status: string;
  /** The served pacing score (0–100); `null`/`undefined` for a non-`ok` status. */
  score: number | null | undefined;
  /** Raw 5-hour window utilization (0–100), when known. */
  fiveHourUtilization?: number | null;
  /** Raw weekly (seven-day) window utilization (0–100), when known. */
  sevenDayUtilization?: number | null;
}

/**
 * R8 hard-lock-safe candidate filter (the promoted `selectSwitchTarget` guards).
 * An account qualifies for auto-selection ONLY when every clause holds:
 *   - `status === "ok"` (a degraded/rate-limited/expired account carries a null score);
 *   - a finite numeric `score` (the load-bearing null guard — `score: null` for every
 *     non-`ok` status would coerce to 0 under a bare `<` and read maximally-healthy);
 *   - `score < HARD_LOCK_UTILIZATION`;
 *   - neither KNOWN window (`five_hour` / `seven_day`) at/above the hard lock;
 *   - not `unrefreshable`.
 */
export function isOptimalCandidate(
  u: OptimalCandidateUsage,
  isUnrefreshable: (accountUuid: string) => boolean
): boolean {
  if (u.status !== "ok") return false;
  if (typeof u.score !== "number" || !Number.isFinite(u.score)) return false;
  if (u.score >= HARD_LOCK_UTILIZATION) return false;
  if (
    typeof u.fiveHourUtilization === "number" &&
    u.fiveHourUtilization >= HARD_LOCK_UTILIZATION
  ) {
    return false;
  }
  if (
    typeof u.sevenDayUtilization === "number" &&
    u.sevenDayUtilization >= HARD_LOCK_UTILIZATION
  ) {
    return false;
  }
  if (isUnrefreshable(u.accountUuid)) return false;
  return true;
}

/**
 * A qualified candidate ready for ordering. `score` is finite (the filter
 * guarantees it). The two raw window utilizations drive R9's tie-break.
 */
export interface RankedCandidate {
  accountUuid: string;
  score: number;
  fiveHourUtilization?: number | null;
  sevenDayUtilization?: number | null;
}

/**
 * Compare two window utilizations for HEADROOM. Lower utilization = more headroom =
 * "less than" (preferred), so this returns `-1` when `a` has more headroom. A
 * `null`/`undefined`/non-finite utilization is "no signal": it returns `0` against
 * anything, so a known value only ever orders against another KNOWN value — never
 * against an unknown — keeping the tie-break deterministic and stable when a window
 * is missing.
 */
function compareHeadroom(
  a: number | null | undefined,
  b: number | null | undefined
): number {
  const aKnown = typeof a === "number" && Number.isFinite(a);
  const bKnown = typeof b === "number" && Number.isFinite(b);
  if (!aKnown || !bKnown) return 0;
  if ((a as number) < (b as number)) return -1;
  if ((a as number) > (b as number)) return 1;
  return 0;
}

/** True when candidate `c` should beat the current `best` on a served-score tie (R9). */
function tieBreakPrefers(c: RankedCandidate, best: RankedCandidate): boolean {
  // Weekly (seven-day) window first — the epic's canonical "identical 5-hour
  // pressure but different weekly slack" case, where the weekly window is the
  // more durable headroom axis (the 5-hour window resets within ≤5h).
  const weekly = compareHeadroom(
    c.sevenDayUtilization,
    best.sevenDayUtilization
  );
  if (weekly !== 0) return weekly < 0;
  // Then the 5-hour window.
  const fiveHour = compareHeadroom(
    c.fiveHourUtilization,
    best.fiveHourUtilization
  );
  if (fiveHour !== 0) return fiveHour < 0;
  // Fully tied (or windows unknown) → keep the first-seen candidate (stable).
  return false;
}

/**
 * Lowest-score-wins ordering with the R9 tie-break. Post-#3610 the served score is
 * `round(max(weeklyScore, fiveHourScore))`, which produces MORE ties than the old
 * blended number, so a first-in-array tie resolution would hand every tie to the
 * same account by arbitrary directory order (the load-balancing regression this
 * epic exists to prevent). The deterministic, documented order:
 *
 *   1. lower `score` wins;
 *   2. on a score tie, lower `sevenDayUtilization` (more weekly headroom) wins;
 *   3. still tied → lower `fiveHourUtilization` wins;
 *   4. still tied (or both windows unknown) → stable first-seen (array) order.
 *
 * Returns the winning `accountUuid`, or `null` for an empty list.
 */
export function pickLowestScoreCandidate(
  candidates: readonly RankedCandidate[]
): string | null {
  let best: RankedCandidate | null = null;
  for (const c of candidates) {
    if (best === null) {
      best = c;
      continue;
    }
    if (c.score < best.score) {
      best = c;
      continue;
    }
    if (c.score > best.score) continue;
    if (tieBreakPrefers(c, best)) best = c;
  }
  return best?.accountUuid ?? null;
}

/**
 * Full picker for the web create-page: candidate filter (R8) + lowest-score
 * ordering (R9). `accounts` is typed STRUCTURALLY so no package-specific account
 * type crosses the boundary; iterating `accounts` (not `usage`) guarantees only an
 * account actually in the local picker list is eligible (the usage aggregator can
 * return federated accounts not in this node's stored set). Usage is joined by
 * `accountUuid`. `isUnrefreshable` is injected (default: never — a caller with no
 * unrefreshable signal is unchanged). Returns `null` when none qualify; the caller
 * then falls back to its existing default selection.
 */
export function selectOptimalAccountUuid(
  accounts: readonly { accountUuid: string }[],
  usage: readonly AccountUsage[],
  isUnrefreshable: (accountUuid: string) => boolean = () => false
): string | null {
  const usageByUuid = new Map<string, AccountUsage>();
  for (const u of usage) usageByUuid.set(u.accountUuid, u);

  const ranked: RankedCandidate[] = [];
  for (const account of accounts) {
    const u = usageByUuid.get(account.accountUuid);
    if (!u) continue;
    // `AccountUsage.utilization` is required by the schema, but test fixtures use
    // partial casts, so optional-chain defensively (an absent window → "no signal").
    const fiveHourUtilization = u.utilization?.five_hour?.utilization ?? null;
    const sevenDayUtilization = u.utilization?.seven_day?.utilization ?? null;
    if (
      !isOptimalCandidate(
        {
          accountUuid: account.accountUuid,
          status: u.status,
          score: u.score,
          fiveHourUtilization,
          sevenDayUtilization,
        },
        isUnrefreshable
      )
    ) {
      continue;
    }
    ranked.push({
      accountUuid: account.accountUuid,
      score: u.score as number, // finite (the filter guarantees it)
      fiveHourUtilization,
      sevenDayUtilization,
    });
  }
  return pickLowestScoreCandidate(ranked);
}
