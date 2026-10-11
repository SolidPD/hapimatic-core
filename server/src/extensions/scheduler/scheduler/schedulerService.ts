// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scheduler Service — Core Lifecycle
 *
 * Orchestrates the scheduled task execution engine:
 *   start → tick loop → evaluate due tasks → execute via TaskExecutor →
 *   update next execution → handle errors/backoff → repeat
 *
 * Uses setTimeout-based timer (not setInterval) for drift-free scheduling
 * and to prevent overlapping ticks. This pattern is validated by both the
 * HeartbeatService in this codebase and Open Claw's production scheduler.
 *
 * croner is used ONLY as a "next run" calculator — no croner callbacks.
 */

import type {
  ScheduleChangeKind,
  SyncEngine,
  SyncEvent,
} from "../../../sync/syncEngine";
import type { PushService } from "../../../push/pushService";
import type { NotificationHub } from "../../../notifications/notificationHub";
import type { SystemEventQueue } from "../../../heartbeat/systemEvents";
import type { SchedulerStore } from "../store/schedulerStore";
import type { RpcRegistry } from "../../../socket/rpcRegistry";
import type { ErrorLogger } from "../../../logging/errorLogger";
import { configuration } from "../../../configuration";
import {
  isCapPressureSkip,
  TaskExecutor,
  type ExecutionResult,
} from "./taskExecutor";
import { SessionReaper, type CompleteExecutionResult } from "./reaper";
import {
  createTickPressureReader,
  defaultPressureDeps,
  type PressureDeps,
} from "./capPressure";
import { migrateHeartbeatConfig } from "./heartbeatIntegration";
import { calculateNextWithLayers } from "./temporalFilter";
import type {
  CreateScheduledTask,
  ScheduledTask,
  TaskExecution,
  UpdateScheduledTask,
} from "./types";
import {
  BACKOFF_DELAYS_MS,
  MISSED_TASK_GRACE_MS,
  ONESHOT_DEFER_WINDOW_MS,
  REAPER_TICK_INTERVAL,
  SCHEDULER_BOOT_LIVENESS_GRACE_MS,
  STUCK_RUN_TIMEOUT_MS,
  TICK_INTERVAL_MS,
} from "./types";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";

/** #3172: what a user-initiated schedule delete does with its spawned sessions. */
export type ScheduleChildDisposition = "cascade" | "orphan";

export type DeleteTaskChildrenResult = {
  disposition: ScheduleChildDisposition;
  /** Children deleted (cascade) or dissolved to top-level (orphan). */
  affected: string[];
  /** Children the disposition could not apply to (cascade failures are dissolved). */
  failed: Array<{ sessionId: string; error: string }>;
};

const LAUNCH_TASK_TIMEOUT_MS = 60_000;
/**
 * How soon after createdAt a task's first execution must be written to count
 * as its run_once_at_creation attempt (#4033): fireOnCreation fires at once or
 * within LAUNCH_TASK_TIMEOUT_MS, plus one tick of slack.
 */
const CREATION_RUN_ATTEMPT_WINDOW_MS =
  LAUNCH_TASK_TIMEOUT_MS + TICK_INTERVAL_MS;
/**
 * Consecutive pressured reaper passes required before the idle pass uses the
 * shorter pressure threshold (#2703 R8 hysteresis): 2 passes ≈ 60 s, so one
 * transient spike never shortens anyone's idle budget.
 */
const CAP_PRESSURE_REAP_MIN_STREAK = 2;

export class SchedulerService {
  private readonly store: SchedulerStore;
  private readonly syncEngine: SyncEngine;
  private readonly rpcRegistry: RpcRegistry | null;
  private readonly executor: TaskExecutor;
  private readonly loop: SupervisedLoop;
  private readonly reaper: SessionReaper;
  private unsubscribeSyncEvents: (() => void) | null = null;
  private running = false;
  private tickCount = 0;
  /** Consecutive reaper passes that read the local node under pressure (#2703). */
  private pressureStreak = 0;
  /** Source of each tick's pressure reading; swapped by tests (#2703). */
  private pressureDepsFactory: () => PressureDeps = defaultPressureDeps;
  /** When start() ran; anchors SCHEDULER_BOOT_LIVENESS_GRACE_MS (#4111). */
  private startedAtMs = 0;
  /**
   * Stuck executions startup recovery left for the reapers (#4111): settled
   * once, after the boot grace, if their session never came back.
   */
  private readonly deferredRecovery = new Set<string>();

