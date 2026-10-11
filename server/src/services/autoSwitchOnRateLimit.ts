// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Auto-Switch-On-Rate-Limit Service (#3618)
 *
 * Subscribes to `session-updated` SyncEvents and, on the RISING EDGE of a
 * session-limit 429 (`session.rateLimited.since` null→set) while the session is
 * still ALIVE (`active === true`), migrates the session to the lowest-utilization
 * healthy account via `syncEngine.switchAccount()` — BEFORE the SDK child dies.
 *
 * This is the same event-driven `subscribe`-based pattern as `AutoRecoveryService`
 * (both are HIGHEST-RISK: they act on live sessions), so the policy is deliberately
 * conservative and every decision is logged to the durable `auto-switch-*`
 * error_logs category family:
 *
 *   - Global toggle (read FRESH per decision — instant kill-switch), default OFF (R3/R6)
 *   - Federation: only the OWNING node acts (R4, reuses AutoRecoveryService's R8 predicate)
 *   - Target = lowest-`score` NON-CAPPED account from the CACHED server usage
 *     snapshot (`usageService.getLatest()`), never a hot-path refresh (R2)
 *   - `switchAccount`'s built-in R4 rollback handles a failed migration (R5) —
 *     this service adds NO second rollback
 *   - Storm guard: per-node window cap + single-flight FIFO queue + per-session
 *     cooldown + target spread (R6)
 *   - Never sends a message into the session (R7c) — so it cannot trip
 *     `AutoRecoveryService`'s `errorSeq` watermark; the ladder's re-prompt (on
 *     tmux/pty) is the turn-continuation mechanism after a switch (R7)
 *
 * # The rising-edge detector is a PUBLISHED SEAM (#3618 owns it)
 * `onRisingEdge(sessionId, session)` fires on every `since` null→set edge and
 * `onCleared(sessionId, session)` on every set→null edge — BEFORE and independent
 * of the switch policy. #3612 (reset-time nudge) schedules its timer on the rising
 * edge and cancels it on the cleared edge (a successful switch nulls `rateLimited`
 * via `handleSessionEnd`); #3023 Task 2 (first-turn discriminator) applies its
 * filter on the rising edge. They attach to THIS detector rather than shipping
 * their own.
 *
 * All per-node state is in-memory and resets on restart (acceptable, mirroring
 * AutoRecoveryService).
 */

import {
  HARD_LOCK_UTILIZATION,
  accountProviderOf,
  type AccountUsage,
  type StoredAccount,
  type AnyStoredAccount,
} from "@hapi/protocol";
import type {
  SyncEngine,
  Session,
  SyncEvent,
  AccountValidator,
} from "../sync/syncEngine";
import type { NodeRegistry } from "../federation/nodeRegistry";
import type { ErrorLogger } from "../logging/errorLogger";
import type { AutoSwitchConfig } from "../config/autoSwitchConfig";
import { readAutoSwitchOnRateLimitPreference } from "../web/routes/preferences";

/**
 * The durable `auto-switch-*` category family for the error_logs accounting rows
 * emitted at each switch-decision point (mirrors `auto-recovery-*`). Each point
 * gets a DISTINCT category so the per-category ErrorLogger rate-limit (#1141)
 * bounds a storm per-point and keeps the points independently queryable.
 */
const SWITCH_LOG = {
  success: "auto-switch-success",
  noop: "auto-switch-noop",
  failedRolledBack: "auto-switch-failed-rolled-back",
  failedRollbackFailed: "auto-switch-failed-rollback-failed",
  skipInactive: "auto-switch-skip-inactive",
  skipNotOwner: "auto-switch-skip-not-owner",
  skipDisabled: "auto-switch-skip-disabled",
  skipDedup: "auto-switch-skip-dedup",
  skipStorm: "auto-switch-skip-storm",
  skipNoTarget: "auto-switch-skip-no-target",
  // #3808 (R7): the session's bound account is a non-Anthropic provider record —
  // auto-switch is Anthropic-only, so leave it alone.
  skipNonAnthropic: "auto-switch-skip-non-anthropic",
  // #4568 (R6): the session bills an API key — auto-switch never moves a session
  // onto or off a key (its 429 is the key's own limit, not a subscription cap).
  skipApiKey: "auto-switch-skip-api-key",
  observerError: "auto-switch-observer-error",
  error: "auto-switch-error",
} as const;

/**
 * `switchAccount` error codes reached BEFORE the session was killed (the session
 * is still running; the CLI chip stays up). These are no-ops, NOT migration
 * failures, and do NOT count toward the per-window cap. `at_capacity` is #2299's
 * pre-kill wait-for-slot outcome.
 */
const PRE_KILL_CODES = new Set<string>([
  "session_not_found",
  "not_active",
  "unknown",
  "account_not_found",
  "account_unrefreshable",
  "no_change",
  "at_capacity",
]);

/** Minimal structural view of the shared server UsageService (test seam). */
export interface AutoSwitchUsageSource {
  getLatest(): AccountUsage[] | null;
}

/** Injected dependencies + the published edge-observer seam (#3612 / #3023). */
export interface AutoSwitchOnRateLimitDeps {
  /** The shared server usage cache. R2 reads `getLatest()` ONLY (never a refresh). */
  usageService: AutoSwitchUsageSource;
  /**
   * Lazy getter for the target-account validator (`{ getRaw }`). Lazy because
   * `AccountService` is built alongside `UsageService` in `index.ts`; its
   * `getRaw` reads fresh from disk, so a captured instance is staleness-safe.
   */
  getAccountService: () => AccountValidator | null;
  /**
   * PUBLISHED SEAM — fires on every `rateLimited.since` null→set rising edge,
   * BEFORE the switch policy, for #3612 (reset-time nudge) and #3023 Task 2
   * (first-turn discriminator). Never blocks; a throw is caught + logged.
   */
  onRisingEdge?: (sessionId: string, session: Session | undefined) => void;
  /**
   * PUBLISHED SEAM — fires on every `rateLimited.since` set→null clear (e.g.
   * after a successful switch nulls it via `handleSessionEnd`). #3612 cancels its
   * reset-nudge timer here. Never blocks; a throw is caught + logged.
   */
  onCleared?: (sessionId: string, session: Session | undefined) => void;
  /** Test seam — deterministic clock for cooldown/window math. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Select the switch target: the lowest-`score` NON-CAPPED account from a CACHED
 * usage snapshot (R2). Inline + exported (D11-B) rather than importing the
 * browser-only `selectOptimalAccountUuid`, which admits hard-locked (`score ===
 * 100`) accounts.
 *
 * "Capped" (excluded): `status !== "ok"` (a degraded/rate-limited/expired account
 * carries a null score) · non-finite/absent `score` (the load-bearing null guard —
 * usageService stamps `score: null` for EVERY non-ok status, so a bare `score <
 * threshold` would coerce null to 0 and read maximally-healthy) · `score >= 100` ·
 * either paceable window at/above 100 · the source account (just capped) ·
 * `unrefreshable === true` (the same gate `switchAccount` makes at
 * `accountRestart.ts:202`).
 *
 * Target spread (Task 4): when ≥2 candidates exist, a target chosen within the
 * spread window (passed via `opts.avoidTargets`) is dropped — but only if that
 * still leaves ≥1 candidate. Lowest `score` wins; a stable tie keeps the first in
 * snapshot order. Returns `null` when no candidate qualifies (→ the R6 no-op:
 * chip only, no switch).
 */
export function selectSwitchTarget(
  usage: AccountUsage[],
  sourceAccountUuid: string | undefined,
  getRaw: (accountUuid: string) => StoredAccount | null,
  opts?: { avoidTargets?: Set<string> }
): string | null {
  const candidates = usage.filter(u => {
    if (u.status !== "ok") return false;
    if (typeof u.score !== "number" || !Number.isFinite(u.score)) return false;
    if (u.score >= HARD_LOCK_UTILIZATION) return false;
    const fiveHour = u.utilization.five_hour?.utilization;
    const sevenDay = u.utilization.seven_day?.utilization;
    if (typeof fiveHour === "number" && fiveHour >= HARD_LOCK_UTILIZATION) {
      return false;
    }
    if (typeof sevenDay === "number" && sevenDay >= HARD_LOCK_UTILIZATION) {
      return false;
    }
    if (u.accountUuid === sourceAccountUuid) return false;
    if (getRaw(u.accountUuid)?.unrefreshable === true) return false;
    return true;
  });
  if (candidates.length === 0) return null;

  let pool = candidates;
  const avoid = opts?.avoidTargets;
  if (avoid && avoid.size > 0 && candidates.length >= 2) {
    const spread = candidates.filter(u => !avoid.has(u.accountUuid));
    if (spread.length >= 1) pool = spread;
  }

  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    // `score` is finite here (filtered above); the cast is safe.
    if ((pool[i].score as number) < (best.score as number)) best = pool[i];
  }
  return best.accountUuid;
}

export class AutoSwitchOnRateLimitService {
  private unsubscribe: (() => void) | null = null;

  /** Per-session last-seen `rateLimited.since` (null = not limited). Edge detection. */
  private readonly lastSince = new Map<string, number | null>();
  /** Sessions with a switch currently in flight (de-dup + concurrency accounting). */
  private readonly inFlight = new Set<string>();
  /** Sessions currently waiting in the FIFO queue (O(1) de-dup membership). */
  private readonly queued = new Set<string>();
  /** FIFO of session ids awaiting a concurrency slot. */
  private readonly queue: string[] = [];
  /** Per-session last switch-ATTEMPT time (per-session cooldown). */
  private readonly lastAttemptAt = new Map<string, number>();
  /** Node-wide POST-KILL attempt timestamps (rolling-window cap). */
  private postKillTimestamps: number[] = [];
  /** targetUuid → last-chosen time (target spread). */
  private readonly recentTargetAt = new Map<string, number>();
  /** Guards the single async pump loop. */
  private pumping = false;

  constructor(
    private readonly syncEngine: SyncEngine,
    private readonly registry: NodeRegistry | null,
    private readonly config: AutoSwitchConfig,
    private readonly errorLogger: ErrorLogger,
    /** Settings file path for FRESH readAutoSwitchOnRateLimitPreference() reads (R3/R6). */
    private readonly settingsFile: string,
    private readonly deps: AutoSwitchOnRateLimitDeps
  ) {}

  start(): void {
    if (this.unsubscribe) return; // already started
    this.unsubscribe = this.syncEngine.subscribe(event =>
      this.handleEvent(event)
    );
    console.log(
      `[AutoSwitchOnRateLimit] Starting — window ${this.config.maxSwitchesPerWindow}/` +
        `${this.config.windowMs / 1000}s, maxConcurrent ${this.config.maxConcurrentSwitches}, ` +
        `cooldown ${this.config.perSessionCooldownMs / 1000}s, spread ${this.config.targetSpreadMs / 1000}s`
    );
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.lastSince.clear();
    this.inFlight.clear();
    this.queued.clear();
    this.queue.length = 0;
    this.lastAttemptAt.clear();
    this.postKillTimestamps = [];
    this.recentTargetAt.clear();
    console.log("[AutoSwitchOnRateLimit] Stopped");
  }

  // ---------- Edge detection ----------

  private handleEvent(event: SyncEvent): void {
    if (event.type === "session-removed") {
      if (event.sessionId) this.forgetSession(event.sessionId);
      return;
    }
    if (event.type !== "session-updated") return;
    const id = event.sessionId;
    if (!id) return;

    // The session-updated `data` is typed `unknown`. Runtime-narrow it (mirrors
    // AutoRecoveryService's cast of api-error `data`). ONLY emits that CARRY the
    // `rateLimited` key are edges — an emit that omits it (e.g. the
    // sessionHandlers.ts `{ sid }`-only broadcast) must be ignored, NOT read as a
    // clear (which would fire a spurious onCleared on every unrelated update).
    const data = event.data as
      | { rateLimited?: { since?: unknown } | null }
      | null
      | undefined;
    if (!data || typeof data !== "object" || !("rateLimited" in data)) return;

    const rl = data.rateLimited;
    const next =
      rl && typeof rl === "object" && typeof rl.since === "number"
        ? rl.since
        : null;
    const prev = this.lastSince.get(id) ?? null;
    this.lastSince.set(id, next);

    // Key ONLY on `since` null↔set. A `since` change while already set is NOT an
    // edge (a new 429 episode arrives only after a clear).
    if (prev === null && next !== null) {
      this.handleRisingEdge(id);
    } else if (prev !== null && next === null) {
      this.handleCleared(id);
    }
  }

  private handleRisingEdge(id: string): void {
    const session = this.syncEngine.getSession(id);
    // Published seam FIRST (fires for every rising edge, independent of the switch
    // policy outcome) so #3612 / #3023 always observe the edge.
    this.safeObserve(this.deps.onRisingEdge, id, session);
    // The switch consumer — fully self-contained; errors are contained inside.
    void this.considerSwitch(id, session);
  }

  private handleCleared(id: string): void {
    const session = this.syncEngine.getSession(id);
    this.safeObserve(this.deps.onCleared, id, session);
  }

  private safeObserve(
    fn: ((sessionId: string, session: Session | undefined) => void) | undefined,
    id: string,
    session: Session | undefined
  ): void {
    if (!fn) return;
    try {
      fn(id, session);
    } catch (err) {
      this.errorLogger.warn(
        `auto-switch edge observer threw: ${err instanceof Error ? err.message : String(err)}`,
        { category: SWITCH_LOG.observerError, sessionId: id }
      );
    }
  }

  // ---------- Switch policy (rising-edge consumer) ----------

  private async considerSwitch(
    id: string,
    session: Session | undefined
  ): Promise<void> {
    try {
      // (a) active gate — the whole point of the rising-edge trigger is to act
      // while the session is still alive (switchAccount returns `not_active` once
      // it is not).
      if (!session || session.active !== true) {
        this.info(
          SWITCH_LOG.skipInactive,
          id,
          "rising edge on inactive/absent session"
        );
        return;
      }
      // (b) R4 federation: only the OWNING node acts. findNodeForSession returns
      // null for LOCAL sessions. Defense-in-depth (bridged remote events never
      // reach the publisher) — keep it anyway.
      if (this.registry && this.registry.findNodeForSession(id) !== null) {
        this.info(
          SWITCH_LOG.skipNotOwner,
          id,
          "session is remote-owned; owning node acts"
        );
        return;
      }
      // (c) fresh preference read (R3/R6) — an admin toggle is an instant kill-switch.
      const pref = await readAutoSwitchOnRateLimitPreference(this.settingsFile);
      if (!pref.enabled) {
        this.info(SWITCH_LOG.skipDisabled, id, "auto-switch preference is OFF");
        return;
      }
      // (d) de-dup: already in flight / queued, or within the per-session cooldown
      // (covers the post-switch respawn window).
      const now = this.now();
      const lastAttempt = this.lastAttemptAt.get(id);
      if (
        this.inFlight.has(id) ||
        this.queued.has(id) ||
        (lastAttempt !== undefined &&
          now - lastAttempt < this.config.perSessionCooldownMs)
      ) {
        this.info(
          SWITCH_LOG.skipDedup,
          id,
          "in flight / queued / within cooldown"
        );
        return;
      }
      // Enqueue. The pump serializes execution (maxConcurrentSwitches) and applies
      // the window cap + target spread at the attempt point.
      this.queued.add(id);
      this.queue.push(id);
      void this.pump();
    } catch (err) {
      this.errorLogger.error(
        `auto-switch considerSwitch failed: ${err instanceof Error ? err.message : String(err)}`,
        { category: SWITCH_LOG.error, sessionId: id }
      );
    }
  }

  /**
   * Drain the FIFO queue, honoring `maxConcurrentSwitches`. With the default of 1
   * the `await` makes each switch strictly serial (never >1 in flight, by
   * construction — the Task 4 invariant). A higher config value would still drain
   * serially here (the safe direction — it under-parallelizes, never over-loads).
   */
  private async pump(): Promise<void> {
    if (this.pumping) return; // one drain loop at a time
    this.pumping = true;
    try {
      while (
        this.queue.length > 0 &&
        this.inFlight.size < this.config.maxConcurrentSwitches
      ) {
        const id = this.queue.shift();
        if (id === undefined) break;
        this.queued.delete(id);
        await this.executeSwitch(id);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async executeSwitch(id: string): Promise<void> {
    // Re-validate at the attempt point — time passed while queued, so re-check
    // active, preference, and (spread-aware) target.
    const session = this.syncEngine.getSession(id);
    if (!session || session.active !== true) {
      this.info(
        SWITCH_LOG.skipInactive,
        id,
        "session no longer active at execution"
      );
      return;
    }
    const pref = await readAutoSwitchOnRateLimitPreference(this.settingsFile);
    if (!pref.enabled) {
      this.info(
        SWITCH_LOG.skipDisabled,
        id,
        "preference turned OFF before execution"
      );
      return;
    }

    // Storm window cap (authoritative — at the attempt point). Only POST-KILL
    // attempts count, so prune-then-compare.
    const now = this.now();
    this.prunePostKill(now);
    if (this.postKillTimestamps.length >= this.config.maxSwitchesPerWindow) {
      this.info(
        SWITCH_LOG.skipStorm,
        id,
        `post-kill switch cap ${this.config.maxSwitchesPerWindow}/${this.config.windowMs}ms reached`
      );
      return;
    }

    // #4568 (R6): an API-key session binds no account, so `source` below would be
    // undefined and fall through to a pick — moving a session billed to a key onto
    // a subscription (or vice versa) is never automatic. Leave it alone.
    // (The binding fallback is scoped to anthropic: a codex / gemini / opencode
    // api-key session is already skipped below as non-Anthropic.)
    if (
      session.metadata?.apiKeyId ||
      (session.metadata?.authBinding?.kind === "api-key" &&
        session.metadata.authBinding.providerId === "anthropic")
    ) {
      this.info(
        SWITCH_LOG.skipApiKey,
        id,
        "session bills an API key — auto-switch never moves a session onto or off a key"
      );
      return;
    }
    const source = session.metadata?.accountUuid;
    // #3808 (R7): auto-switch is Anthropic-only — it picks a healthy ANTHROPIC target
    // (the `usage` snapshot is Anthropic-only by construction; usageService filters to
    // provider "anthropic" before classify). If THIS session is bound to a KNOWN
    // non-Anthropic provider record, its rate-limit is not an Anthropic-account problem —
    // leave it alone (the provider-scoped switch signal is #3809's providerUsage[], D5=C).
    // The runtime validator is an AccountService (exposes getRawAny); the declared
    // AccountValidator narrows it to getRaw, so read the wider method defensively. Skip
    // ONLY a resolved provider record — an unresolved source (unknown/deleted account)
    // still falls through, preserving the pre-#3808 recovery behavior.
    if (source) {
      const svc = this.deps.getAccountService() as {
        getRawAny?: (uuid: string) => AnyStoredAccount | null;
      } | null;
      const bound = svc?.getRawAny?.(source) ?? null;
      if (bound && accountProviderOf(bound) !== "anthropic") {
        this.info(
          SWITCH_LOG.skipNonAnthropic,
          id,
          "session bound to a non-Anthropic account — auto-switch is Anthropic-only"
        );
        return;
      }
    }
    const usage = this.deps.usageService.getLatest() ?? [];
    const target = selectSwitchTarget(
      usage,
      source,
      uuid => this.deps.getAccountService()?.getRaw(uuid) ?? null,
      { avoidTargets: this.recentTargets(now) }
    );
    if (target === null) {
      this.info(
        SWITCH_LOG.skipNoTarget,
        id,
        "no healthy non-capped account available"
      );
      return;
    }

    this.inFlight.add(id);
    this.lastAttemptAt.set(id, now);
    try {
      // Pass NO abort signal until #2299's optional param lands. switchAccount's
      // built-in R4 rollback handles a failed migration (R5) — no second rollback.
      const result = await this.syncEngine.switchAccount(id, target);
      this.classifyResult(id, source, target, result);
    } catch (err) {
      this.errorLogger.error(
        `auto-switch switchAccount threw: ${err instanceof Error ? err.message : String(err)}`,
        { category: SWITCH_LOG.error, sessionId: id, context: { target } }
      );
    } finally {
      this.inFlight.delete(id);
    }
  }

  private classifyResult(
    id: string,
    source: string | undefined,
    target: string,
    result: Awaited<ReturnType<SyncEngine["switchAccount"]>>
  ): void {
    const now = this.now();
    if (result.type === "success") {
      this.postKillTimestamps.push(now);
      this.recentTargetAt.set(target, now);
      this.errorLogger.info(
        `auto-switch success: ${source ?? "?"} → ${target} (newSessionId=${result.newSessionId})`,
        {
          category: SWITCH_LOG.success,
          sessionId: id,
          context: {
            source,
            target,
            newSessionId: result.newSessionId,
            accountEmail: result.accountEmail,
          },
        }
      );
      return;
    }

    const code = result.code ?? "unknown";
    if (code === "switch_failed_rolled_back") {
      // Killed, then rolled back to the original account (R5). Count toward the
      // cap; no retry.
      this.postKillTimestamps.push(now);
      this.errorLogger.warn(
        `auto-switch failed and rolled back to the original account (${result.message})`,
        {
          category: SWITCH_LOG.failedRolledBack,
          sessionId: id,
          context: { source, target, code },
        }
      );
      return;
    }
    if (code === "switch_failed_rollback_failed") {
      // Killed, rollback ALSO failed. R5 honesty: the session is DISCONNECTED but
      // reconnectable — "never left dead" is NOT guaranteeable at this edge by
      // existing switchAccount code. Surface at ERROR. Count toward the cap; no retry.
      this.postKillTimestamps.push(now);
      this.errorLogger.error(
        `auto-switch failed AND rollback failed — session ${id} is disconnected but ` +
          `reconnectable; liveness is NOT guaranteed at this edge (${result.message})`,
        {
          category: SWITCH_LOG.failedRollbackFailed,
          sessionId: id,
          context: { source, target, code },
        }
      );
      return;
    }

    // Pre-kill no-op (incl. #2299 `at_capacity`) OR an unrecognized error code:
    // the session was never killed; the CLI chip stays up. NOT a migration
    // failure, NOT counted toward the cap, NOT retried.
    this.errorLogger.info(
      `auto-switch no-op (code=${code}): ${result.message}`,
      {
        category: SWITCH_LOG.noop,
        sessionId: id,
        context: { source, target, code, preKill: PRE_KILL_CODES.has(code) },
      }
    );
  }

  // ---------- Helpers ----------

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private prunePostKill(now: number): void {
    const cutoff = now - this.config.windowMs;
    this.postKillTimestamps = this.postKillTimestamps.filter(t => t > cutoff);
  }

  /** Targets chosen within `targetSpreadMs` (pruned). Used to spread consecutive switches. */
  private recentTargets(now: number): Set<string> {
    const out = new Set<string>();
    for (const [uuid, at] of this.recentTargetAt) {
      if (now - at < this.config.targetSpreadMs) out.add(uuid);
      else this.recentTargetAt.delete(uuid);
    }
    return out;
  }

  private forgetSession(id: string): void {
    this.lastSince.delete(id);
    this.lastAttemptAt.delete(id);
    this.queued.delete(id);
    const qi = this.queue.indexOf(id);
    if (qi >= 0) this.queue.splice(qi, 1);
    // `inFlight` is intentionally NOT cleared here: a switch mid-flight runs to
    // completion (its `finally` removes it). A session-removed for an in-flight id
    // is unusual but harmless.
  }

  private info(
    category: string,
    sessionId: string,
    message: string,
    context?: Record<string, unknown>
  ): void {
    this.errorLogger.info(`[auto-switch] ${message}`, {
      category,
      sessionId,
      context,
    });
  }
}
