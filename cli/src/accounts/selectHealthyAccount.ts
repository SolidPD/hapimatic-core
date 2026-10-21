// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Un-pinned spawn account resolution: utilization-aware pick + healthy-account fallback
 * (issues #3023, #5460).
 *
 * An un-pinned session spawn (no `--account`, so no `HAPI_ACCOUNT_UUID`) binds the
 * host machine's default Claude login. Before #3023 nothing on the daemon spawn path
 * looked at that account's utilization, so the daemon silently bound an account at 100%
 * weekly — or one being rate-limited — even when a healthier account was available.
 * #3023 made the spawn prefer a healthy account and log every decision. #5460 removed its
 * refusal: when no account is healthy, the host-default is bound anyway (logged loudly),
 * because creating a session never needs usage and the user can switch its account later.
 *
 * This module is the pure decision core for the veto. It is deliberately I/O-free:
 * callers inject a `readSnapshot` reader (backed by the daemon's cached utilization
 * snapshots — see `accountStore.getUtilizationSnapshot`), the resolved host-default
 * UUID, and the registered candidate UUIDs. That keeps every branch unit-testable
 * without a live daemon, a network fetch, or the real account store.
 *
 * ## STATUS-FIRST classification (the two-axis reconciliation)
 *
 * There are two ORTHOGONAL axes (epic #2737 / operator ruling at #3023 Gate 2):
 *
 *   1. **Credential BINDABILITY (epic IF-2 / #2457's gate)** — "may a session bind to
 *      this account at all?". Whitelist the transient statuses `refreshing`/`rate_limited`
 *      as bindable, refuse only TERMINAL `expired`/`unrefreshable`/401-403. This is NOT
 *      this module's job — it stays #2457's landed pre-daemon gate.
 *   2. **Un-pinned SELECTION preference (this module)** — "should an un-pinned spawn
 *      auto-PICK this account?". A `rate_limited` account is bindable-if-explicitly-pinned
 *      but must be DEPRIORITISED for auto-selection, because it is the account an un-pinned
 *      spawn should MOST avoid (a persistent 429 will likely kill the fresh session too).
 *
 * So the veto keys on the daemon-sampled STATUS first, then the score:
 *
 *   - `ok` + a fresh numeric score `< HARD_LOCK_SCORE` → **healthy** (auto-selectable; the
 *     score is the tiebreak AMONG `ok` accounts).
 *   - `ok` + score `>= HARD_LOCK_SCORE` (a 5-hour/weekly window at cap) → **exhausted**.
 *   - `terminal` (401/403 from the usage probe) → **refused**.
 *   - `rate_limited` (persistent 429) → **deprioritised**.
 *
 * An unhealthy host-default (exhausted / refused / deprioritised) is never the auto-pick:
 * the spawn falls back to the healthiest account. When no healthy account exists, the
 * host-default is bound anyway as a loud, logged LAST RESORT. The resolver NEVER refuses a
 * spawn (#5460): usage never blocks creating a session, because the user can switch a live
 * session's account; and a `terminal` sample reads the store's advisory token copy, which can
 * be stale. A genuinely dead login still surfaces as an auth error on the session's first turn.
 *   - `unknown` (timeout / 5xx / empty / malformed / no cached snapshot / stale) → **pass
 *     through**: the utilization is genuinely undetermined, so do NOT coerce it into a veto or
 *     a health signal. A `null` score NEVER reaches a `<`/`>=` comparison here (the numeric
 *     guard below) — a `null < threshold` would coerce to 0 and read as maximally-healthy,
 *     the exact trap this design avoids; and no synthetic score is ever invented.
 */

import {
  isOptimalCandidate,
  pickLowestScoreCandidate,
  type OptimalCandidateUsage,
  type RankedCandidate,
} from "@hapi/protocol";

/**
 * The pacing score at/above which an account is hard-locked — a 5-hour or overall-
 * weekly window at cap, so a fresh session bound to it dies on its first turn.
 * `computeUtilizationScore` (`shared/src/usage.ts`) returns EXACTLY this value for a
 * capped account (its `HARD_LOCK_UTILIZATION` const). Mirrored here as a cli-local
 * constant so this veto stays inside `cli/` (issue #3023 scope); the value is
 * definitional (100% = full) and stable.
 */
export const HARD_LOCK_SCORE = 100;

/**
 * How old a cached utilization snapshot may be before the veto treats it as UNKNOWN
 * (stale) and passes the spawn THROUGH rather than acting on a possibly-outdated
 * signal. The daemon sampler refreshes every tokenRefreshService tick (≤60s), so a
 * healthy daemon keeps snapshots well inside this window. Bounding the read age (the
 * directive's "Utilization freshness" Open Risk) prevents a stalled sampler from
 * vetoing on stale data.
 */
export const UTILIZATION_SNAPSHOT_FRESHNESS_MS = 5 * 60 * 1000;

/**
 * The daemon-side classification of an account's usage-fetch outcome — the STATUS axis
 * of the veto (see the module header). Deliberately COARSER than the server's 6-value
 * `AccountUsageStatus`: the veto only needs to distinguish "healthy-scorable" from
 * "actively rate-limited" from "credential-dead" from "can't tell".
 *
 * - `ok`           — the usage endpoint returned parseable utilization; `score` is a number.
 * - `rate_limited` — a persistent HTTP 429 (the account is being throttled); `score` is null.
 * - `terminal`     — HTTP 401/403 (the token is rejected / credential-dead); `score` is null.
 * - `unknown`      — timeout / 5xx / empty (no-scope) / malformed / no token; `score` is null.
 *
 * NOTE: #3618 (auto-switch a live session on the rate-limit rising edge) reads this same
 * cached `status` field — `getUtilizationSnapshot(uuid).status === "rate_limited"` is the
 * shared rising-edge signal. Keep the values stable.
 */
export type UtilizationStatus = "ok" | "rate_limited" | "terminal" | "unknown";

/**
 * A cached, read-only utilization snapshot for one account. Written by the daemon's
 * per-tick sampler (`utilizationSampler.ts`) into the account store's in-memory cache
 * (`accountStore.setUtilizationSnapshot`); read by the spawn veto.
 */
export interface UtilizationSnapshot {
  /** The daemon-side fetch-outcome classification (the status axis). */
  status: UtilizationStatus;
  /**
   * The shared pacing score (0–100) from `computeUtilizationScore`, a number ONLY when
   * `status === "ok"`, else `null`. `null` is never coerced into a comparison.
   */
  score: number | null;
  /** Epoch ms the snapshot was taken (used for the freshness bound). */
  fetchedAt: number;
  /** Best-effort account label, for the observability log line only. */
  emailAddress?: string;
  /**
   * Raw 5-hour window utilization (0–100) at sample time, when known. Carried
   * solely for the #3611 optimal-pick tie-break (R9) — the served `score` alone
   * cannot distinguish two accounts tied on `round(max(weekly, fiveHour))`. The
   * sampler stashes it from the same parsed utilization it scores; a snapshot
   * written without it (older writer) simply yields no tie-break signal.
   */
  fiveHourUtilization?: number | null;
  /**
   * Raw weekly (seven-day) window utilization (0–100) at sample time, when known.
   * The primary #3611 tie-break axis (R9) — the epic's canonical "identical 5-hour
   * pressure but different weekly slack" case prefers the lower value.
   */
  sevenDayUtilization?: number | null;
}

/** Reads a cached snapshot for an account UUID, or `undefined` when none is cached. */
export type SnapshotReader = (
  accountUuid: string
) => UtilizationSnapshot | undefined;

/** How a snapshot classifies for UN-PINNED SELECTION (the preference axis). */
export type SelectionClass =
  | "healthy" // ok + fresh numeric score below the hard lock — auto-selectable
  | "exhausted" // ok + fresh numeric score at/above the hard lock — never auto-picked; bound only as a last resort
  | "deprioritised" // rate_limited — never auto-picked; bound only as a last resort
  | "refused" // terminal (401/403 probe) — never auto-picked; bound only as a last resort
  | "unknown"; // stale / no snapshot / status unknown — pass through

/** A snapshot is FRESH when it exists and was taken within the freshness window. */
function isFresh(
  snap: UtilizationSnapshot | undefined,
  now: number,
  freshnessMs: number
): snap is UtilizationSnapshot {
  return !!snap && now - snap.fetchedAt <= freshnessMs;
}

/**
 * Classify a snapshot for un-pinned SELECTION. Status-first (never score-first): a `null`
 * score is only ever read for an `ok` snapshot, and even then the `typeof === "number"`
 * guard prevents a `null`/undefined from reaching the `>=` comparison (the coercion trap).
 */
export function classifyForSelection(
  snap: UtilizationSnapshot | undefined,
  now: number,
  freshnessMs: number = UTILIZATION_SNAPSHOT_FRESHNESS_MS
): SelectionClass {
  if (!isFresh(snap, now, freshnessMs)) return "unknown";
  switch (snap.status) {
    case "ok":
      // A definitive numeric score is required to grade an `ok` account; a missing/
      // non-numeric score for `ok` is anomalous → treat as unknown (never coerce).
      if (typeof snap.score !== "number" || !Number.isFinite(snap.score)) {
        return "unknown";
      }
      return snap.score >= HARD_LOCK_SCORE ? "exhausted" : "healthy";
    case "rate_limited":
      return "deprioritised";
    case "terminal":
      return "refused";
    case "unknown":
      return "unknown";
  }
}

export interface SelectHealthyOptions {
  now: number;
  freshnessMs?: number;
  /** Exclude this UUID from consideration (e.g. the deprioritised host-default itself). */
  excludeUuid?: string | null;
  /**
   * #5460: skip an account whose store record is flagged `unrefreshable` (its login is
   * dead). Its access token can still answer the usage probe with an `ok` snapshot for a
   * while, but token injection refuses to bind it, so picking it would fail the spawn.
   */
  isUnrefreshable?: (accountUuid: string) => boolean;
}

/**
 * Pick the healthiest bindable account: the `healthy` account (status `ok`, fresh numeric
 * score below the hard lock) with the LOWEST score. Returns `null` when none qualifies.
 * Only `healthy` accounts are candidates — `deprioritised` / `refused` / `exhausted` /
 * `unknown` are never chosen (a positive whitelist, never a status blacklist), and neither
 * is an account `isUnrefreshable` flags. Ties on score break by first-seen order (stable)
 * for determinism under test.
 */
export function selectHealthyAccount(
  accountUuids: readonly string[],
  readSnapshot: SnapshotReader,
  opts: SelectHealthyOptions
): string | null {
  const freshnessMs = opts.freshnessMs ?? UTILIZATION_SNAPSHOT_FRESHNESS_MS;
  let best: { uuid: string; score: number } | null = null;
  for (const uuid of accountUuids) {
    if (opts.excludeUuid && uuid === opts.excludeUuid) continue;
    if (opts.isUnrefreshable?.(uuid)) continue;
    const snap = readSnapshot(uuid);
    if (classifyForSelection(snap, opts.now, freshnessMs) !== "healthy")
      continue;
    // `healthy` guarantees a fresh numeric score below the hard lock.
    const score = snap!.score as number;
    if (best === null || score < best.score) {
      best = { uuid, score };
    }
  }
  return best?.uuid ?? null;
}

export type UnpinnedDecision =
  | "not-unpinned" // a pinned account or a respawn/resume — veto does not apply
  | "no-host-default" // no host-default UUID resolvable — cannot check, pass through
  | "healthy-host-default" // host-default is healthy — bind it
  | "optimal-pick" // #3611: opt-in ON + fresh local spawn — a healthy account scores strictly lower than the healthy host-default → bind the optimal account
  | "unknown-utilization" // host-default's utilization is stale/undetermined — pass through
  | "fallback" // host-default exhausted/deprioritised/refused → rebind to a healthy account
  | "degraded-last-resort" // host-default rate-limited, no healthy account → bind it LOUDLY as a last resort
  | "exhausted-last-resort" // host-default at its usage cap, no healthy account → bind it anyway (#5460: usage never blocks a spawn)
  | "rejected-last-resort"; // host-default probe answered 401/403, no healthy account → bind it anyway (#5460: a stale store-token sample must not block a spawn)

export interface UnpinnedResolution {
  /**
   * The UUID to bind. `null` means "leave the incoming binding unchanged" — either the
   * spawn was already pinned/respawn, or the host-default is being kept (pass-through /
   * healthy / last-resort). A non-null value is a rebind — either a FALLBACK (host-default
   * unhealthy) or an #3611 `optimal-pick` (opt-in ON, a healthier account scores strictly
   * lower than a healthy host-default). The resolver never refuses a spawn (#5460).
   */
  accountUuid: string | null;
  decision: UnpinnedDecision;
  /** Human-readable rationale for the spawn-time observability log (R2 / AC2). */
  reason: string;
}

export interface ResolveUnpinnedOpts {
  /** The incoming pinned account UUID; empty/undefined ⇒ un-pinned spawn. */
  accountUuid: string | undefined | null;
  /**
   * True when this spawn is a respawn/resume — signalled by a `resumeSessionId` in the
   * RPC payload ALONE (NOT by a `hapiSessionId`, which a FRESH spawn also carries).
   * Respawns are EXEMPT from the veto (directive D2/R17): server respawn paths
   * (`sessionRespawn.ts` reconnect + branch) reuse the same spawn RPC with `accountUuid`
   * undefined for un-pinned sessions, and a fallback-rebind would break `--resume`
   * (per-account `CLAUDE_CONFIG_DIR` isolation, #1551). Scheduler FRESH spawns are NOT
   * respawns (no `resumeSessionId`) and DO get the veto (by design).
   */
  isRespawn: boolean;
  hostDefaultUuid: string | null;
  /** All registered account UUIDs (from `accountStore.list()`). */
  candidateUuids: readonly string[];
  readSnapshot: SnapshotReader;
  now: number;
  freshnessMs?: number;
  /**
   * #3611: the un-pinned optimal-account-selection opt-in, resolved server-side
   * from the `autoSelectOptimalAccount` preference mirror and delivered on the
   * spawn RPC. Absent/false ⇒ NO optimal pick (R3).
   */
  autoSelectOptimalAccount?: boolean;
  /**
   * #3611 R7: the POSITIVE fresh-spawn whitelist — `true` ONLY for a fresh,
   * un-pinned, locally-originated spawn (computed at the `sessionSpawner` call site
   * from `!accountUuid && !resumeSessionId && !originatingNodeId &&
   * !parentSessionId && !parentRelationship`). The optimal-pick fires ONLY when
   * this is `true`, so every respawn/resume/successor-handoff/federation-incoming
   * spawn shape falls through untouched (mirrors #3023's respawn exemption; keeps
   * `--resume` per-account `CLAUDE_CONFIG_DIR` isolation intact, #1551). A NEW
   * caller that should get the pick must satisfy this whitelist — it is never
   * amended to exclude a shape.
   */
  isFreshLocalSpawn?: boolean;
  /**
   * #3611 R8 / #5460: the `unrefreshable` exclusion predicate (injected so the resolver
   * stays I/O-free). Consulted by the optimal-pick branch AND by the unhealthy-host
   * fallback (step 6), so neither ever binds an account whose login is dead. The caller
   * builds it only when one of those branches can run; absent ⇒ no account is excluded.
   */
  isUnrefreshable?: (accountUuid: string) => boolean;
}

/**
 * #3611 optimal-pick: choose the lowest served-score account among the daemon's
 * FRESH, HEALTHY candidates, via the SHARED `@hapi/protocol` core (R6 — one
 * candidate-filter + ordering, no divergent copy). Reconciles the daemon's
 * snapshot data source with the shared core per D2:
 *   - the daemon's own `classifyForSelection` is the FIRST gate ("may I trust my
 *     own snapshot at all?" — freshness + status + score-below-cap); a stale /
 *     non-`ok` / exhausted snapshot never reaches the shared core;
 *   - the shared `isOptimalCandidate` filter then adds R8's window-cap and
 *     `unrefreshable` exclusions, and `pickLowestScoreCandidate` owns "which
 *     account wins" (lowest score + R9 other-window tie-break).
 * Returns the winning UUID (possibly the host-default itself), or `null` when no
 * candidate qualifies.
 */
function pickOptimalFromSnapshots(
  candidateUuids: readonly string[],
  readSnapshot: SnapshotReader,
  now: number,
  freshnessMs: number,
  isUnrefreshable: (accountUuid: string) => boolean
): string | null {
  const ranked: RankedCandidate[] = [];
  for (const uuid of candidateUuids) {
    const snap = readSnapshot(uuid);
    // Daemon's independent last line of defence (freshness + status + score < cap).
    if (classifyForSelection(snap, now, freshnessMs) !== "healthy") continue;
    // `healthy` guarantees a fresh `ok` snapshot with a finite score below the cap.
    const candidate: OptimalCandidateUsage = {
      accountUuid: uuid,
      status: "ok",
      score: snap!.score,
      fiveHourUtilization: snap!.fiveHourUtilization,
      sevenDayUtilization: snap!.sevenDayUtilization,
    };
    // Shared hard-lock-safe filter (R8) — window caps + unrefreshable.
    if (!isOptimalCandidate(candidate, isUnrefreshable)) continue;
    ranked.push({
      accountUuid: uuid,
      score: snap!.score as number,
      fiveHourUtilization: snap!.fiveHourUtilization,
      sevenDayUtilization: snap!.sevenDayUtilization,
    });
  }
  return pickLowestScoreCandidate(ranked);
}

/**
 * Resolve which account an un-pinned daemon spawn should bind, vetoing a host-default the
 * spawn should not auto-pick. Pure — every input is injected. See the module header for the
 * status-first classification and the bindability-vs-selection reconciliation.
 */
export function resolveUnpinnedSpawnAccount(
  opts: ResolveUnpinnedOpts
): UnpinnedResolution {
  const freshnessMs = opts.freshnessMs ?? UTILIZATION_SNAPSHOT_FRESHNESS_MS;

  // 1. Pinned spawn — the veto NEVER touches a caller who chose an account.
  if (opts.accountUuid) {
    return {
      accountUuid: null,
      decision: "not-unpinned",
      reason: "account explicitly pinned — veto not applicable",
    };
  }
  // 2. Respawn / resume — exempt (D2/R17). A rebind would break --resume isolation.
  if (opts.isRespawn) {
    return {
      accountUuid: null,
      decision: "not-unpinned",
      reason:
        "respawn/resume spawn — exempt from the un-pinned veto (#3023 D2/R17)",
    };
  }
  // 3. No host-default resolvable — a missing ~/.claude.json also breaks native
  //    Claude Code, so there is no bad bind to prevent. Pass through.
  if (!opts.hostDefaultUuid) {
    return {
      accountUuid: null,
      decision: "no-host-default",
      reason: "no host-default account resolvable — nothing to veto",
    };
  }

  const snap = opts.readSnapshot(opts.hostDefaultUuid);
  const klass = classifyForSelection(snap, opts.now, freshnessMs);

  // 4. Healthy host-default. Normally bind it (the common, happy path). But when the
  //    #3611 opt-in is enabled AND this is a fresh, locally-originated un-pinned spawn
  //    (R7 whitelist), run the SHARED lowest-score core over ALL candidates (the
  //    host-default INCLUDED — no `excludeUuid`) and rebind to a healthier account when
  //    one scores strictly lower. If the core returns the host-default or nothing,
  //    fall through to bind the host-default (today's behavior). Opt-in OFF or a
  //    non-fresh spawn skips this branch entirely, so #3023's decision is unchanged (R3).
  if (klass === "healthy") {
    if (opts.autoSelectOptimalAccount && opts.isFreshLocalSpawn) {
      const picked = pickOptimalFromSnapshots(
        opts.candidateUuids,
        opts.readSnapshot,
        opts.now,
        freshnessMs,
        opts.isUnrefreshable ?? (() => false)
      );
      if (picked && picked !== opts.hostDefaultUuid) {
        const pickedSnap = opts.readSnapshot(picked);
        return {
          accountUuid: picked,
          decision: "optimal-pick",
          reason: `un-pinned spawn (opt-in ON): host-default ${opts.hostDefaultUuid} is healthy (score=${snap!.score}) but ${picked} has a lower served score (${pickedSnap?.score ?? "?"}) — binding the optimal account`,
        };
      }
      // picked === host-default OR null → fall through and bind the host-default.
    }
    return {
      accountUuid: null,
      decision: "healthy-host-default",
      reason: `host-default ${opts.hostDefaultUuid} status=ok score=${snap!.score} (< cap) — binding it`,
    };
  }
  // 5. Unknown / stale utilization → pass through (never coerce a null signal into a veto).
  if (klass === "unknown") {
    return {
      accountUuid: null,
      decision: "unknown-utilization",
      reason: `host-default ${opts.hostDefaultUuid} utilization unknown/stale (status=${snap?.status ?? "none"}) — passing through`,
    };
  }

  // 6. exhausted / refused / deprioritised → the host-default is not an auto-pick.
  //    Prefer any healthy account whose login is not dead (#5460).
  const fallback = selectHealthyAccount(
    opts.candidateUuids,
    opts.readSnapshot,
    {
      now: opts.now,
      freshnessMs,
      excludeUuid: opts.hostDefaultUuid,
      isUnrefreshable: opts.isUnrefreshable,
    }
  );
  if (fallback) {
    return {
      accountUuid: fallback,
      decision: "fallback",
      reason: `host-default ${opts.hostDefaultUuid} is ${klass} (status=${snap?.status}, score=${snap?.score ?? "null"}) — rebinding un-pinned spawn to healthy account ${fallback}`,
    };
  }

  // 7. No healthy account exists. Bind the host-default anyway as a LOUD, logged last
  //    resort — never refuse the spawn (#5460). Each case keeps its own decision so the
  //    spawn-time log says why the host-default was kept.
  if (klass === "deprioritised") {
    return {
      accountUuid: null, // keep the host-default binding
      decision: "degraded-last-resort",
      reason: `host-default ${opts.hostDefaultUuid} is rate-limited and no healthy account is available — binding it as a LAST RESORT (transient; may clear). Pin --account to override.`,
    };
  }
  if (klass === "exhausted") {
    return {
      accountUuid: null, // keep the host-default binding
      decision: "exhausted-last-resort",
      reason: `host-default ${opts.hostDefaultUuid} is at its usage cap (status=${snap?.status}, score=${snap?.score ?? "null"}) and no healthy account is available — binding it anyway; usage never blocks a spawn (#5460). Switch the session's account if it hits the limit.`,
    };
  }
  const refused: "refused" = klass;
  return {
    accountUuid: null, // keep the host-default binding
    decision: "rejected-last-resort",
    reason: `host-default ${opts.hostDefaultUuid} answered the usage probe with 401/403 (status=${snap?.status}, class=${refused}) and no healthy account is available — binding it anyway (#5460): the probe reads the store's advisory token copy, so it can be stale. If the login is really dead the session reports an auth error; re-login or switch its account.`,
  };
}