  constructor(
    store: SchedulerStore,
    syncEngine: SyncEngine,
    pushService: PushService,
    notificationHub?: NotificationHub,
    systemEventQueue?: SystemEventQueue,
    private readonly errorLogger?: ErrorLogger | null,
    rpcRegistry?: RpcRegistry | null,
    jobOpts?: { node?: string; jobRegistry?: JobRegistry | null }
  ) {
    this.store = store;
    this.syncEngine = syncEngine;
    this.rpcRegistry = rpcRegistry ?? null;
    this.executor = new TaskExecutor(
      syncEngine,
      store,
      pushService,
      notificationHub,
      systemEventQueue,
      errorLogger
    );
    // #2701: the reap action stays the terminal archive (#1603 reap window B).
    this.reaper = new SessionReaper({
      store,
      getSession: id => syncEngine.getSession(id),
      archiveSession: id =>
        syncEngine.archiveSession(id, { reapRemoteWindow: true }),
      emitScheduleChanged: (task, changeKind) =>
        this.emitScheduleChanged(task, changeKind),
      errorLogger,
    });
    // #1963: supervised-loop wrapper owns tick scheduling (finally-reschedule
    // + stall watchdog + job-registry registration). tick() remains the work.
    this.loop = new SupervisedLoop({
      name: "scheduler",
      node: jobOpts?.node ?? "standalone",
      intervalMs: TICK_INTERVAL_MS,
      immediate: false, // first tick after one interval (preserves prior cadence)
      registry: jobOpts?.jobRegistry ?? undefined,
      tick: () => this.runSchedulerTick(),
    });
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    console.log(
      `[Scheduler] Starting with ${TICK_INTERVAL_MS / 1000}s tick interval`
    );

    // Auto-migrate heartbeat config from settings.json to DB
    await this.migrateHeartbeatIfNeeded();

    // Recover stuck executions from previous run
    this.startedAtMs = Date.now();
    this.recoverStuckExecutions();

    // Catch up missed one-shot tasks
    await this.catchUpMissedTasks();

    // Calculate next execution times for all enabled tasks
    this.recalculateAllNextExecutions();

    // THE persistent scheduler subscription (#2701, epic #2698). Reaper layers
    // that react to session state changes attach here — #2702's idle tracker
    // included — never to the self-unsubscribing fireOnCreation subscription.
    this.unsubscribeSyncEvents = this.syncEngine.subscribe(event =>
      this.onSyncEvent(event)
    );

    // Start the supervised tick loop (#1963).
    this.loop.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.loop.stop();
    this.unsubscribeSyncEvents?.();
    this.unsubscribeSyncEvents = null;
    this.deferredRecovery.clear();
    console.log("[Scheduler] Stopped");
  }

  /**
   * Dispatch for the persistent subscription: feeds the #2701 completion fast
   * path and the #2702 idle tracker. Session state is resolved by the
   * consumer via `getSession`, never read off the (partial) event data.
   * Must never throw into the event publisher.
   */
  private onSyncEvent(event: SyncEvent): void {
    if (event.type !== "session-updated" && event.type !== "session-removed") {
      return;
    }
    const sessionId = event.sessionId;
    if (!sessionId) return;
    void this.reaper.onSessionEvent(sessionId);
  }

  // ── Run-once-at-creation ──────────────────────────────────────────

