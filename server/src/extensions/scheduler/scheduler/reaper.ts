// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SessionReaper — cooperative completion + one-shot cleanup (#2701, epic #2698)
 *
 * Owns the reaper passes that act on a session's own completion signal:
 *   - `completeExecution`     — the completion endpoint's logic (authz + mark)
 *   - `reapCompleted`         — archive sessions whose execution is `completed`
 *   - `sweepConsumedOneShots` — delete a spent one-shot once it holds no session
 *   - `onSessionEvent`        — fast path: reap a signaled session the moment
 *                               its turn ends, instead of on the next pass;
 *                               also feeds the L2 idle tracker (#2702)
 *   - `reapIdle`              — L2 backstop: archive a scheduler session that
 *                               stayed continuously idle past the threshold
 *                               without ever signaling completion (#2702);
 *                               under sustained cap pressure it uses a
 *                               shorter threshold for local-machine sessions
 *                               and records `reap_reason = 'pressure'` (#2703)
 *   - `archiveForReap`        — the ONE archive step every pass uses (#2703)
 *
 * Dependencies are injected so every pass is unit-testable with an in-memory
 * store and a fake session map (the scheduler's own service is not). Later
 * layers — #2702 (idle, `reapIdle`) and #2703 (pressure) — add passes here
 * and reuse the same predicates, write rules, and archive action.
 *
 * Status write rules (epic F5): no pass overwrites `completed`; `reaped_at` is
 * written once; the endpoint never overwrites a terminal status.
 */

import type { Session } from "@hapi/protocol/types";
import type { ErrorLogger } from "../../../logging/errorLogger";
import type { ScheduleChangeKind } from "../../../sync/syncEngine";
import type { SchedulerStore } from "../store/schedulerStore";
import { isPressureOnMachine, type PressureReading } from "./capPressure";
import { isSafeToReap, isSchedulerScopedSession } from "./reaperPredicates";
import type { CompletedExecution, ReapReason, TaskExecution } from "./types";
import {
  COMPLETED_REAP_GRACE_MS,
  SCHEDULER_IDLE_REAP_THRESHOLD_MS,
  SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS,
} from "./types";

/** Options for one idle pass (#2703). */
export type ReapIdleOptions = {
  /** This tick's cap-pressure reading (local node). */
  pressure?: PressureReading;
  /**
   * True once pressure has held for the service's hysteresis window. Only then
   * does the pass use the shorter pressure threshold.
   */
  accelerate?: boolean;
};

export type SessionReaperDeps = {
  store: SchedulerStore;
  getSession: (sessionId: string) => Session | undefined;
  /** The terminal reap action — `archiveSession(id, { reapRemoteWindow: true })`. */
  archiveSession: (sessionId: string) => Promise<unknown>;
  /**
   * The #2700 `schedule-changed` notification (fail-soft in the service). The
   * sweep's deferred one-shot delete must emit `deleted`, or the web schedule
   * list keeps showing the consumed task until an unrelated refetch.
   */
  emitScheduleChanged: (
    task: { id: string; namespace: string },
    changeKind: ScheduleChangeKind
  ) => void;
  errorLogger?: ErrorLogger | null;
  now?: () => number;
  /** L2 continuous-idle threshold; defaults to SCHEDULER_IDLE_REAP_THRESHOLD_MS. */
  idleThresholdMs?: number;
  /**
   * L4 (#2703) threshold used under sustained cap pressure; defaults to
   * SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS. Not below idleThresholdMs ⇒
   * accelerated reaping is disabled.
   */
  pressureIdleThresholdMs?: number;
};

export type CompleteExecutionResult =
  | { kind: "ok"; execution: TaskExecution }
  | { kind: "already"; execution: TaskExecution }
  | { kind: "not_found" }
  | { kind: "forbidden"; reason: string }
  | { kind: "conflict"; reason: string };

export class SessionReaper {
  private readonly store: SchedulerStore;
  private readonly getSession: SessionReaperDeps["getSession"];
  private readonly archiveSession: SessionReaperDeps["archiveSession"];
  private readonly emitScheduleChanged: SessionReaperDeps["emitScheduleChanged"];
  private readonly errorLogger: ErrorLogger | null;
  private readonly now: () => number;
  private readonly idleThresholdMs: number;
  private readonly pressureIdleThresholdMs: number;
  /** False when the pressure threshold is not below the steady one (#2703). */
  private readonly accelerationEnabled: boolean;

  /** Sessions with a `completed`, unreaped execution — the fast-path filter. */
  private readonly pendingCompletion = new Set<string>();
  /** Sessions a pass is reaping right now — prevents a double archive. */
  private readonly inFlight = new Set<string>();
  /**
   * L2 (#2702): scheduler session id → when it last BECAME safe to reap. An
   * entry is dropped the moment the session is seen unsafe (thinking, blocked,
   * rate-limited, inactive), so its age is CONTINUOUS idle — a single
   * between-turns idle transition restarts the clock instead of counting.
   * In-memory only: after a restart the pass re-seeds it at `now`, so a
   * long-idle session waits one full threshold again (maxRuntimeMs still
   * bounds it).
   */
  private readonly idleSince = new Map<string, number>();
  /** Out-of-scope sessions already warned about, so the warning is not per-pass. */
  private readonly warnedOutOfScope = new Set<string>();

  constructor(deps: SessionReaperDeps) {
    this.store = deps.store;
    this.getSession = deps.getSession;
    this.archiveSession = deps.archiveSession;
    this.emitScheduleChanged = deps.emitScheduleChanged;
    this.errorLogger = deps.errorLogger ?? null;
    this.now = deps.now ?? Date.now;
    this.idleThresholdMs =
      deps.idleThresholdMs ?? SCHEDULER_IDLE_REAP_THRESHOLD_MS;
    this.pressureIdleThresholdMs =
      deps.pressureIdleThresholdMs ?? SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS;
    this.accelerationEnabled =
      this.pressureIdleThresholdMs < this.idleThresholdMs;
    if (!this.accelerationEnabled) {
      this.errorLogger?.warn(
        `[Reaper] Pressure idle threshold (${Math.round(this.pressureIdleThresholdMs / 60_000)}min) is not below the steady threshold (${Math.round(this.idleThresholdMs / 60_000)}min) — accelerated reap under cap pressure is disabled`,
        { category: "scheduler" }
      );
    }
  }

  /**
   * The ONE terminal archive step every reaper pass uses (#2703 R9): archive
   * the session; on failure warn and return false so the caller leaves the row
   * for the next pass rather than marking it reaped. Never throws.
   */
  async archiveForReap(
    sessionId: string,
    what: string,
    taskName: string
  ): Promise<boolean> {
    try {
      await this.archiveSession(sessionId);
      return true;
    } catch (err) {
      this.errorLogger?.warn(
        `[Reaper] Failed to archive ${what} session ${sessionId} for task "${taskName}"`,
        {
          category: "scheduler",
          context: {
            error: err instanceof Error ? err.message : String(err),
          },
        }
      );
      return false;
    }
  }

  // ── Completion endpoint ─────────────────────────────────────────────

  /**
   * Mark an execution completed on behalf of its own session.
   *
   * Authorization: the execution's task must live in the caller's JWT
   * namespace (else `not_found`, so a foreign namespace cannot probe for ids).
   * That namespace check is the security boundary. The session-tag match is a
   * correctness guard against a mis-addressed execution id — `HAPI_SESSION_ID`
   * is the session TAG, not its server id (review finding 2701-5).
   *
   * Never archives inline: the caller is mid-turn when it calls this. The
   * session is reaped by `reapCompleted` / the event fast path once safe.
   */
  completeExecution(
    executionId: string,
    namespace: string,
    sessionTag: string | undefined
  ): CompleteExecutionResult {
    const found = this.store.getExecutionWithTask(executionId);
    if (!found || found.taskNamespace !== namespace) {
      return { kind: "not_found" };
    }
    const { execution } = found;
    if (found.heartbeatMode) {
      return {
        kind: "conflict",
        reason: "Heartbeat executions do not take a completion signal",
      };
    }
    if (execution.status === "completed") {
      return { kind: "already", execution };
    }
    if (execution.status !== "running" && execution.status !== "delivered") {
      return {
        kind: "conflict",
        reason: `Execution is already ${execution.status}`,
      };
    }
    if (!execution.sessionId) {
      return { kind: "conflict", reason: "Execution has no session yet" };
    }
    const session = this.getSession(execution.sessionId);
    if (!sessionTag || !session?.tag || session.tag !== sessionTag) {
      return {
        kind: "forbidden",
        reason: "Session tag does not match this execution's session",
      };
    }

    const nowMs = this.now();
    if (!this.store.completeExecution(executionId, nowMs)) {
      // Lost a race with a concurrent status write — report what is there now.
      const current = this.store.getExecutionWithTask(executionId)?.execution;
      if (current?.status === "completed") {
        return { kind: "already", execution: current };
      }
      return {
        kind: "conflict",
        reason: `Execution is already ${current?.status ?? "gone"}`,
      };
    }
    this.pendingCompletion.add(execution.sessionId);
    this.errorLogger?.info(
      `[Reaper] Execution ${executionId} for task "${found.taskName}" signaled completion`,
      { category: "scheduler" }
    );
    return {
      kind: "ok",
      execution: { ...execution, status: "completed", completedAt: nowMs },
    };
  }

  // ── Completed-reap pass ─────────────────────────────────────────────

  /**
   * Reap every `completed`, unreaped execution's session that is safe to reap
   * (or has been unsafe past the grace bound). Also rebuilds the fast-path
   * set from the store, so it survives a server restart.
   */
  async reapCompleted(nowMs: number): Promise<void> {
    const pending = this.store.getCompletedUnreapedExecutions();
    this.pendingCompletion.clear();
    for (const entry of pending) this.pendingCompletion.add(entry.sessionId);
    for (const entry of pending) await this.reapOne(entry, nowMs);
  }

  /**
   * A session changed state (or was removed). Updates the L2 idle tracker,
   * then takes the completion fast path: reap it now if it signaled done.
   */
  async onSessionEvent(sessionId: string): Promise<void> {
    try {
      const nowMs = this.now();
      this.trackIdle(sessionId, nowMs);
      if (!this.pendingCompletion.has(sessionId)) return;
      for (const entry of this.store.getCompletedUnreapedExecutions(
        sessionId
      )) {
        await this.reapOne(entry, nowMs);
      }
    } catch (err) {
      this.errorLogger?.warn(
        `[Reaper] Session event handling failed for session ${sessionId}`,
        {
          category: "scheduler",
          context: { error: err instanceof Error ? err.message : String(err) },
        }
      );
    }
  }

  private async reapOne(
    entry: CompletedExecution,
    nowMs: number
  ): Promise<void> {
    if (this.inFlight.has(entry.sessionId)) return;
    this.inFlight.add(entry.sessionId);
    try {
      const session = this.getSession(entry.sessionId);

      // Already gone (e.g. it self-archived after signaling): the slot is
      // free. The work was declared done, so the row STAYS `completed`.
      if (!session?.active) {
        this.settle(entry, "completed", nowMs);
        return;
      }

      // Never archive a session outside the scheduler's scope, whatever the
      // execution row claims (epic F6).
      if (!isSchedulerScopedSession(session)) {
        this.errorLogger?.warn(
          `[Reaper] Session ${entry.sessionId} for task "${entry.taskName}" is not scheduler-scoped — marking reaped without archiving`,
          { category: "scheduler" }
        );
        this.settle(entry, "completed", nowMs);
        return;
      }

      let reason: "completed" | "completed_grace";
      if (isSafeToReap(session)) {
        reason = "completed";
      } else if (nowMs - entry.completedAt > COMPLETED_REAP_GRACE_MS) {
        // Still busy, blocked, or rate-limited long after declaring done —
        // stuck. Bound it rather than let it hold the slot forever (2701-2).
        reason = "completed_grace";
      } else {
        return; // mid-turn: defer to the next pass / next state change
      }

      if (
        !(await this.archiveForReap(
          entry.sessionId,
          "completed",
          entry.taskName
        ))
      ) {
        return; // leave it for the next pass rather than marking it reaped
      }

      const minutes = Math.round((nowMs - entry.completedAt) / 60_000);
      this.settle(
        entry,
        reason,
        nowMs,
        reason === "completed_grace"
          ? `Force-reaped: still busy ${minutes}min after its completion signal`
          : undefined
      );
      this.errorLogger?.info(
        `[Reaper] Archived completed session ${entry.sessionId} for task "${entry.taskName}" (${reason})`,
        { category: "scheduler" }
      );
    } finally {
      this.inFlight.delete(entry.sessionId);
    }
  }

  private settle(
    entry: CompletedExecution,
    reason: "completed" | "completed_grace",
    nowMs: number,
    errorMessage?: string
  ): void {
    this.store.markExecutionReaped(
      entry.executionId,
      reason,
      nowMs,
      errorMessage === undefined ? {} : { errorMessage }
    );
    this.pendingCompletion.delete(entry.sessionId);
  }

  // ── L2 idle reap (#2702) ────────────────────────────────────────────

  /**
   * Record the session's current idle state. Resolved via `getSession`, never
   * the event payload (partial — review finding 2702-3). Only scheduler-scoped
   * sessions are tracked; anything else (heartbeat, PM, interactive, removed)
   * is dropped from the map.
   */
  private trackIdle(sessionId: string, nowMs: number): void {
    const session = this.getSession(sessionId);
    if (!isSchedulerScopedSession(session) || !isSafeToReap(session)) {
      this.idleSince.delete(sessionId);
      return;
    }
    if (!this.idleSince.has(sessionId)) this.idleSince.set(sessionId, nowMs);
  }

  /**
   * Reap scheduler sessions that stayed continuously idle past the threshold
   * without a completion signal. Candidates are live, unreaped `running` /
   * `delivered` executions of NON-heartbeat tasks — a `completed` row belongs
   * to `reapCompleted` and is never touched here. Also samples every
   * candidate's state, so a missed event cannot strand the tracker.
   *
   * L4 (#2703): under sustained cap pressure (`opts.accelerate`) the SAME pass
   * uses the shorter pressure threshold for sessions on the LOCAL machine. It
   * adds no candidate source and no new pass — the scope guard, idle tracker,
   * and conditional write are unchanged, so only an idle scheduler session can
   * ever be reached.
   */
  async reapIdle(nowMs: number, opts: ReapIdleOptions = {}): Promise<void> {
    const candidates = new Map<string, TaskExecution>();
    for (const exec of this.store.getActiveExecutions({
      excludeHeartbeat: true,
    })) {
      if (!exec.sessionId || exec.status === "completed") continue;
      candidates.set(exec.sessionId, exec);
    }

    // Drop tracker state for sessions that no longer hold a live execution.
    for (const sessionId of this.idleSince.keys()) {
      if (!candidates.has(sessionId)) this.idleSince.delete(sessionId);
    }
    for (const sessionId of this.warnedOutOfScope) {
      if (!candidates.has(sessionId)) this.warnedOutOfScope.delete(sessionId);
    }

    for (const [sessionId, exec] of candidates) {
      await this.reapIdleOne(sessionId, exec.id, nowMs, opts);
    }
  }

  private async reapIdleOne(
    sessionId: string,
    executionId: string,
    nowMs: number,
    opts: ReapIdleOptions
  ): Promise<void> {
    if (this.inFlight.has(sessionId) || this.pendingCompletion.has(sessionId)) {
      return; // being reaped, or signaled done: #2701's path owns it
    }
    const session = this.getSession(sessionId);

    // Hard scope guard (epic F6): heartbeat rows are filtered by the query, so
    // anything else here is a mis-joined or unlabeled session. Never archive
    // it, never mark its row — warn once and leave it to the ceiling reaper.
    if (session && !isSchedulerScopedSession(session)) {
      this.idleSince.delete(sessionId);
      if (!this.warnedOutOfScope.has(sessionId)) {
        this.warnedOutOfScope.add(sessionId);
        this.errorLogger?.warn(
          `[Reaper] Idle pass skipped session ${sessionId} (execution ${executionId}): not scheduler-scoped (source: ${session.metadata?.source ?? "none"})`,
          { category: "scheduler" }
        );
      }
      return;
    }

    // Busy, blocked, rate-limited, gone, or disconnected (it may reconnect):
    // not idle. The clock restarts when it is next seen safe.
    this.trackIdle(sessionId, nowMs);
    const since = this.idleSince.get(sessionId);
    if (since === undefined) return;

    // L4 (#2703): the shorter threshold applies only under sustained pressure
    // on THIS node, to a session running on this node.
    const accelerated =
      this.accelerationEnabled &&
      opts.accelerate === true &&
      isPressureOnMachine(opts.pressure, session?.metadata?.machineId);
    const threshold = accelerated
      ? this.pressureIdleThresholdMs
      : this.idleThresholdMs;
    const idleMs = nowMs - since;
    if (idleMs < threshold) return;
    // 'pressure' only when the shorter threshold made the difference.
    const reason: ReapReason =
      accelerated && idleMs < this.idleThresholdMs ? "pressure" : "idle";

    // Re-read the row: it may have changed since the candidate query.
    const found = this.store.getExecutionWithTask(executionId);
    const status = found?.execution.status;
    if (
      !found ||
      found.execution.reapedAt != null ||
      (status !== "running" && status !== "delivered")
    ) {
      return;
    }

    this.inFlight.add(sessionId);
    try {
      if (!(await this.archiveForReap(sessionId, reason, found.taskName))) {
        return; // leave it for the next pass rather than marking it reaped
      }

      const minutes = Math.round(idleMs / 60_000);
      const pressure =
        reason === "pressure" && opts.pressure?.available
          ? opts.pressure
          : null;
      const errorMessage = pressure
        ? `Pressure-reaped — idle ${minutes}min under cap pressure (${pressure.effectiveCount}/${pressure.maxConcurrent} live, floor ${pressure.floor}) and no completion signal`
        : `Idle-reaped — no activity for ${minutes}min and no completion signal`;
      // Conditional on the status the pass saw: a completion signal that
      // landed during the archive keeps its `completed` row (epic F5).
      const marked = this.store.markExecutionReaped(
        executionId,
        reason,
        nowMs,
        {
          status: "timed_out",
          errorMessage,
          onlyFromStatuses: ["running", "delivered"],
        }
      );
      this.idleSince.delete(sessionId);
      const summary = `[Reaper] Archived ${reason === "pressure" ? "idle session under cap pressure" : "idle session"} ${sessionId} for task "${found.taskName}" — idle ${minutes}min (threshold ${Math.round(threshold / 60_000)}min)${marked ? "" : "; execution row changed meanwhile, left as is"}`;
      if (reason === "pressure") {
        // Loud (R4): a pressure reap is the L4 layer acting on a live session.
        this.errorLogger?.warn(summary, { category: "scheduler" });
      } else {
        this.errorLogger?.info(summary, { category: "scheduler" });
      }
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  // ── Consumed one-shot sweep ─────────────────────────────────────────

  /**
   * Delete one-shots that were consumed at spawn and no longer hold a
   * session. First settles any of their executions whose session has already
   * ended, so a one-shot is never kept forever by a dead session.
   */
  sweepConsumedOneShots(nowMs: number): void {
    for (const exec of this.store.getUnreapedConsumedOneShotExecutions()) {
      if (this.getSession(exec.sessionId)?.active) continue;
      if (exec.status === "completed") {
        this.store.markExecutionReaped(exec.executionId, "completed", nowMs);
      } else {
        this.store.markExecutionReaped(exec.executionId, "inactive", nowMs, {
          status: "timed_out",
          errorMessage: "Session ended without a completion signal",
        });
      }
      this.pendingCompletion.delete(exec.sessionId);
    }

    for (const task of this.store.getConsumedOneShotTasks()) {
      if (!this.store.deleteTask(task.taskId, task.namespace)) continue;
      this.emitScheduleChanged(
        { id: task.taskId, namespace: task.namespace },
        "deleted"
      );
      console.log(`[Scheduler] Auto-deleted consumed one-shot "${task.name}"`);
    }
  }
}
