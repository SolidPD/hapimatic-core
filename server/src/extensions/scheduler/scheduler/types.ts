// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scheduler System Types
 *
 * Type definitions for the scheduled task execution engine.
 * Maps directly to the SQLite `scheduled_tasks` and `task_executions` tables.
 */

export type ScheduleKind = "at" | "every" | "cron";
export type OverlapPolicy = "skip" | "queue" | "allow";
export type NotifyOn = "completion" | "error" | "both" | "none";
/**
 * Execution status — the CLOSED set enforced by the executions-table CHECK
 * (settled once by #2701, epic #2698 F5):
 *   - `completed` — the session DECLARED its work done via the completion
 *     endpoint. Only that endpoint writes it; no reaper pass overwrites it.
 *   - `timed_out` — an involuntary end (ceiling, idle, pressure, found
 *     inactive, startup recovery).
 * How the slot was freed is recorded separately in `reapedAt`/`reapReason`,
 * so later reaper layers need no new status value (and no new migration).
 */
export type ExecutionStatus =
  | "pending"
  | "running"
  | "delivered"
  | "failed"
  | "timed_out"
  | "skipped"
  | "completed";

/**
 * Why the reaper freed (or settled) an execution's session slot. A TS union
 * with NO DB CHECK, so a new layer adds a reason without a migration.
 * `completed` = reaped after a completion signal; `completed_grace` = force-
 * reaped because it stayed busy past COMPLETED_REAP_GRACE_MS after signaling;
 * `ceiling` = maxRuntimeMs (L3); `idle` = L2; `pressure` = L4; `inactive` =
 * the session was already gone when the reaper looked.
 */
export type ReapReason =
  | "completed"
  | "completed_grace"
  | "ceiling"
  | "idle"
  | "pressure"
  | "inactive";

/** A scheduled task as stored in the database */
export type ScheduledTask = {
  id: string;
  name: string;
  emoji: string | null;
  prompt: string;
  projectDirectory: string;

  // Schedule definition
  scheduleType: ScheduleKind;
  cronExpression: string | null;
  scheduledAt: number | null;
  intervalMs: number | null;
  timezone: string;

  // Configuration
  enabled: boolean;
  deleteAfterRun: boolean;
  maxRuntimeMs: number | null;
  notifyOn: NotifyOn;
  overlapPolicy: OverlapPolicy;

  // Error handling
  consecutiveErrors: number;

  // Session reuse (recurring tasks reconnect to the same session)
  lastSessionId: string | null;

  // Metadata
  namespace: string;
  createdAt: number;
  updatedAt: number;
  lastExecutedAt: number | null;
  nextExecutionAt: number | null;

  // 5-Layer Temporal Model
  operatingSchedule: string | null;
  exclusionSchedule: string | null;
  lifetimeStart: number | null;
  lifetimeEnd: number | null;
  eventCountLimit: number | null;
  eventCountCurrent: number;
  jitterMaxMs: number | null;
  heartbeatMode: boolean;
  standingOrders: string | null;
  preWorkInstructions: string | null;
  closingInstructions: string | null;
  ackMaxChars: number | null;
  rotationConfig: string | null;
  backoffConfig: string | null;
  runOnceAtCreation: boolean;
  dstAdjustment: string | null;

  // Session configuration
  sessionType: "simple" | "worktree";
  worktreeBranchName: string | null;
};

/** A single execution record for a scheduled task */
export type TaskExecution = {
  id: string;
  taskId: string;
  sessionId: string | null;

  scheduledFor: number;
  startedAt: number | null;
  completedAt: number | null;

  status: ExecutionStatus;
  errorMessage: string | null;

  createdAt: number;

  /** Set once when the reaper freed or settled the slot (#2701). */
  reapedAt?: number | null;
  reapReason?: ReapReason | null;
};

/** Input for creating a new scheduled task */
export type CreateScheduledTask = {
  name: string;
  emoji?: string;
  prompt: string;
  projectDirectory: string;
  scheduleType: ScheduleKind;
  cronExpression?: string;
  scheduledAt?: number;
  intervalMs?: number;
  timezone?: string;
  deleteAfterRun?: boolean;
  maxRuntimeMs?: number;
  notifyOn?: NotifyOn;
  overlapPolicy?: OverlapPolicy;
  // 5-Layer Temporal Model (all optional for creation)
  operatingSchedule?: string;
  exclusionSchedule?: string;
  lifetimeStart?: number;
  lifetimeEnd?: number;
  eventCountLimit?: number;
  jitterMaxMs?: number;
  heartbeatMode?: boolean;
  standingOrders?: string;
  preWorkInstructions?: string;
  closingInstructions?: string;
  ackMaxChars?: number;
  rotationConfig?: string;
  backoffConfig?: string;
  runOnceAtCreation?: boolean;
  dstAdjustment?: string;
  sessionType?: "simple" | "worktree";
  worktreeBranchName?: string;
};