  /**
   * Fire a task immediately after creation. Waits for the daemon's
   * spawn-happy-session RPC handler if it hasn't registered yet
   * (race between scheduler service and daemon startup).
   */
  private fireOnCreation(task: ScheduledTask): void {
    // Daemon already connected — fire immediately
    if (this.rpcRegistry?.hasAnyHandlerMatching(":spawn-happy-session")) {
      console.log(
        `[Scheduler] Daemon available — firing run_once_at_creation task "${task.name}" immediately`
      );
      void this.executeAndRecord(task);
      return;
    }

    // Wait for daemon to connect
    console.log(
      `[Scheduler] Deferring run_once_at_creation task "${task.name}" until daemon connects`
    );

    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsub?.();
      console.warn(
        `[Scheduler] No daemon connected within ${LAUNCH_TASK_TIMEOUT_MS / 1000}s — ` +
          `run_once_at_creation task "${task.name}" will not fire`
      );
    }, LAUNCH_TASK_TIMEOUT_MS);

    unsub = this.syncEngine.subscribe((event: SyncEvent) => {
      if (event.type !== "machine-updated") return;
      if (!this.rpcRegistry?.hasAnyHandlerMatching(":spawn-happy-session")) {
        return;
      }
      clearTimeout(timer);
      unsub?.();
      console.log(
        `[Scheduler] Daemon connected — firing run_once_at_creation task "${task.name}"`
      );
      void this.executeAndRecord(task);
    });
  }

  /**
   * #2700: notify browsers (and federation peers) that a task was created,
   * deleted, or executed, so the web's schedules + sessions queries refetch live
   * and an orphaned scheduler-spawned session re-homes into the main list.
   * Fail-soft: a notification failure must never break scheduling itself.
   */
  private emitScheduleChanged(
    task: Pick<ScheduledTask, "id" | "namespace">,
    changeKind: ScheduleChangeKind
  ): void {
    try {
      this.syncEngine.emitScheduleChanged({
        namespace: task.namespace,
        scheduleId: task.id,
        changeKind,
      });
    } catch (error) {
      // Logged to error_logs (not just the console): a persistently failing emit
      // would otherwise stop live refreshes invisibly — the very symptom #2700 fixes.
      if (this.errorLogger) {
        this.errorLogger.error("[Scheduler] schedule-changed emit failed", {
          category: "scheduler-emit",
          stack: error instanceof Error ? error.stack : null,
          context: { scheduleId: task.id, changeKind },
        });
      } else {
        console.error("[Scheduler] schedule-changed emit failed:", error);
      }
    }
  }

  private async executeAndRecord(task: ScheduledTask): Promise<void> {
    const result = await this.executor.execute(task);
    this.emitScheduleChanged(task, "executed");
    if (result.success) {
      this.store.updateLastExecuted(task.id, Date.now());
      if (task.eventCountLimit !== null) {
        this.store.updateEventCount(task.id, task.eventCountCurrent + 1);
      }
    }
    const freshTask = this.store.getTask(task.id, task.namespace);
    if (!freshTask) return;
    // #4033: a skipped creation run is re-armed (or dropped) instead of being
    // recomputed away by updateNextExecution.
    if (!result.success && result.execution.status === "skipped") {
      const outcome = this.handleSkippedRun(freshTask, result, Date.now());
      if (this.isSkipResolved(outcome, freshTask)) return;
    }
    this.updateNextExecution(freshTask);
  }

  // ── Tick loop ──────────────────────────────────────────────────────

  /**
   * One supervised tick: run tick(), log any error (preserving the prior
   * "[Scheduler] Tick error" log), then rethrow so the SupervisedLoop records
   * lastError + re-arms. Overlap is prevented structurally by the loop
   * (reschedule-after-completion), so the old tickInProgress guard is gone.
   */
  private async runSchedulerTick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.tick();
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.error("[Scheduler] Tick error", {
          category: "scheduler-tick",
          stack: error instanceof Error ? error.stack : null,
          context: { tickCount: this.tickCount },
        });
      } else {
        console.error("[Scheduler] Tick error:", error);
      }
      throw error;
    }
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    this.tickCount++;
    // #2703: ONE lazily-read cap-pressure reading shared by the whole tick —
    // at most one /effective-count POST, and every decision sees the same view.
    const pressure = createTickPressureReader(this.pressureDepsFactory());

    // ── Periodic session reaper ──────────────────────────────────────
    if (this.tickCount % REAPER_TICK_INTERVAL === 0) {
      this.settleDeferredRecovery(now); // #4111: once, after the boot grace
      await this.reapStaleSessions(now);
      await this.reaper.reapCompleted(now); // #2701: cooperative completion
      const reading = await pressure();
      this.pressureStreak =
        reading.available && reading.underPressure
          ? this.pressureStreak + 1
          : 0;
      // #2702: continuous-idle backstop; #2703: shorter threshold once
      // pressure has held for CAP_PRESSURE_REAP_MIN_STREAK passes.
      await this.reaper.reapIdle(now, {
        pressure: reading,
        accelerate: this.pressureStreak >= CAP_PRESSURE_REAP_MIN_STREAK,
      });
      this.reaper.sweepConsumedOneShots(now); // #2701: deferred one-shot delete
    }

    const dueTasks = this.store.getDueTasks(now);

    if (dueTasks.length === 0) return;

    // ── Missed schedule detection ─────────────────────────────────────
    // For recurring tasks overdue by more than 1.5x their interval,
    // log missed executions as "skipped" and recalculate from now.
    const missedTaskIds: string[] = [];
    for (const task of dueTasks) {
      if (task.scheduleType === "at") continue; // One-shots don't "miss"
      if (!task.nextExecutionAt || !task.intervalMs) continue;

      const overdueMs = now - task.nextExecutionAt;
      if (overdueMs > task.intervalMs * 1.5) {
        const missedCount = Math.min(
          Math.floor(overdueMs / task.intervalMs),
          100 // Cap to prevent flood
        );
        // #2703: under sustained cap pressure an `every` task reaches this
        // branch because its runs were deferred, not because the server was
        // down — say so.
        const missedCause = isCapPressureSkip(
          this.store.getExecutionHistory(task.id, 1)[0]
        )
          ? "deferred under cap pressure"
          : "server was offline";

        for (let i = 0; i < missedCount; i++) {
          const missedTime = task.nextExecutionAt + i * task.intervalMs;
          const exec = this.store.createExecution(task.id, missedTime);
          this.store.updateExecution(exec.id, {
            status: "skipped",
            completedAt: now,
            errorMessage: `Missed execution — ${missedCause} (${missedCount} total missed)`,
          });
        }

        console.log(
          `[Scheduler] Task "${task.name}" missed ${missedCount} execution(s) — logged as skipped`
        );

        // Advance lastExecutedAt to now so calculateBaseCandidate computes
        // next = now + intervalMs (in the future), then re-fetch fresh task
        this.store.updateLastExecuted(task.id, now);
        const freshTask = this.store.getTask(task.id, task.namespace);
        if (freshTask) this.updateNextExecution(freshTask);
        missedTaskIds.push(task.id);
      }
    }

    // Filter out missed tasks (they've been rescheduled)
    const activeDueTasks = dueTasks.filter(t => !missedTaskIds.includes(t.id));

    if (activeDueTasks.length === 0) return;

    for (const task of activeDueTasks) {
      if (!this.running) break;

      const result = await this.executor.execute(task, { pressure });
      // #2700: one emit per execution, placed BEFORE the result handling below.
      // A consumed one-shot is only disabled in this iteration (#2701); its
      // `deleteAfterRun` delete happens later in SessionReaper.sweepConsumedOneShots
      // once its session is reaped, and that sweep emits its own "deleted".
      this.emitScheduleChanged(task, "executed");

      // Update task state based on result
      if (result.success) {
        this.store.updateConsecutiveErrors(task.id, 0);
        this.store.updateLastExecuted(task.id, Date.now());

        // Event count tracking
        if (task.eventCountLimit !== null) {
          const newCount = task.eventCountCurrent + 1;
          this.store.updateEventCount(task.id, newCount);

          if (newCount >= task.eventCountLimit) {
            // Disable task — event count limit reached
            this.store.updateTask(task.id, { enabled: false }, task.namespace);
            this.store.updateNextExecution(task.id, null);
            console.log(
              `[Scheduler] Task "${task.name}" reached event count limit (${newCount}/${task.eventCountLimit}) — disabled`
            );
            continue;
          }
        }

        // Handle one-shot auto-delete/disable — disable now, delete later
        if (task.scheduleType === "at") {
          this.consumeOneShot(task);
          continue; // Skip next execution calc — the one-shot is spent
        }
      } else {
        // Increment consecutive errors (skipped executions don't count)
        if (result.execution.status !== "skipped") {
          const newErrorCount = task.consecutiveErrors + 1;
          this.store.updateConsecutiveErrors(task.id, newErrorCount);
          this.store.updateLastExecuted(task.id, Date.now());
        }

        // #4033: a skipped one-shot run must not reach the null-recompute
        // below — that would leave it enabled with next_execution_at = NULL.
        if (result.execution.status === "skipped") {
          const freshForDefer = this.store.getTask(task.id, task.namespace);
          if (freshForDefer) {
            const outcome = this.handleSkippedRun(
              freshForDefer,
              result,
              Date.now()
            );
            if (this.isSkipResolved(outcome, freshForDefer)) continue;
          }
        }
      }

      // Calculate and store next execution time — refresh from DB so
      // lastExecutedAt (updated above) is current, not stale from getDueTasks()
      const freshTask = this.store.getTask(task.id, task.namespace);
      if (freshTask) this.updateNextExecution(freshTask);
    }
  }

  /**
   * Retire a one-shot whose run just spawned its session: disable it and
   * clear its next execution. A `deleteAfterRun` one-shot is NOT deleted here
   * — deleting it now would CASCADE its execution row away while the session
   * is still running, blinding the completion endpoint and every reaper pass
   * (#2701, review finding 2701-1). `SessionReaper.sweepConsumedOneShots`
   * deletes it once none of its executions holds a session.
   */
  private consumeOneShot(task: ScheduledTask): void {
    this.store.updateTask(task.id, { enabled: false }, task.namespace);
    this.store.updateNextExecution(task.id, null);
    if (task.deleteAfterRun) {
      console.log(
        `[Scheduler] Consumed one-shot task "${task.name}" — deletion deferred until its session is reaped`
      );
    }
  }

  // ── Next execution calculation ─────────────────────────────────────

  private calculateNextExecution(task: ScheduledTask): number | null {
    return calculateNextWithLayers(task, Date.now());
  }

  private applyJitter(
    nextExecutionAt: number,
    jitterMaxMs: number | null
  ): number {
    if (!jitterMaxMs || jitterMaxMs <= 0) return nextExecutionAt;
    return nextExecutionAt + Math.floor(Math.random() * jitterMaxMs);
  }

  private applyBackoff(
    nextExecutionAt: number,
    consecutiveErrors: number,
    backoffConfig: string | null = null
  ): number {
    if (consecutiveErrors === 0) return nextExecutionAt;

    let delays: readonly number[] = BACKOFF_DELAYS_MS;

    if (backoffConfig) {
      try {
        const custom = JSON.parse(backoffConfig) as number[];
        if (
          Array.isArray(custom) &&
          custom.length > 0 &&
          custom.every(n => typeof n === "number")
        ) {
          delays = custom;
        }
      } catch (err) {
        if (this.errorLogger) {
          this.errorLogger.warn(
            "[Scheduler] Invalid backoff config — using defaults",
            {
              category: "scheduler-config",
              stack: err instanceof Error ? err.stack : null,
              context: {
                error: err instanceof Error ? err.message : String(err),
              },
            }
          );
        } else {
          console.warn(
            `[Scheduler] Invalid backoff config — using defaults:`,
            err instanceof Error ? err.message : String(err)
          );
        }
      }
    }

    const delayIndex = Math.min(consecutiveErrors, delays.length - 1);
    const delay = delays[delayIndex];
    return nextExecutionAt + delay;
  }

  private updateNextExecution(task: ScheduledTask): void {
    const nextRaw = this.calculateNextExecution(task);
    if (nextRaw === null) {
      this.store.updateNextExecution(task.id, null);
      return;
    }

    // Apply jitter (load-balancing) then backoff (error recovery)
    const withJitter = this.applyJitter(nextRaw, task.jitterMaxMs);
    const current = this.store.getTask(task.id, task.namespace);
    const errors = current?.consecutiveErrors ?? task.consecutiveErrors;
    const nextFinal = this.applyBackoff(withJitter, errors, task.backoffConfig);

    this.store.updateNextExecution(task.id, nextFinal);
  }

  // ── Skipped one-shot deferral (#4033) ──────────────────────────────

  /**
   * Anchor time of a pending one-shot run that deferral applies to, or null.
   * - an `at` task whose scheduledAt has arrived → scheduledAt
   * - a run_once_at_creation run that has never executed → createdAt, except
   *   for an `at` task whose scheduledAt is still ahead: that scheduled run
   *   subsumes the creation run, and re-arming it early would let the tick
   *   success branch retire the task before its real run. The creation run
   *   is pending only while its execution history is creation-time skips.
   */
  private pendingRunAnchor(task: ScheduledTask, now: number): number | null {
    if (task.scheduleType === "at") {
      if (task.scheduledAt !== null && task.scheduledAt <= now) {
        return task.scheduledAt;
      }
      return null;
    }
    if (task.runOnceAtCreation && task.lastExecutedAt === null) {
      // lastExecutedAt alone is not proof the creation run is pending: a task
      // created disabled, a failed creation run, or a daemon-wait timeout all
      // leave it null. Require the durable trace of a deferred creation run —
      // only skipped executions, the first written at creation time. A drop
      // row (status failed) retires it, so the drop is recorded once.
      const { firstExecutionAt, nonSkipped } = this.store.getCreationRunState(
        task.id
      );
      if (
        nonSkipped === 0 &&
        firstExecutionAt !== null &&
        firstExecutionAt - task.createdAt <= CREATION_RUN_ATTEMPT_WINDOW_MS
      ) {
        return task.createdAt;
      }
    }
    return null;
  }

  /**
   * True when the task's latest execution is a skip — i.e. a run is waiting
   * on a gate. Guards the restart re-arm against re-firing a one-shot that
   * already ran (catchUpMissedTasks does not set lastExecutedAt).
   */
  private isDeferralPending(task: ScheduledTask): boolean {
    return this.store.getExecutionHistory(task.id, 1)[0]?.status === "skipped";
  }

  /**
   * Decide what happens to a skipped run. Shared by tick(), executeAndRecord()
   * and the startup recalc so every skip source (including #2703's
   * cap-pressure defer) gets one re-arm + one budget:
   * - "rearmed": next_execution_at = now + one tick
   * - "dropped": defer window exhausted — recorded as a `failed` execution
   *   ("Dropped: …"); an `at` task is disabled, never deleted, so the record
   *   survives the executions cascade delete
   * - "not-deferrable": the caller keeps its normal next-execution path
   *
   * A cap-pressure skip of an `every` / `cron` run is "not-deferrable" by
   * design (#2703): like the concurrency / overlap / thermal skips, the run is
   * yielded to the task's next occurrence rather than caught up in a burst
   * that would compete with the interactive work L4 protects.
   */
  private handleSkippedRun(
    task: ScheduledTask,
    result: ExecutionResult | null,
    now: number
  ): "rearmed" | "dropped" | "not-deferrable" {
    const anchor = this.pendingRunAnchor(task, now);
    if (anchor === null) return "not-deferrable";

    const reason = result?.skipReason ?? "unknown";
    const lifetimeOver = task.lifetimeEnd !== null && task.lifetimeEnd <= now;
    if (now < anchor + ONESHOT_DEFER_WINDOW_MS && !lifetimeOver) {
      this.store.updateNextExecution(task.id, now + TICK_INTERVAL_MS);
      this.errorLogger?.info(
        `[Scheduler] Deferred one-shot run of "${task.name}" (${reason} gate) — re-armed for next tick`,
        { category: "scheduler" }
      );
      return "rearmed";
    }

    const deferredMin = Math.round((now - anchor) / 60_000);
    const message = lifetimeOver
      ? `Dropped: one-shot run deferred ${deferredMin}min by ${reason} gate — task lifetime ended`
      : `Dropped: one-shot run deferred ${deferredMin}min by ${reason} gate — defer window (${ONESHOT_DEFER_WINDOW_MS / 60_000}min) exhausted`;
    const exec = this.store.createExecution(task.id, anchor);
    this.store.updateExecution(exec.id, {
      status: "failed",
      completedAt: now,
      errorMessage: message,
    });
    if (task.scheduleType === "at") {
      this.store.updateTask(task.id, { enabled: false }, task.namespace);
      this.store.updateNextExecution(task.id, null);
    }
    this.errorLogger?.warn(`[Scheduler] Task "${task.name}": ${message}`, {
      category: "scheduler",
    });
    return "dropped";
  }

  /**
   * True when handleSkippedRun fully resolved the skip, so the caller must NOT
   * run its normal next-execution path: the run was re-armed, or a one-shot
   * was dropped and disabled. A dropped creation run of a recurring task is
   * not resolved — its regular schedule still needs computing.
   */
  private isSkipResolved(
    outcome: ReturnType<SchedulerService["handleSkippedRun"]>,
    task: ScheduledTask
  ): boolean {
    return (
      outcome === "rearmed" ||
      (outcome === "dropped" && task.scheduleType === "at")
    );
  }

  private recalculateAllNextExecutions(): void {
    const tasks = this.store.getEnabledTasks();
    let calculated = 0;

    for (const task of tasks) {
      // #4033: keep a pending deferral armed across restarts — the recompute
      // below returns null for every past-due `at` task.
      const nowMs = Date.now();
      if (
        this.pendingRunAnchor(task, nowMs) !== null &&
        this.isDeferralPending(task)
      ) {
        const outcome = this.handleSkippedRun(task, null, nowMs);
        if (outcome === "rearmed") calculated++;
        if (this.isSkipResolved(outcome, task)) continue;
      }

      const next = this.calculateNextExecution(task);
      if (next !== null) {
        const withJitter = this.applyJitter(next, task.jitterMaxMs);
        const withBackoff = this.applyBackoff(
          withJitter,
          task.consecutiveErrors,
          task.backoffConfig
        );
        this.store.updateNextExecution(task.id, withBackoff);
        calculated++;
      } else {
        this.store.updateNextExecution(task.id, null);
      }
    }

    if (calculated > 0) {
      console.log(
        `[Scheduler] Calculated next executions for ${calculated} tasks`
      );
    }
  }

  // ── Heartbeat migration ─────────────────────────────────────────────

  /**
   * Auto-migrate legacy heartbeat config from settings.json to a DB-backed
   * scheduled task. Idempotent: skips if a heartbeat task already exists
   * or if no legacy config is found.
   */
  private async migrateHeartbeatIfNeeded(): Promise<void> {
    try {
      const migrationInput = await migrateHeartbeatConfig(
        configuration.dataDir,
        "default"
      );
      if (!migrationInput) return;

      // Check if heartbeat DB task already exists
      const existingTasks = this.store.getEnabledTasks();
      const hasHeartbeatTask = existingTasks.some(t => t.heartbeatMode);
      if (hasHeartbeatTask) return;

      const task = this.store.createTask(migrationInput, "default");
      const next = this.calculateNextExecution(task);
      this.store.updateNextExecution(task.id, next);
      console.log(
        `[Scheduler] Migrated heartbeat config to scheduled task: ${task.id}`
      );
    } catch (error) {
      if (this.errorLogger) {
        this.errorLogger.warn("[Scheduler] Heartbeat migration failed", {
          category: "scheduler-migration",
          stack: error instanceof Error ? error.stack : null,
          context: { migration: "heartbeat" },
        });
      } else {
        console.error("[Scheduler] Heartbeat migration failed:", error);
      }
      // Non-fatal — old HeartbeatService continues to work
    }
  }

  // ── Session reaper (periodic) ──────────────────────────────────────

  /**
   * Force-archive scheduled sessions that have outlived their runtime ceiling.
   * The ceiling is the task's explicit `maxRuntimeMs`, else
   * `SCHEDULED_SESSION_DEFAULT_MAX_RUNTIME_MS` (#2699); heartbeat tasks get only
   * an explicit ceiling, never the default (their session is reused across
   * runs). Runs periodically from tick() to prevent zombie session accumulation.
   */
  private async reapStaleSessions(nowMs: number): Promise<void> {
    const stale = this.store.getStaleScheduledExecutions(nowMs);
    if (stale.length === 0) return;

    for (const entry of stale) {
      const session = this.syncEngine.getSession(entry.sessionId);
      if (!session?.active) {
        // #4111: inactive ≠ gone until CLIs have had time to reconnect.
        if (nowMs - this.startedAtMs < SCHEDULER_BOOT_LIVENESS_GRACE_MS) {
          continue;
        }
        // Session already inactive — just mark the execution as timed out
        this.store.markExecutionReaped(entry.executionId, "inactive", nowMs, {
          status: "timed_out",
          errorMessage: `Session already inactive — marking execution timed out (maxRuntime: ${Math.round(entry.maxRuntimeMs / 60_000)}min)`,
        });
        continue;
      }

      // #1603: scheduler reaper is a TERMINAL archive — reap window B. The
      // reaper's shared archive step (#2703 R9) is that same
      // archiveSession(id, { reapRemoteWindow: true }) call.
      if (
        !(await this.reaper.archiveForReap(
          entry.sessionId,
          "stale",
          entry.taskName
        ))
      ) {
        // Archive failed — leave for next reap cycle instead of falsely marking timed_out
        continue;
      }

      this.store.markExecutionReaped(entry.executionId, "ceiling", nowMs, {
        status: "timed_out",
        errorMessage: `Reaped — session exceeded maxRuntime (${Math.round(entry.maxRuntimeMs / 60_000)}min, ran ${Math.round((nowMs - entry.startedAt) / 60_000)}min)`,
      });

      this.errorLogger?.info(
        `[Reaper] Archived stale session ${entry.sessionId} for task "${entry.taskName}" — ran ${Math.round((nowMs - entry.startedAt) / 60_000)}min (max: ${Math.round(entry.maxRuntimeMs / 60_000)}min)`,
        { category: "scheduler" }
      );
    }

    console.log(
      `[Scheduler] Reaped ${stale.length} stale session(s) exceeding maxRuntime`
    );
  }

  // ── Startup recovery ───────────────────────────────────────────────

  /**
   * Settle executions a previous run left `running`/`delivered` (#4111).
   *
   * Heartbeat rows (one reused session, never reaped by default) and rows that
   * never got a session are timed out here, as before. Any other row may still
   * hold a live session — its CLI simply has not reconnected yet — so it is left
   * in the reap candidate set for the normal reapers, and only settled by
   * `settleDeferredRecovery` if its session is still gone after the boot grace.
   * Recovery never archives anything.
   */
  private recoverStuckExecutions(): void {
    const stuck = this.store.getStuckExecutions(STUCK_RUN_TIMEOUT_MS);
    if (stuck.length === 0) return;

    let recovered = 0;
    for (const execution of stuck) {
      const found = this.store.getExecutionWithTask(execution.id);
      if (found && !found.heartbeatMode && execution.sessionId) {
        this.deferredRecovery.add(execution.id);
        continue;
      }
      this.store.updateExecution(execution.id, {
        status: "timed_out",
        completedAt: Date.now(),
        errorMessage: `Recovered on startup — execution ran longer than ${STUCK_RUN_TIMEOUT_MS / 1000 / 60} minutes`,
      });
      recovered++;
    }

    console.log(
      `[Scheduler] Recovered ${recovered} stuck execution(s); deferred ${this.deferredRecovery.size} live-candidate execution(s) to the reaper (#4111)`
    );
  }

  /**
   * One pass, after the boot grace (#4111): an execution recovery deferred
   * whose session never came back is settled `timed_out` / `inactive`. A live
   * one is left to the reapers. Never archives.
   */
  private settleDeferredRecovery(nowMs: number): void {
    if (this.deferredRecovery.size === 0) return;
    if (nowMs - this.startedAtMs < SCHEDULER_BOOT_LIVENESS_GRACE_MS) return;

    let settled = 0;
    for (const executionId of this.deferredRecovery) {
      const execution = this.store.getExecutionWithTask(executionId)?.execution;
      if (
        !execution?.sessionId ||
        execution.reapedAt != null ||
        (execution.status !== "running" && execution.status !== "delivered")
      ) {
        continue;
      }
      if (this.syncEngine.getSession(execution.sessionId)?.active) continue;
      if (
        this.store.markExecutionReaped(executionId, "inactive", nowMs, {
          status: "timed_out",
          errorMessage:
            "Recovered after startup — session did not reconnect within the boot grace",
          onlyFromStatuses: ["running", "delivered"],
        })
      ) {
        settled++;
      }
    }
    this.deferredRecovery.clear();

    if (settled > 0) {
      console.log(
        `[Scheduler] Settled ${settled} deferred execution(s) whose session did not reconnect (#4111)`
      );
    }
  }

  private async catchUpMissedTasks(): Promise<void> {
    const now = Date.now();
    const graceDeadline = now - MISSED_TASK_GRACE_MS;

    // Find enabled one-shot tasks that were due within the grace period
    const enabledTasks = this.store.getEnabledTasks();
    let caughtUp = 0;

    for (const task of enabledTasks) {
      if (task.scheduleType !== "at") continue;
      if (!task.scheduledAt) continue;
      if (task.lastExecutedAt) continue; // Already ran
      if (task.scheduledAt > now) continue; // Still in the future
      if (task.scheduledAt < graceDeadline) continue; // Too old
      // #4033: a deferred one-shot is re-armed by recalculateAllNextExecutions
      // and retried by tick() once the daemon is connected. Executing it here
      // (daemon not yet connected at boot) would write a "no machines" failure
      // row that hides the pending deferral.
      if (this.isDeferralPending(task)) continue;

      console.log(
        `[Scheduler] Catching up missed one-shot task "${task.name}"`
      );
      const result = await this.executor.execute(task);

      if (result.success) this.consumeOneShot(task);
      this.emitScheduleChanged(task, "executed");

      caughtUp++;
    }

    if (caughtUp > 0) {
      console.log(`[Scheduler] Caught up ${caughtUp} missed one-shot task(s)`);
    }
  }

  // ── CRUD operations (called by API routes) ─────────────────────────

  createTask(input: CreateScheduledTask, namespace: string): ScheduledTask {
    const task = this.store.createTask(input, namespace);

    // Set default for one-shot tasks
    if (task.scheduleType === "at" && !task.deleteAfterRun) {
      this.store.updateTask(task.id, { deleteAfterRun: true }, namespace);
    }

    // Calculate and store initial next execution
    const next = this.calculateNextExecution(task);
    this.store.updateNextExecution(task.id, next);

    const created = this.store.getTask(task.id, namespace)!;
    this.emitScheduleChanged(created, "created");

    // Fire immediately if runOnceAtCreation is enabled
    if (created.runOnceAtCreation && created.enabled) {
      this.fireOnCreation(created);
    }

    return created;
  }

  getTask(id: string, namespace: string): ScheduledTask | null {
    return this.store.getTask(id, namespace);
  }

  getAllTasks(namespace: string): ScheduledTask[] {
    return this.store.getAllTasks(namespace);
  }

  /**
   * Every enabled task ACROSS all namespaces. Added by #1274: core's
   * legacy-heartbeat hand-off used to reach `store.scheduler.getEnabledTasks()`
   * directly, and core no longer owns the store. Deliberately cross-namespace —
   * narrowing it to one namespace would change which installs disable the
   * legacy HeartbeatService.
   */
  getEnabledTasks(): ScheduledTask[] {
    return this.store.getEnabledTasks();
  }

  updateTask(
    id: string,
    input: UpdateScheduledTask,
    namespace: string
  ): ScheduledTask | null {
    const task = this.store.updateTask(id, input, namespace);
    if (!task) return null;

    // Recalculate next execution if schedule changed
    if (
      input.scheduleType !== undefined ||
      input.cronExpression !== undefined ||
      input.scheduledAt !== undefined ||
      input.intervalMs !== undefined ||
      input.timezone !== undefined ||
      input.enabled !== undefined
    ) {
      if (task.enabled) {
        const next = this.calculateNextExecution(task);
        if (next !== null) {
          const withJitter = this.applyJitter(next, task.jitterMaxMs);
          const withBackoff = this.applyBackoff(
            withJitter,
            task.consecutiveErrors,
            task.backoffConfig
          );
          this.store.updateNextExecution(task.id, withBackoff);
        } else {
          this.store.updateNextExecution(task.id, null);
        }
      } else {
        this.store.updateNextExecution(task.id, null);
      }
    }

    return this.store.getTask(id, namespace);
  }

  deleteTask(id: string, namespace: string): boolean {
    const deleted = this.store.deleteTask(id, namespace);
    if (deleted) this.emitScheduleChanged({ id, namespace }, "deleted");
    return deleted;
  }

  /**
   * #3172: USER-initiated schedule delete that also disposes of the sessions the
   * schedule spawned, per the caller's explicit choice (mirrors #2479/#2480's
   * managed-peer parent delete):
   *  - `orphan`  — dissolve: null each child's `metadata.scheduleId` so it
   *               survives as an independent top-level session (never a ghost
   *               pointing at a deleted schedule).
   *  - `cascade` — archive (terminal, reaps window B) then delete each child.
   *               Archive-first is mandatory: `deleteSession` refuses any
   *               active, non-orphaned session, and scheduler children are
   *               usually active.
   * A child that fails to cascade is dissolved instead (fallback), so it stays
   * visible and removable by hand. Children are enumerated AFTER the store
   * delete: with the schedule gone no new tick can start a spawn for it.
   * Heartbeat schedules stamp no `scheduleId`, so they have zero children here
   * (expected no-op). The not-user-initiated `deleteAfterRun` self-deletes call
   * the store directly and are unaffected. Returns null when the schedule does
   * not exist.
   */
  async deleteTaskWithChildren(
    id: string,
    namespace: string,
    disposition: ScheduleChildDisposition
  ): Promise<DeleteTaskChildrenResult | null> {
    if (!this.deleteTask(id, namespace)) return null;

    const childIds = this.syncEngine
      .getSessionsByNamespace(namespace)
      .filter(
        s => s.metadata?.source === "scheduler" && s.metadata?.scheduleId === id
      )
      .map(s => s.id);

    const affected: string[] = [];
    const failed: DeleteTaskChildrenResult["failed"] = [];

    for (const sessionId of childIds) {
      try {
        if (disposition === "cascade") {
          if (this.syncEngine.getSession(sessionId)?.active) {
            await this.syncEngine.archiveSession(sessionId, {
              reapRemoteWindow: true,
            });
          }
          await this.syncEngine.deleteSession(sessionId);
        } else if (
          !(await this.syncEngine.clearSessionScheduleLink(sessionId))
        ) {
          throw new Error("Failed to dissolve schedule link");
        }
        affected.push(sessionId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ sessionId, error: message });
        this.errorLogger?.warn(
          `[Scheduler] Failed to ${disposition} session ${sessionId} of deleted schedule ${id}`,
          {
            category: "scheduler-delete",
            context: { scheduleId: id, sessionId, disposition, error: message },
          }
        );
        if (disposition === "cascade") {
          await this.syncEngine
            .clearSessionScheduleLink(sessionId)
            .catch(() => false);
        }
      }
    }

    return { disposition, affected, failed };
  }

  toggleTask(id: string, namespace: string): ScheduledTask | null {
    const task = this.store.toggleTask(id, namespace);
    if (!task) return null;

    if (task.enabled) {
      const next = this.calculateNextExecution(task);
      if (next !== null) {
        const withJitter = this.applyJitter(next, task.jitterMaxMs);
        const withBackoff = this.applyBackoff(
          withJitter,
          task.consecutiveErrors,
          task.backoffConfig
        );
        this.store.updateNextExecution(task.id, withBackoff);
      } else {
        this.store.updateNextExecution(task.id, null);
      }
    } else {
      this.store.updateNextExecution(task.id, null);
    }

    return this.store.getTask(id, namespace);
  }

  async runNow(id: string, namespace: string): Promise<ExecutionResult> {
    const task = this.store.getTask(id, namespace);
    if (!task) {
      return {
        success: false,
        execution: {
          id: "",
          taskId: id,
          sessionId: null,
          scheduledFor: Date.now(),
          startedAt: null,
          completedAt: null,
          status: "failed",
          errorMessage: "Task not found",
          createdAt: Date.now(),
        },
        error: "Task not found",
      };
    }

    // #2703 R11: "Run now" is the operator's own interactive intent — it is
    // never deferred by the cap-pressure gate (the daemon hard cap still applies).
    const result = await this.executor.execute(task, {
      bypassCapPressure: true,
    });
    this.emitScheduleChanged(task, "executed");
    return result;
  }

  /**
   * A scheduled session declares its own execution done (#2701). Delegates to
   * the reaper, which authorizes it and marks the row; the session is reaped
   * once it is safe to.
   */
  completeExecution(
    executionId: string,
    namespace: string,
    sessionTag: string | undefined
  ): CompleteExecutionResult {
    return this.reaper.completeExecution(executionId, namespace, sessionTag);
  }

  getExecutionHistory(
    taskId: string,
    limit?: number,
    offset?: number
  ): TaskExecution[] {
    return this.store.getExecutionHistory(taskId, limit, offset);
  }
}
