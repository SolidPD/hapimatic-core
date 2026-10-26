// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Task Executor — Session Spawn/Monitor/Notify
 *
 * Handles the execution lifecycle for a single scheduled task:
 *   preconditions → create execution → spawn session → poll active →
 *   send prompt → monitor completion → update status → notify
 *
 * Pre-spawn gates, in order: concurrency, overlap, thermal, machine
 * availability, cap pressure (#2703 — local machine only, fail-open).
 *
 * Each execution is independent and isolated — no shared state between runs.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { SyncEngine, SyncEvent } from "../../../sync/syncEngine";
import type { PushService } from "../../../push/pushService";
import { buildSessionPushPayload } from "../../../push/sessionPushPayload";
import { getSessionName } from "../../../notifications/sessionInfo";
import type { NotificationHub } from "../../../notifications/notificationHub";
import type { SystemEventQueue } from "../../../heartbeat/systemEvents";
import { extractMessageEventType } from "../../../notifications/eventParsing";
import type { SchedulerStore } from "../store/schedulerStore";
import type { RotationConfig } from "./temporalFilter";
import {
  buildHeartbeatPrompt,
  shouldSuppressResponse,
  extractResponseText,
} from "./heartbeatIntegration";
import { assembleScheduledPrompt } from "./promptTemplates";
import type { ScheduledTask, TaskExecution } from "./types";
import { MAX_CONCURRENT_RUNS, THERMAL_THRESHOLD_C } from "./types";
import type { ErrorLogger } from "../../../logging/errorLogger";
import {
  defaultPressureDeps,
  isPressureOnMachine,
  readCapPressure,
  type PressureReader,
  type PressureReading,
} from "./capPressure";

const execAsync = promisify(exec);

/** How long to wait for a session to become active after spawn */
const SESSION_ACTIVE_TIMEOUT_MS = 30_000; // 30 seconds
/** Polling interval when waiting for session to become active */
const SESSION_POLL_INTERVAL_MS = 500;

/**
 * Why a pre-spawn gate skipped a run. The executor only reports the reason;
 * SchedulerService decides whether a skipped one-shot is re-armed or dropped
 * (#4033). "cap-pressure" is the #2703 L4 yield-to-interactive gate.
 */
export type SkipReason =
  | "concurrency"
  | "overlap"
  | "thermal"
  | "session-busy"
  | "cap-pressure";

/**
 * errorMessage prefix of a cap-pressure skip row. Consecutive cap-pressure
 * skips of one task coalesce into the row carrying this prefix (#2703 R7) —
 * matched by prefix because the skip reason is not persisted as a column.
 */
export const CAP_PRESSURE_SKIP_PREFIX = "Deferred — cap pressure";

/**
 * True when an execution row is a cap-pressure deferral. The ONE place the
 * prefix match lives — if the skip reason is ever persisted as a column,
 * switch this predicate to it.
 */
export function isCapPressureSkip(
  execution: Pick<TaskExecution, "status" | "errorMessage"> | undefined
): boolean {
  return (
    execution?.status === "skipped" &&
    execution.errorMessage?.startsWith(CAP_PRESSURE_SKIP_PREFIX) === true
  );
}

export type ExecuteOptions = {
  /** The tick's shared pressure reader; absent ⇒ a fresh read (#2703). */
  pressure?: PressureReader;
  /** Skip the cap-pressure gate — operator "Run now" (#2703 R11). */
  bypassCapPressure?: boolean;
};

export type ExecutionResult = {
  success: boolean;
  execution: TaskExecution;
  error?: string;
  /** Set when execution.status === "skipped". */
  skipReason?: SkipReason;
};

export class TaskExecutor {
  constructor(
    private readonly syncEngine: SyncEngine,
    private readonly store: SchedulerStore,
    private readonly pushService: PushService,
    private readonly notificationHub?: NotificationHub,
    private readonly systemEventQueue?: SystemEventQueue,
    private readonly errorLogger?: ErrorLogger | null,
    private readonly capPressure: { readPressure?: PressureReader } = {}
  ) {}

  /**
   * Execute a scheduled task. Returns the execution result.
   * This is the full lifecycle — called by SchedulerService on each due task.
   */
  async execute(
    task: ScheduledTask,
    opts: ExecuteOptions = {}
  ): Promise<ExecutionResult> {
    const now = Date.now();

    // ── Precondition: concurrency limit ──────────────────────────────
    // Count distinct live sessions spawned by the scheduler, not just
    // execution records in 'running' state. Executions transition to
    // 'delivered' in ~2s but sessions can run for hours (#608).
    const activeExecs = this.store.getActiveExecutions();
    const liveSessionIds = new Set(
      activeExecs
        .filter(
          e => e.sessionId && this.syncEngine.getSession(e.sessionId)?.active
        )
        .map(e => e.sessionId)
    );
    if (liveSessionIds.size >= MAX_CONCURRENT_RUNS) {
      const execution = this.store.createExecution(task.id, now);
      this.store.updateExecution(execution.id, {
        status: "skipped",
        completedAt: Date.now(),
        errorMessage: `Concurrency limit reached (${liveSessionIds.size} live session(s) / max ${MAX_CONCURRENT_RUNS})`,
      });
      this.errorLogger?.info(
        `Skipped task "${task.name}" — concurrency limit (${liveSessionIds.size} live sessions)`,
        { category: "scheduler" }
      );
      return {
        success: false,
        execution: { ...execution, status: "skipped" },
        error: "Concurrency limit reached",
        skipReason: "concurrency",
      };
    }

    // ── Precondition: overlap policy ─────────────────────────────────
    // Check for live sessions belonging to this task, not just execution
    // records in 'running' state (#608).
    if (task.overlapPolicy === "skip") {
      const taskExecs = this.store.getRunningExecutions(task.id);
      const hasLiveSession = taskExecs.some(
        e => e.sessionId && this.syncEngine.getSession(e.sessionId)?.active
      );
      if (hasLiveSession) {
        const execution = this.store.createExecution(task.id, now);
        this.store.updateExecution(execution.id, {
          status: "skipped",
          completedAt: Date.now(),
          errorMessage: "Active session exists for this task (overlap=skip)",
        });
        this.errorLogger?.info(
          `Skipped task "${task.name}" — overlap policy (live session found)`,
          {
            category: "scheduler",
          }
        );
        return {
          success: false,
          execution: { ...execution, status: "skipped" },
          error: "Overlap skipped",
          skipReason: "overlap",
        };
      }
    }

    // ── Precondition: thermal check (Pi-specific) ────────────────────
    const thermal = await this.checkThermal();
    if (thermal.blocked) {
      const execution = this.store.createExecution(task.id, now);
      this.store.updateExecution(execution.id, {
        status: "skipped",
        completedAt: Date.now(),
        errorMessage: `Thermal threshold exceeded: ${thermal.tempC}°C > ${THERMAL_THRESHOLD_C}°C`,
      });
      this.errorLogger?.info(
        `Skipped task "${task.name}" — thermal ${thermal.tempC}°C`,
        { category: "scheduler" }
      );
      return {
        success: false,
        execution: { ...execution, status: "skipped" },
        error: `Thermal: ${thermal.tempC}°C`,
        skipReason: "thermal",
      };
    }

    // ── Precondition: machine availability ───────────────────────────
    const machines = this.syncEngine.getOnlineMachinesByNamespace(
      task.namespace
    );
    if (machines.length === 0) {
      const execution = this.store.createExecution(task.id, now);
      this.store.updateExecution(execution.id, {
        status: "failed",
        completedAt: Date.now(),
        errorMessage: "No machines online in namespace",
      });
      this.errorLogger?.warn(
        `Failed task "${task.name}" — no machines online`,
        { category: "scheduler", namespace: task.namespace }
      );
      return {
        success: false,
        execution: { ...execution, status: "failed" },
        error: "No machines online",
      };
    }

    const machineId = machines[0].id;

    // ── Precondition: cap pressure (#2703, epic #2698 L4) ────────────
    // Yield the slot to interactive / PM work when the LOCAL node is near its
    // cap. Non-heartbeat tasks always spawn fresh, so this sits before the
    // execution record: a deferred run never writes a `running` row. Heartbeat
    // tasks and operator "Run now" are exempt (#2703 R11). A plain pre-spawn
    // check — the spawn below stays synchronous (#1565 R5).
    if (!task.heartbeatMode && !opts.bypassCapPressure) {
      const deferred = await this.deferUnderCapPressure(
        task,
        machineId,
        opts.pressure,
        now
      );
      if (deferred) return deferred;
    }

    // ── Create execution record ──────────────────────────────────────
    const execution = this.store.createExecution(task.id, now);
    this.store.updateExecution(execution.id, {
      status: "running",
      startedAt: Date.now(),
    });

    try {
      // ── Session reuse for heartbeat tasks ────────────────────────
      // Only heartbeat tasks reuse sessions across ticks. Non-heartbeat
      // recurring tasks (auto agents) always spawn fresh — they are
      // ephemeral and should never reconnect to previous sessions.
      let sessionId: string | null = null;
      const isRecurring =
        task.scheduleType === "cron" || task.scheduleType === "every";

      // ── Session rotation check (heartbeat only) ────────────────
      if (
        isRecurring &&
        task.heartbeatMode &&
        task.lastSessionId &&
        task.rotationConfig
      ) {
        try {
          const rotation: RotationConfig = JSON.parse(task.rotationConfig);
          let shouldRotate = false;

          if (rotation.mode === "count" && rotation.count) {
            // Count-based: rotate after X uses
            shouldRotate =
              task.eventCountCurrent > 0 &&
              task.eventCountCurrent % rotation.count === 0;
          } else if (
            rotation.mode === "time" &&
            rotation.day !== undefined &&
            rotation.hour !== undefined
          ) {
            // Time-based: rotate if current day+hour matches config
            const fmt = new Intl.DateTimeFormat("en-US", {
              timeZone: task.timezone,
              weekday: "short",
              hour: "numeric",
              hour12: false,
            });
            const parts = fmt.formatToParts(new Date());
            const dayMap: Record<string, number> = {
              Sun: 0,
              Mon: 1,
              Tue: 2,
              Wed: 3,
              Thu: 4,
              Fri: 5,
              Sat: 6,
            };
            const currentDay =
              dayMap[parts.find(p => p.type === "weekday")?.value ?? ""] ?? -1;
            const currentHour = Number(
              parts.find(p => p.type === "hour")?.value ?? -1
            );

            shouldRotate =
              currentDay === rotation.day && currentHour === rotation.hour;
          }

          if (shouldRotate) {
            this.errorLogger?.info(
              `Task "${task.name}" rotating session (mode: ${rotation.mode})`,
              { category: "scheduler" }
            );
            // Clear lastSessionId to force fresh spawn
            this.store.updateLastSessionId(task.id, null);
            // Nullify local reference for this execution
            task = { ...task, lastSessionId: null };
          }
        } catch (err) {
          this.errorLogger?.warn(
            `Task "${task.name}" has invalid rotation config — skipping rotation`,
            {
              category: "scheduler",
              context: {
                error: err instanceof Error ? err.message : String(err),
                rotationConfig: task.rotationConfig?.substring(0, 200),
              },
            }
          );
        }
      }

      if (isRecurring && task.heartbeatMode && task.lastSessionId) {
        const existing = this.syncEngine.getSession(task.lastSessionId);
        if (existing?.active && existing.thinking) {
          // Genuinely busy — Claude is actively generating a response.
          // Skip to avoid spawning duplicates (root cause of session pile-up).
          this.store.updateExecution(execution.id, {
            status: "skipped",
            completedAt: Date.now(),
            errorMessage:
              "Previous session still thinking — waiting for it to finish",
          });
          this.errorLogger?.info(
            `Skipped task "${task.name}" — last session ${task.lastSessionId} still thinking`,
            { category: "scheduler" }
          );
          return {
            success: false,
            execution: { ...execution, status: "skipped" },
            error: "Previous session still thinking",
            skipReason: "session-busy",
          };
        } else if (existing?.active && !existing.thinking) {
          // Session is active but idle (waiting for user input).
          sessionId = task.lastSessionId!;
          this.errorLogger?.info(
            `Task "${task.name}" sending to idle session ${sessionId}`,
            { category: "scheduler" }
          );

          // This branch is heartbeat-only (see the gate above), so the idle
          // session always takes the wait-for-response path. #2701 removed an
          // unreachable non-heartbeat fire-and-forget send that used to follow.
          this.store.updateExecution(execution.id, { sessionId });
          const result = await this.executeHeartbeatTask(
            task,
            sessionId,
            execution
          );
          this.store.updateLastSessionId(task.id, sessionId);
          return result;
        } else if (existing && !existing.active) {
          this.errorLogger?.info(
            `Task "${task.name}" attempting reconnect to session ${task.lastSessionId}`,
            { category: "scheduler" }
          );
          const reconnect = await this.syncEngine.reconnectSession(
            task.lastSessionId
          );
          if (reconnect.type === "success") {
            sessionId = reconnect.newSessionId;
            this.errorLogger?.info(
              `Task "${task.name}" reconnected to session ${sessionId}`,
              { category: "scheduler" }
            );
          } else {
            this.errorLogger?.info(
              `Task "${task.name}" reconnect failed: ${reconnect.message} — spawning fresh`,
              { category: "scheduler" }
            );
          }
        }
        // else: session not found in cache — fall through to spawn fresh
      }

      // ── Spawn fresh session if reconnect didn't work ──────────────
      if (!sessionId) {
        // Issue #1262/#1683 (claim-at-deploy): scheduled worktree tasks no
        // longer pre-claim a 3010-3019 slot at spawn; a worktree-mode task that
        // needs a running Hapimatic instance must deploy via hapi-worktree.sh
        // start like every other worktree. No-op for sessionType:"simple".
        // Issue #1565 (R5): the scheduler calls engine.spawnSession DIRECTLY, not
        // the HTTP /machines/:id/spawn route, so the route-level earlyReturn flag
        // never applies here — this stays the synchronous, throw-on-error path
        // below. Do NOT introduce earlyReturn/polling into the scheduler.
        const spawnResult = await this.syncEngine.spawnSession({
          machineId,
          directory: task.projectDirectory,
          yolo: true,
          claimPort: false,
          scheduleId: task.id,
          sessionType: task.sessionType ?? "simple",
          worktreeName:
            task.sessionType === "worktree"
              ? (task.worktreeBranchName ?? undefined)
              : undefined,
        });

        if (spawnResult.type === "error") {
          throw new Error(`Spawn failed: ${spawnResult.message}`);
        }

        sessionId = spawnResult.sessionId;

        // Set session name, emoji, and source only for fresh sessions
        await this.syncEngine.renameSession(sessionId, task.name);
        await this.syncEngine.updateSessionSource(
          sessionId,
          task.heartbeatMode ? "heartbeat" : "scheduler",
          task.heartbeatMode ? undefined : task.scheduleType,
          task.heartbeatMode ? undefined : task.id
        );
        if (task.emoji) {
          await this.syncEngine.updateSessionEmoji(sessionId, task.emoji);
        }

        this.errorLogger?.info(
          `Task "${task.name}" spawned session ${sessionId}`,
          { category: "scheduler" }
        );
      }

      this.store.updateExecution(execution.id, { sessionId });

      // ── Wait for session to become active ──────────────────────────
      await this.waitForSessionActive(sessionId);

      // ── Heartbeat tasks: wait-for-response path ────────────────────
      if (task.heartbeatMode) {
        const result = await this.executeHeartbeatTask(
          task,
          sessionId,
          execution
        );
        if (isRecurring) {
          this.store.updateLastSessionId(task.id, sessionId);
        }
        return result;
      }

      // ── Send the prompt (fire-and-forget for non-heartbeat) ────────
      await this.syncEngine.sendMessage(sessionId, {
        text: this.buildFullPrompt(task, execution.id),
        // #3124: programmatic scheduler send (was mislabeled "webapp").
        sentFrom: "scheduler",
      });

      this.errorLogger?.info(
        `Task "${task.name}" prompt sent to session ${sessionId}`,
        { category: "scheduler" }
      );

      // ── Store session ID for future reuse (heartbeat only) ─────────
      // Non-heartbeat recurring tasks always spawn fresh, so there's
      // no session to track for reuse.
      if (isRecurring && task.heartbeatMode) {
        this.store.updateLastSessionId(task.id, sessionId);
      }

      // ── Mark execution as delivered (fire-and-forget model) ─────────
      // The session will run autonomously. We don't monitor for
      // session completion here — the user can check the session.
      this.store.updateExecution(execution.id, {
        status: "delivered",
        completedAt: Date.now(),
      });

      // ── Notify ─────────────────────────────────────────────────────
      if (task.notifyOn === "completion" || task.notifyOn === "both") {
        await this.notify(task, "delivered", sessionId);
      }

      return {
        success: true,
        execution: { ...execution, status: "delivered", sessionId },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.store.updateExecution(execution.id, {
        status: "failed",
        completedAt: Date.now(),
        errorMessage: message,
      });

      this.errorLogger?.error(`Task "${task.name}" failed: ${message}`, {
        category: "scheduler",
        namespace: task.namespace,
      });

      if (task.notifyOn === "error" || task.notifyOn === "both") {
        await this.notify(task, "failed", null, message);
      }

      return {
        success: false,
        execution: { ...execution, status: "failed" },
        error: message,
      };
    }
  }

  // ── Heartbeat execution path ──────────────────────────────────────

  /**
   * Execute a heartbeat-mode task: send prompt, wait for response,
   * evaluate suppression, and send custom notification if needed.
   *
   * Unlike fire-and-forget tasks, heartbeat tasks monitor the response
   * to decide whether to push-notify the user.
   */
  private async executeHeartbeatTask(
    task: ScheduledTask,
    sessionId: string,
    execution: TaskExecution
  ): Promise<ExecutionResult> {
    // Register managed session (suppresses default ready notifications)
    this.notificationHub?.registerManagedSession(sessionId);

    try {
      // Build heartbeat prompt (drain system events + standing orders reference)
      const systemEvents = this.systemEventQueue?.drain() ?? [];
      const instructionsPath = task.standingOrders
        ? "(instructions stored in DB)"
        : "";
      const prompt = buildHeartbeatPrompt(systemEvents, instructionsPath);

      // Capture current message seq for response tracking
      const beforeMessages = this.syncEngine.getMessagesAfter(sessionId, {
        afterSeq: 0,
        limit: 1,
      });
      const beforeSeq =
        beforeMessages.length > 0
          ? (beforeMessages[beforeMessages.length - 1].seq ?? 0)
          : 0;

      // Send the prompt
      await this.syncEngine.sendMessage(sessionId, {
        text: prompt,
        // #3124: programmatic scheduler send, heartbeat-mode schedule (was
        // mislabeled "webapp"). The scheduler extension is the origin — the
        // separate `heartbeat` value belongs to the heartbeat SERVICE.
        sentFrom: "scheduler",
      });

      this.errorLogger?.info(
        `Heartbeat task "${task.name}" prompt sent to session ${sessionId}`,
        { category: "scheduler" }
      );

      // Wait for ready event (4.5 minute timeout)
      const response = await this.waitForHeartbeatResponse(
        sessionId,
        beforeSeq
      );

      // Evaluate suppression
      const isSuppressed = shouldSuppressResponse(
        response,
        task.ackMaxChars ?? 300
      );

      // Notify if not suppressed
      if (!isSuppressed && response) {
        const session = this.syncEngine.getSession(sessionId);
        const namespace = session?.namespace ?? task.namespace;
        // #4921: titled by the session, per-session tag, and a deep link that
        // resolves (was `/session/<id>`, a route that does not exist).
        await this.pushService.sendToNamespace(
          namespace,
          buildSessionPushPayload({
            kind: "heartbeat",
            type: "heartbeat",
            sessionId,
            sessionTitle: session ? getSessionName(session) : null,
            sessionEmoji: session?.emoji,
            body:
              response.length > 200
                ? response.substring(0, 197) + "..."
                : response,
          })
        );
      }

      // Mark as delivered
      this.store.updateExecution(execution.id, {
        status: "delivered",
        completedAt: Date.now(),
      });

      this.errorLogger?.info(
        `Heartbeat task "${task.name}" completed (suppressed: ${isSuppressed})`,
        { category: "scheduler" }
      );

      return {
        success: true,
        execution: { ...execution, status: "delivered", sessionId },
      };
    } finally {
      this.notificationHub?.unregisterManagedSession(sessionId);
    }
  }

  /**
   * Wait for the Claude session to emit a "ready" event (response complete).
   * Returns the extracted response text, or null on timeout.
   * Timeout: 4.5 minutes (under the 5-minute tick timeout).
   */
  private async waitForHeartbeatResponse(
    sessionId: string,
    afterSeq: number
  ): Promise<string | null> {
    return new Promise<string | null>(resolve => {
      let resolved = false;
      let timer: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      unsubscribe = this.syncEngine.subscribe((event: SyncEvent) => {
        if (resolved) return;

        if (
          event.type === "message-received" &&
          event.sessionId === sessionId
        ) {
          const eventType = extractMessageEventType(event);
          if (eventType === "ready") {
            resolved = true;
            cleanup();

            // Read response messages
            const messages = this.syncEngine.getMessagesAfter(sessionId, {
              afterSeq,
              limit: 100,
            });

            resolve(extractResponseText(messages) || null);
          }
        }
      });

      // Timeout: 4.5 minutes
      timer = setTimeout(
        () => {
          if (!resolved) {
            resolved = true;
            cleanup();
            this.errorLogger?.warn(
              `Heartbeat response timeout for session ${sessionId}`,
              { category: "scheduler", sessionId }
            );
            resolve(null);
          }
        },
        4.5 * 60 * 1000
      );
    });
  }

  /**
   * Poll until session.active === true or timeout.
   * Uses exponential backoff: 500ms, 1s, 2s, 4s...
   */
  private async waitForSessionActive(sessionId: string): Promise<void> {
    const deadline = Date.now() + SESSION_ACTIVE_TIMEOUT_MS;
    let interval = SESSION_POLL_INTERVAL_MS;

    while (Date.now() < deadline) {
      const session = this.syncEngine.getSession(sessionId);
      if (session?.active) return;

      await new Promise(resolve => setTimeout(resolve, interval));
      interval = Math.min(interval * 2, 5000);
    }

    throw new Error(
      `Session ${sessionId} did not become active within ${SESSION_ACTIVE_TIMEOUT_MS}ms`
    );
  }

  /**
   * Build the full prompt for a non-heartbeat spawn: pre-work, user prompt,
   * the system completion signal for THIS execution, then the user's closing
   * block (#2701). Assembly lives in `assembleScheduledPrompt` so it is
   * unit-testable without a live executor.
   */
  private buildFullPrompt(task: ScheduledTask, executionId: string): string {
    return assembleScheduledPrompt(task, executionId);
  }

  /**
   * The cap-pressure gate (#2703). Returns a skipped result when the LOCAL
   * node is under pressure and `machineId` is this node's machine, else null.
   * Fails open: an unavailable reading, another machine, or an unknown local
   * machine id all spawn normally — the daemon's hard cap still protects the
   * node. Consecutive cap-pressure skips of one task coalesce into one row
   * (R7): the episode's first row keeps its `created_at`; only its
   * `completed_at` and message are refreshed, so #4033's re-arm (latest row
   * `skipped`) and creation-run readers (`MIN(created_at)`) are unaffected.
   */
  private async deferUnderCapPressure(
    task: ScheduledTask,
    machineId: string,
    pressure: PressureReader | undefined,
    now: number
  ): Promise<ExecutionResult | null> {
    const readPressure =
      pressure ??
      this.capPressure.readPressure ??
      (() => readCapPressure(defaultPressureDeps()));
    let reading: PressureReading;
    try {
      reading = await readPressure();
    } catch {
      return null; // fail open
    }
    if (!isPressureOnMachine(reading, machineId) || !reading.available) {
      return null;
    }

    const errorMessage = `${CAP_PRESSURE_SKIP_PREFIX} (${reading.effectiveCount}/${reading.maxConcurrent} live, floor ${reading.floor}) — yielding the slot to interactive work`;
    const latest = this.store.getExecutionHistory(task.id, 1)[0];
    let execution: TaskExecution;
    if (latest && isCapPressureSkip(latest)) {
      execution = latest;
      this.store.updateExecution(execution.id, {
        completedAt: Date.now(),
        errorMessage,
      });
      this.errorLogger?.info(
        `Deferred task "${task.name}" — cap pressure continues (${reading.effectiveCount}/${reading.maxConcurrent} live); coalesced into execution ${execution.id}`,
        { category: "scheduler" }
      );
    } else {
      execution = this.store.createExecution(task.id, now);
      this.store.updateExecution(execution.id, {
        status: "skipped",
        completedAt: Date.now(),
        errorMessage,
      });
      this.errorLogger?.warn(
        `Deferred task "${task.name}" — cap pressure (${reading.effectiveCount}/${reading.maxConcurrent} live, floor ${reading.floor}); yielding to interactive work`,
        { category: "scheduler" }
      );
    }
    return {
      success: false,
      execution: { ...execution, status: "skipped", errorMessage },
      error: "Cap pressure — deferred",
      skipReason: "cap-pressure",
    };
  }

  /**
   * Check Pi CPU temperature. Returns { blocked, tempC }.
   * Non-blocking — if vcgencmd isn't available, allows execution.
   */
  private async checkThermal(): Promise<{
    blocked: boolean;
    tempC: number | null;
  }> {
    try {
      const { stdout } = await execAsync("vcgencmd measure_temp");
      const match = stdout.match(/temp=([\d.]+)/);
      if (!match) return { blocked: false, tempC: null };

      const tempC = parseFloat(match[1]);
      return {
        blocked: tempC > THERMAL_THRESHOLD_C,
        tempC,
      };
    } catch {
      // vcgencmd not available (not a Pi, or restricted)
      return { blocked: false, tempC: null };
    }
  }

  /** Send a push notification about task execution */
  private async notify(
    task: ScheduledTask,
    status: "delivered" | "failed",
    sessionId: string | null,
    errorMessage?: string
  ): Promise<void> {
    try {
      const title =
        status === "delivered"
          ? `Scheduled task delivered: ${task.name}`
          : `Scheduled task failed: ${task.name}`;

      const body =
        status === "delivered"
          ? `Task "${task.name}" prompt delivered to session.`
          : `Task "${task.name}" failed: ${errorMessage ?? "Unknown error"}`;

      if (sessionId) {
        // #4921: a session-targeted task push is titled by its session, with
        // the status word leading the body, and opens the session.
        const session = this.syncEngine.getSession(sessionId);
        await this.pushService.sendToNamespace(
          task.namespace,
          buildSessionPushPayload({
            kind: "scheduled-task",
            type: "scheduled-task",
            sessionId,
            sessionTitle: session ? getSessionName(session) : null,
            sessionEmoji: session?.emoji,
            body: `${status === "delivered" ? "Delivered" : "Failed"}: ${body}`,
          })
        );
      } else {
        await this.pushService.sendToNamespace(task.namespace, {
          title,
          body,
          tag: `scheduler-${task.id}`,
          data: { type: "scheduled-task", url: "/" },
        });
      }
    } catch (error) {
      this.errorLogger?.error(
        `Failed to send notification for task "${task.name}"`,
        {
          category: "scheduler",
          context: {
            error: error instanceof Error ? error.message : String(error),
          },
        }
      );
    }
  }
}