/** Input for updating an existing scheduled task */
export type UpdateScheduledTask = Partial<
  Omit<CreateScheduledTask, "maxRuntimeMs" | "emoji" | "worktreeBranchName">
> & {
  enabled?: boolean;
  emoji?: string | null;
  maxRuntimeMs?: number | null;
  eventCountCurrent?: number;
  worktreeBranchName?: string | null;
};

/** Backoff delays (ms) indexed by consecutive error count */
export const BACKOFF_DELAYS_MS = [
  0, // 0 errors: no delay
  30_000, // 1st error: 30 seconds
  60_000, // 2nd error: 1 minute
  300_000, // 3rd error: 5 minutes
  900_000, // 4th error: 15 minutes
  3_600_000, // 5th+ error: 60 minutes
] as const;

/**
 * Startup-recovery age threshold: 2 hours. Heartbeat and session-less rows
 * older than this are settled at start; other rows are deferred to the reapers
 * (#4111). NOT a runtime ceiling — see SCHEDULED_SESSION_DEFAULT_MAX_RUNTIME_MS.
 */
export const STUCK_RUN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Grace period for catching up missed one-shot tasks on startup */
export const MISSED_TASK_GRACE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Defer window for a skipped one-shot run (#4033). A run skipped by an
 * executor gate is re-armed each tick until `anchor + ONESHOT_DEFER_WINDOW_MS`,
 * then recorded as dropped. The anchor is `scheduledAt` for an `at` task and
 * `createdAt` for a run_once_at_creation run — both durable columns, so the
 * budget survives restarts without a migration. Reuses the catch-up grace
 * policy: a one-shot is still worth running up to 1h late.
 */
export const ONESHOT_DEFER_WINDOW_MS = MISSED_TASK_GRACE_MS;

/** Default scheduler tick interval */
export const TICK_INTERVAL_MS = 30_000; // 30 seconds

/** Max concurrent scheduled task runs (Pi resource constraint) */
export const MAX_CONCURRENT_RUNS = 1;

/** Pi thermal threshold — skip spawning above this temperature */
export const THERMAL_THRESHOLD_C = 80;

/** How often to run the session reaper (every N ticks ≈ N × 30s) */
export const REAPER_TICK_INTERVAL = 2;

/**
 * How long after scheduler start "inactive" does not yet mean "gone" (#4111).
 * After a restart, session `active` is seeded from the (unreliable) DB column,
 * `expireInactive` flips stale sessions within 10–30 s, and live CLIs re-flip
 * only on reconnect (1–5 s backoff) + keepAlive. Until this grace has passed,
 * no pass may settle a row as `inactive` without archiving it. Waiting only
 * delays bookkeeping: a dead row holds no slot, because the concurrency and
 * overlap gates check liveness in memory.
 */
export const SCHEDULER_BOOT_LIVENESS_GRACE_MS = 5 * 60 * 1000; // 5 minutes

/**
 * How long a `completed` execution may stay unsafe to reap (thinking, blocked,
 * rate-limited) before it is force-reaped. Keeps a signaled row bounded even
 * when no maxRuntimeMs ceiling is set (#2701, review finding 2701-2).
 */
export const COMPLETED_REAP_GRACE_MS = 30 * 60 * 1000; // 30 minutes

/** Default L2 idle-reap threshold: 15 minutes of continuous idle (#2702). */
export const DEFAULT_SCHEDULER_IDLE_REAP_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Parse an idle-threshold override. Anything that is not a positive finite
 * number (unset, empty, zero, negative, non-numeric) falls back to the
 * default, so a bad value can never make every idle session reapable at once.
 */
export function resolveIdleReapThresholdMs(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SCHEDULER_IDLE_REAP_THRESHOLD_MS;
}

/**
 * How long a scheduler-spawned session must stay continuously safe to reap
 * (live, not thinking, not blocked, not rate-limited) before the L2 idle pass
 * reaps it without a completion signal (#2702, epic #2698). `session_idle`
 * fires between every turn, so only sustained idle counts. Conservative so a
 * session paused between phases is not cut off; maxRuntimeMs (L3) remains the
 * absolute ceiling. Override: `HAPI_SCHEDULER_IDLE_REAP_THRESHOLD_MS` (ms),
 * read once at startup. The single constant later layers (#2703) reuse.
 */
export const SCHEDULER_IDLE_REAP_THRESHOLD_MS = resolveIdleReapThresholdMs(
  process.env.HAPI_SCHEDULER_IDLE_REAP_THRESHOLD_MS
);

/** Default L3 runtime ceiling for a task with no explicit maxRuntimeMs (#2699). */
export const DEFAULT_SCHEDULED_SESSION_MAX_RUNTIME_MS = 4 * 60 * 60 * 1000;

/**
 * Parse a default-ceiling override — the same safe-fallback shape as
 * `resolveIdleReapThresholdMs`: anything that is not a positive finite number
 * falls back to the default, so a bad value can never make every scheduled
 * session instantly stale.
 */
export function resolveScheduledSessionDefaultMaxRuntimeMs(
  raw: string | undefined
): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SCHEDULED_SESSION_MAX_RUNTIME_MS;
}

/**
 * The runtime ceiling the stale-session reaper applies to a task whose
 * `maxRuntimeMs` is null (#2699, epic #2698 L3). An absolute backstop for
 * stuck or runaway sessions, not a completion detector: biased high because
 * the L1 completion signal (#2701) and L2 idle reap (#2702) free slots sooner.
 * An explicit per-task `maxRuntimeMs` always wins; heartbeat tasks never get
 * this default (their session is reused across runs). Override:
 * `HAPI_SCHEDULER_DEFAULT_MAX_RUNTIME_MS` (ms), read once at startup.
 */
export const SCHEDULED_SESSION_DEFAULT_MAX_RUNTIME_MS =
  resolveScheduledSessionDefaultMaxRuntimeMs(
    process.env.HAPI_SCHEDULER_DEFAULT_MAX_RUNTIME_MS
  );

/** Default L4 cap-pressure headroom: slots kept free for interactive work (#2703). */
export const DEFAULT_SCHEDULER_CAP_PRESSURE_HEADROOM = 2;

/**
 * Parse a cap-pressure headroom override. Unset or blank falls back to the
 * default — explicitly, because `Number("")` is 0 and a blank env var must not
 * silently mean "headroom 0". Otherwise any integer ≥ 0 is accepted; anything
 * else (negative, fractional, non-numeric) falls back to the default.
 */
export function resolveCapPressureHeadroom(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SCHEDULER_CAP_PRESSURE_HEADROOM;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0
    ? value
    : DEFAULT_SCHEDULER_CAP_PRESSURE_HEADROOM;
}

/**
 * How many of the node's session slots scheduled work leaves free for
 * interactive / PM sessions (#2703, epic #2698 L4). The local node is under
 * cap pressure once `effectiveCount >= max(1, maxConcurrent - headroom)`; the
 * floor of 1 means an empty node is never under pressure, however small its
 * cap. `0` means "pressure only at the hard cap", which disables L4 in
 * practice. Override: `HAPI_SCHEDULER_CAP_PRESSURE_HEADROOM` (integer ≥ 0),
 * read once at startup.
 */
export const SCHEDULER_CAP_PRESSURE_HEADROOM = resolveCapPressureHeadroom(
  process.env.HAPI_SCHEDULER_CAP_PRESSURE_HEADROOM
);

/** Default L4 pressure idle-reap threshold: 3 minutes of continuous idle (#2703). */
export const DEFAULT_SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS = 3 * 60 * 1000;

/**
 * Parse a pressure idle-threshold override — the same safe-fallback shape as
 * `resolveIdleReapThresholdMs`: anything that is not a positive finite number
 * falls back to the default.
 */
export function resolvePressureIdleReapThresholdMs(
  raw: string | undefined
): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS;
}

/**
 * The shorter continuous-idle threshold the L2 idle pass uses while the local
 * node is under sustained cap pressure (#2703). The effective threshold is
 * `min(pressure, steady)`, so pressure can never make reaping slower: a value
 * at or above `SCHEDULER_IDLE_REAP_THRESHOLD_MS` disables accelerated reaping
 * (SessionReaper warns once). Override:
 * `HAPI_SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS` (ms), read once at startup.
 */
export const SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS =
  resolvePressureIdleReapThresholdMs(
    process.env.HAPI_SCHEDULER_IDLE_REAP_THRESHOLD_PRESSURE_MS
  );

/** A `completed` execution whose session has not been reaped yet (#2701) */
export type CompletedExecution = {
  executionId: string;
  sessionId: string;
  taskId: string;
  taskName: string;
  completedAt: number;
};

/** A one-shot task disabled at spawn and awaiting deferred deletion (#2701) */
export type ConsumedOneShot = {
  taskId: string;
  namespace: string;
  name: string;
};

/** An execution resolved together with the task fields its callers need */
export type ExecutionWithTask = {
  execution: TaskExecution;
  taskNamespace: string;
  taskName: string;
  heartbeatMode: boolean;
};

/** A stale execution that has exceeded its task's maxRuntimeMs */
export type StaleExecution = {
  executionId: string;
  sessionId: string;
  taskId: string;
  taskName: string;
  startedAt: number;
  maxRuntimeMs: number;
};
