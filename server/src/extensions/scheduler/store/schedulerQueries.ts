// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Scheduler SQL Queries
 *
 * Pure query functions operating on the scheduler extension's two tables. Each
 * function receives a Database instance — no side effects beyond SQL.
 *
 * Table names come from `../tableNames` and are interpolated into every
 * statement rather than written inline, so the migration and the query layer
 * cannot drift apart (#1274). They are module constants, never user input.
 *
 * Pattern: follows server/src/store/timeLog.ts
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type {
  CompletedExecution,
  ConsumedOneShot,
  CreateScheduledTask,
  ExecutionStatus,
  ExecutionWithTask,
  ReapReason,
  ScheduledTask,
  StaleExecution,
  TaskExecution,
  UpdateScheduledTask,
} from "../scheduler/types";
import { SCHEDULED_SESSION_DEFAULT_MAX_RUNTIME_MS } from "../scheduler/types";
import { SCHEDULER_EXECS_TABLE, SCHEDULER_TASKS_TABLE } from "../tableNames";

// ── DB row types (snake_case) ──────────────────────────────────────────

type DbScheduledTaskRow = {
  id: string;
  name: string;
  emoji: string | null;
  prompt: string;
  project_directory: string;
  schedule_type: string;
  cron_expression: string | null;
  scheduled_at: number | null;
  interval_ms: number | null;
  timezone: string;
  enabled: number;
  delete_after_run: number;
  max_runtime_ms: number | null;
  notify_on: string;
  overlap_policy: string;
  consecutive_errors: number;
  last_session_id: string | null;
  namespace: string;
  created_at: number;
  updated_at: number;
  last_executed_at: number | null;
  next_execution_at: number | null;
  // 5-Layer Temporal Model fields
  operating_schedule: string | null;
  exclusion_schedule: string | null;
  lifetime_start: number | null;
  lifetime_end: number | null;
  event_count_limit: number | null;
  event_count_current: number;
  jitter_max_ms: number | null;
  heartbeat_mode: number;
  standing_orders: string | null;
  pre_work_instructions: string | null;
  closing_instructions: string | null;
  ack_max_chars: number | null;
  rotation_config: string | null;
  backoff_config: string | null;
  run_once_at_launch: number;
  dst_adjustment: string | null;
  session_type: string | null;
  worktree_branch_name: string | null;
};

type DbTaskExecutionRow = {
  id: string;
  task_id: string;
  session_id: string | null;
  scheduled_for: number;
  started_at: number | null;
  completed_at: number | null;
  status: string;
  error_message: string | null;
  created_at: number;
  reaped_at: number | null;
  reap_reason: string | null;
};

// ── Row mappers ────────────────────────────────────────────────────────

function toScheduledTask(row: DbScheduledTaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    prompt: row.prompt,
    projectDirectory: row.project_directory,
    scheduleType: row.schedule_type as ScheduledTask["scheduleType"],
    cronExpression: row.cron_expression,
    scheduledAt: row.scheduled_at,
    intervalMs: row.interval_ms,
    timezone: row.timezone,
    enabled: row.enabled === 1,
    deleteAfterRun: row.delete_after_run === 1,
    maxRuntimeMs: row.max_runtime_ms,
    notifyOn: row.notify_on as ScheduledTask["notifyOn"],
    overlapPolicy: row.overlap_policy as ScheduledTask["overlapPolicy"],
    consecutiveErrors: row.consecutive_errors,
    lastSessionId: row.last_session_id,
    namespace: row.namespace,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastExecutedAt: row.last_executed_at,
    nextExecutionAt: row.next_execution_at,
    // 5-Layer Temporal Model
    operatingSchedule: row.operating_schedule,
    exclusionSchedule: row.exclusion_schedule,
    lifetimeStart: row.lifetime_start,
    lifetimeEnd: row.lifetime_end,
    eventCountLimit: row.event_count_limit,
    eventCountCurrent: row.event_count_current ?? 0,
    jitterMaxMs: row.jitter_max_ms,
    heartbeatMode: (row.heartbeat_mode ?? 0) === 1,
    standingOrders: row.standing_orders,
    preWorkInstructions: row.pre_work_instructions,
    closingInstructions: row.closing_instructions,
    ackMaxChars: row.ack_max_chars,
    rotationConfig: row.rotation_config,
    backoffConfig: row.backoff_config,
    runOnceAtCreation: (row.run_once_at_launch ?? 0) === 1,
    dstAdjustment: row.dst_adjustment,
    sessionType: (row.session_type as "simple" | "worktree") ?? "simple",
    worktreeBranchName: row.worktree_branch_name,
  };
}

function toTaskExecution(row: DbTaskExecutionRow): TaskExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    status: row.status as TaskExecution["status"],
    errorMessage: row.error_message,
    createdAt: row.created_at,
    reapedAt: row.reaped_at ?? null,
    reapReason: (row.reap_reason as ReapReason | null) ?? null,
  };
}

// ── Task CRUD ──────────────────────────────────────────────────────────

export function createTask(
  db: Database,
  input: CreateScheduledTask,
  namespace: string
): ScheduledTask {
  const now = Date.now();
  const id = randomUUID();

  db.prepare(
    `
    INSERT INTO ${SCHEDULER_TASKS_TABLE} (
      id, name, emoji, prompt, project_directory,
      schedule_type, cron_expression, scheduled_at, interval_ms, timezone,
      enabled, delete_after_run, max_runtime_ms, notify_on, overlap_policy,
      consecutive_errors, namespace, created_at, updated_at,
      last_executed_at, next_execution_at,
      operating_schedule, exclusion_schedule, lifetime_start, lifetime_end,
      event_count_limit, event_count_current, jitter_max_ms, heartbeat_mode,
      standing_orders, pre_work_instructions, closing_instructions,
      ack_max_chars, rotation_config, backoff_config,
      run_once_at_launch, dst_adjustment,
      session_type, worktree_branch_name
    ) VALUES (
      @id, @name, @emoji, @prompt, @project_directory,
      @schedule_type, @cron_expression, @scheduled_at, @interval_ms, @timezone,
      @enabled, @delete_after_run, @max_runtime_ms, @notify_on, @overlap_policy,
      0, @namespace, @created_at, @updated_at,
      NULL, NULL,
      @operating_schedule, @exclusion_schedule, @lifetime_start, @lifetime_end,
      @event_count_limit, 0, @jitter_max_ms, @heartbeat_mode,
      @standing_orders, @pre_work_instructions, @closing_instructions,
      @ack_max_chars, @rotation_config, @backoff_config,
      @run_once_at_launch, @dst_adjustment,
      @session_type, @worktree_branch_name
    )
    `
  ).run({
    id,
    name: input.name,
    emoji: input.emoji ?? null,
    prompt: input.prompt,
    project_directory: input.projectDirectory,
    schedule_type: input.scheduleType,
    cron_expression: input.cronExpression ?? null,
    scheduled_at: input.scheduledAt ?? null,
    interval_ms: input.intervalMs ?? null,
    timezone: input.timezone ?? "America/New_York",
    enabled: 1,
    delete_after_run: input.deleteAfterRun ? 1 : 0,
    max_runtime_ms: input.maxRuntimeMs ?? null,
    notify_on: input.notifyOn ?? "both",
    overlap_policy: input.overlapPolicy ?? "skip",
    namespace,
    created_at: now,
    updated_at: now,
    operating_schedule: input.operatingSchedule ?? null,
    exclusion_schedule: input.exclusionSchedule ?? null,
    lifetime_start: input.lifetimeStart ?? null,
    lifetime_end: input.lifetimeEnd ?? null,
    event_count_limit: input.eventCountLimit ?? null,
    jitter_max_ms: input.jitterMaxMs ?? null,
    heartbeat_mode: input.heartbeatMode ? 1 : 0,
    standing_orders: input.standingOrders ?? null,
    pre_work_instructions: input.preWorkInstructions ?? null,
    closing_instructions: input.closingInstructions ?? null,
    ack_max_chars: input.ackMaxChars ?? null,
    rotation_config: input.rotationConfig ?? null,
    backoff_config: input.backoffConfig ?? null,
    run_once_at_launch: input.runOnceAtCreation ? 1 : 0,
    dst_adjustment: input.dstAdjustment ?? null,
    session_type: input.sessionType ?? "simple",
    worktree_branch_name: input.worktreeBranchName ?? null,
  });

  return getTask(db, id, namespace)!;
}

export function getTask(
  db: Database,
  id: string,
  namespace: string
): ScheduledTask | null {
  const row = db
    .prepare(
      `SELECT * FROM ${SCHEDULER_TASKS_TABLE} WHERE id = ? AND namespace = ?`
    )
    .get(id, namespace) as DbScheduledTaskRow | undefined;
  return row ? toScheduledTask(row) : null;
}

export function getAllTasks(db: Database, namespace: string): ScheduledTask[] {
  const rows = db
    .prepare(
      `SELECT * FROM ${SCHEDULER_TASKS_TABLE} WHERE namespace = ? ORDER BY created_at DESC`
    )
    .all(namespace) as DbScheduledTaskRow[];
  return rows.map(toScheduledTask);
}

export function getEnabledTasks(db: Database): ScheduledTask[] {
  const rows = db
    .prepare(`SELECT * FROM ${SCHEDULER_TASKS_TABLE} WHERE enabled = 1`)
    .all() as DbScheduledTaskRow[];
  return rows.map(toScheduledTask);
}

export function updateTask(
  db: Database,
  id: string,
  input: UpdateScheduledTask,
  namespace: string
): ScheduledTask | null {
  const existing = getTask(db, id, namespace);
  if (!existing) return null;

  const now = Date.now();
  const setClauses: string[] = ["updated_at = @updated_at"];
  const params: Record<string, string | number | null> = {
    id,
    namespace,
    updated_at: now,
  };

  if (input.name !== undefined) {
    setClauses.push("name = @name");
    params.name = input.name;
  }
  if (input.emoji !== undefined) {
    setClauses.push("emoji = @emoji");
    params.emoji = input.emoji ?? null;
  }
  if (input.prompt !== undefined) {
    setClauses.push("prompt = @prompt");
    params.prompt = input.prompt;
  }
  if (input.projectDirectory !== undefined) {
    setClauses.push("project_directory = @project_directory");
    params.project_directory = input.projectDirectory;
  }
  if (input.scheduleType !== undefined) {
    setClauses.push("schedule_type = @schedule_type");
    params.schedule_type = input.scheduleType;
  }
  if (input.cronExpression !== undefined) {
    setClauses.push("cron_expression = @cron_expression");
    params.cron_expression = input.cronExpression;
  }
  if (input.scheduledAt !== undefined) {
    setClauses.push("scheduled_at = @scheduled_at");
    params.scheduled_at = input.scheduledAt;
  }
  if (input.intervalMs !== undefined) {
    setClauses.push("interval_ms = @interval_ms");
    params.interval_ms = input.intervalMs;
  }
  if (input.timezone !== undefined) {
    setClauses.push("timezone = @timezone");
    params.timezone = input.timezone;
  }
  if (input.enabled !== undefined) {
    setClauses.push("enabled = @enabled");
    params.enabled = input.enabled ? 1 : 0;
  }
  if (input.deleteAfterRun !== undefined) {
    setClauses.push("delete_after_run = @delete_after_run");
    params.delete_after_run = input.deleteAfterRun ? 1 : 0;
  }
  if (input.maxRuntimeMs !== undefined) {
    setClauses.push("max_runtime_ms = @max_runtime_ms");
    params.max_runtime_ms = input.maxRuntimeMs ?? null;
  }
  if (input.notifyOn !== undefined) {
    setClauses.push("notify_on = @notify_on");
    params.notify_on = input.notifyOn;
  }
  if (input.overlapPolicy !== undefined) {
    setClauses.push("overlap_policy = @overlap_policy");
    params.overlap_policy = input.overlapPolicy;
  }
  if (input.operatingSchedule !== undefined) {
    setClauses.push("operating_schedule = @operating_schedule");
    params.operating_schedule = input.operatingSchedule ?? null;
  }
  if (input.exclusionSchedule !== undefined) {
    setClauses.push("exclusion_schedule = @exclusion_schedule");
    params.exclusion_schedule = input.exclusionSchedule ?? null;
  }
  if (input.lifetimeStart !== undefined) {
    setClauses.push("lifetime_start = @lifetime_start");
    params.lifetime_start = input.lifetimeStart ?? null;
  }
  if (input.lifetimeEnd !== undefined) {
    setClauses.push("lifetime_end = @lifetime_end");
    params.lifetime_end = input.lifetimeEnd ?? null;
  }
  if (input.eventCountLimit !== undefined) {
    setClauses.push("event_count_limit = @event_count_limit");
    params.event_count_limit = input.eventCountLimit ?? null;
  }
  if (input.eventCountCurrent !== undefined) {
    setClauses.push("event_count_current = @event_count_current");
    params.event_count_current = input.eventCountCurrent;
  }
  if (input.jitterMaxMs !== undefined) {
    setClauses.push("jitter_max_ms = @jitter_max_ms");
    params.jitter_max_ms = input.jitterMaxMs ?? null;
  }
  if (input.heartbeatMode !== undefined) {
    setClauses.push("heartbeat_mode = @heartbeat_mode");
    params.heartbeat_mode = input.heartbeatMode ? 1 : 0;
  }
  if (input.standingOrders !== undefined) {
    setClauses.push("standing_orders = @standing_orders");
    params.standing_orders = input.standingOrders ?? null;
  }
  if (input.preWorkInstructions !== undefined) {
    setClauses.push("pre_work_instructions = @pre_work_instructions");
    params.pre_work_instructions = input.preWorkInstructions ?? null;
  }
  if (input.closingInstructions !== undefined) {
    setClauses.push("closing_instructions = @closing_instructions");
    params.closing_instructions = input.closingInstructions ?? null;
  }
  if (input.ackMaxChars !== undefined) {
    setClauses.push("ack_max_chars = @ack_max_chars");
    params.ack_max_chars = input.ackMaxChars ?? null;
  }
  if (input.rotationConfig !== undefined) {
    setClauses.push("rotation_config = @rotation_config");
    params.rotation_config = input.rotationConfig ?? null;
  }
  if (input.backoffConfig !== undefined) {
    setClauses.push("backoff_config = @backoff_config");
    params.backoff_config = input.backoffConfig ?? null;
  }
  if (input.runOnceAtCreation !== undefined) {
    setClauses.push("run_once_at_launch = @run_once_at_launch");
    params.run_once_at_launch = input.runOnceAtCreation ? 1 : 0;
  }
  if (input.dstAdjustment !== undefined) {
    setClauses.push("dst_adjustment = @dst_adjustment");
    params.dst_adjustment = input.dstAdjustment ?? null;
  }
  if (input.sessionType !== undefined) {
    setClauses.push("session_type = @session_type");
    params.session_type = input.sessionType;
  }
  if (input.worktreeBranchName !== undefined) {
    setClauses.push("worktree_branch_name = @worktree_branch_name");
    params.worktree_branch_name = input.worktreeBranchName ?? null;
  }

  db.prepare(
    `UPDATE ${SCHEDULER_TASKS_TABLE} SET ${setClauses.join(", ")} WHERE id = @id AND namespace = @namespace`
  ).run(params);

  return getTask(db, id, namespace);
}

export function deleteTask(
  db: Database,
  id: string,
  namespace: string
): boolean {
  const result = db
    .prepare(
      `DELETE FROM ${SCHEDULER_TASKS_TABLE} WHERE id = ? AND namespace = ?`
    )
    .run(id, namespace);
  return result.changes > 0;
}

export function toggleTask(
  db: Database,
  id: string,
  namespace: string
): ScheduledTask | null {
  const existing = getTask(db, id, namespace);
  if (!existing) return null;

  const now = Date.now();
  const newEnabled = existing.enabled ? 0 : 1;

  db.prepare(
    `UPDATE ${SCHEDULER_TASKS_TABLE} SET enabled = @enabled, updated_at = @updated_at WHERE id = @id AND namespace = @namespace`
  ).run({ id, namespace, enabled: newEnabled, updated_at: now });

  return getTask(db, id, namespace);
}

export function updateNextExecution(
  db: Database,
  id: string,
  nextExecutionAt: number | null
): void {
  db.prepare(
    `UPDATE ${SCHEDULER_TASKS_TABLE} SET next_execution_at = @next, updated_at = @now WHERE id = @id`
  ).run({ id, next: nextExecutionAt, now: Date.now() });
}

export function updateLastExecuted(
  db: Database,
  id: string,
  lastExecutedAt: number
): void {
  db.prepare(
    `UPDATE ${SCHEDULER_TASKS_TABLE} SET last_executed_at = @last, updated_at = @now WHERE id = @id`
  ).run({ id, last: lastExecutedAt, now: Date.now() });
}

export function updateConsecutiveErrors(
  db: Database,
  id: string,
  count: number
): void {
  db.prepare(
    `UPDATE ${SCHEDULER_TASKS_TABLE} SET consecutive_errors = @count, updated_at = @now WHERE id = @id`
  ).run({ id, count, now: Date.now() });
}

export function updateLastSessionId(
  db: Database,
  id: string,
  sessionId: string | null
): void {
  db.prepare(
    `UPDATE ${SCHEDULER_TASKS_TABLE} SET last_session_id = @sid, updated_at = @now WHERE id = @id`
  ).run({ id, sid: sessionId, now: Date.now() });
}

export function updateEventCount(
  db: Database,
  id: string,
  count: number
): void {
  db.prepare(
    `UPDATE ${SCHEDULER_TASKS_TABLE} SET event_count_current = @count, updated_at = @now WHERE id = @id`
  ).run({ id, count, now: Date.now() });
}

export function getDueTasks(db: Database, nowMs: number): ScheduledTask[] {
  const rows = db
    .prepare(
      `SELECT * FROM ${SCHEDULER_TASKS_TABLE}
       WHERE enabled = 1
         AND next_execution_at IS NOT NULL
         AND next_execution_at <= ?
       ORDER BY next_execution_at ASC, created_at ASC`
    )
    .all(nowMs) as DbScheduledTaskRow[];
  return rows.map(toScheduledTask);
}

// ── Execution CRUD ─────────────────────────────────────────────────────

export function createExecution(
  db: Database,
  taskId: string,
  scheduledFor: number
): TaskExecution {
  const now = Date.now();
  const id = randomUUID();

  db.prepare(
    `
    INSERT INTO ${SCHEDULER_EXECS_TABLE} (
      id, task_id, session_id, scheduled_for,
      started_at, completed_at, status, error_message, created_at
    ) VALUES (
      @id, @task_id, NULL, @scheduled_for,
      NULL, NULL, 'pending', NULL, @created_at
    )
    `
  ).run({
    id,
    task_id: taskId,
    scheduled_for: scheduledFor,
    created_at: now,
  });

  return {
    id,
    taskId,
    sessionId: null,
    scheduledFor,
    startedAt: null,
    completedAt: null,
    status: "pending",
    errorMessage: null,
    createdAt: now,
  };
}

export function updateExecution(
  db: Database,
  id: string,
  updates: {
    sessionId?: string | null;
    startedAt?: number;
    completedAt?: number;
    status?: ExecutionStatus;
    errorMessage?: string | null;
  }
): void {
  const setClauses: string[] = [];
  const params: Record<string, string | number | null> = { id };

  if (updates.sessionId !== undefined) {
    setClauses.push("session_id = @session_id");
    params.session_id = updates.sessionId;
  }
  if (updates.startedAt !== undefined) {
    setClauses.push("started_at = @started_at");
    params.started_at = updates.startedAt;
  }
  if (updates.completedAt !== undefined) {
    setClauses.push("completed_at = @completed_at");
    params.completed_at = updates.completedAt;
  }
  if (updates.status !== undefined) {
    setClauses.push("status = @status");
    params.status = updates.status;
  }
  if (updates.errorMessage !== undefined) {
    setClauses.push("error_message = @error_message");
    params.error_message = updates.errorMessage;
  }

  if (setClauses.length === 0) return;

  db.prepare(
    `UPDATE ${SCHEDULER_EXECS_TABLE} SET ${setClauses.join(", ")} WHERE id = @id`
  ).run(params);
}

export function getExecutionHistory(
  db: Database,
  taskId: string,
  limit = 50,
  offset = 0
): TaskExecution[] {
  const rows = db
    .prepare(
      `SELECT * FROM ${SCHEDULER_EXECS_TABLE}
       WHERE task_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?`
    )
    .all(taskId, limit, offset) as DbTaskExecutionRow[];
  return rows.map(toTaskExecution);
}

/**
 * Execution-history facts used to decide whether a run_once_at_creation run is
 * still pending (#4033): when the task's FIRST execution was created, and how
 * many executions are not `skipped`. A pending creation run has only skipped
 * rows, the first of them written at creation time.
 */
export function getCreationRunState(
  db: Database,
  taskId: string
): { firstExecutionAt: number | null; nonSkipped: number } {
  const row = db
    .prepare(
      `SELECT MIN(created_at) AS first_at,
              COALESCE(SUM(CASE WHEN status != 'skipped' THEN 1 ELSE 0 END), 0) AS non_skipped
       FROM ${SCHEDULER_EXECS_TABLE}
       WHERE task_id = ?`
    )
    .get(taskId) as { first_at: number | null; non_skipped: number } | null;
  return {
    firstExecutionAt: row?.first_at ?? null,
    nonSkipped: row?.non_skipped ?? 0,
  };
}

/**
 * THE predicate for "this execution row may still hold a live session": a
 * `running`, `delivered`, or `completed` row the reaper has not freed yet
 * (#2701). A session that signaled done keeps its slot until it is reaped, so
 * the concurrency/overlap gates keep counting it, and the consumed-one-shot
 * sweep waits for it. Every reap write that frees a `running`/`delivered` row
 * also moves it to `timed_out`, so `reaped_at IS NULL` is the only liveness
 * condition needed. Pass `alias` to qualify the columns inside a JOIN.
 */
function holdsSessionSql(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return `(${p}status IN ('running', 'delivered', 'completed') AND ${p}reaped_at IS NULL)`;
}

/**
 * Get executions for a task that may still have live sessions.
 * Includes 'running', 'delivered', and unreaped 'completed' — callers must check
 * session liveness in-memory (sessions.active DB column is not
 * reliably synced by the heartbeat/expire cycle).
 */
export function getRunningExecutions(
  db: Database,
  taskId: string
): TaskExecution[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h lookback
  const rows = db
    .prepare(
      `SELECT * FROM ${SCHEDULER_EXECS_TABLE}
       WHERE task_id = ?
         AND ${holdsSessionSql()}
         AND session_id IS NOT NULL
         AND started_at > ?`
    )
    .all(taskId, cutoff) as DbTaskExecutionRow[];
  return rows.map(toTaskExecution);
}

/**
 * Get executions stuck longer than timeoutMs. Includes 'delivered'
 * executions whose sessions may still be alive (the execution record
 * transitions to 'delivered' in ~2s but the session runs autonomously).
 */
export function getStuckExecutions(
  db: Database,
  timeoutMs: number
): TaskExecution[] {
  const cutoff = Date.now() - timeoutMs;
  const rows = db
    .prepare(
      `SELECT * FROM ${SCHEDULER_EXECS_TABLE}
       WHERE status IN ('running', 'delivered') AND started_at < ?`
    )
    .all(cutoff) as DbTaskExecutionRow[];
  return rows.map(toTaskExecution);
}

/**
 * Get all executions that may still have live sessions (global, not per-task).
 * Same status set as {@link getRunningExecutions} (unreaped 'completed' counts).
 * Used by the concurrency check — callers must verify session liveness
 * in-memory and deduplicate by session_id (heartbeat tasks reuse sessions).
 *
 * `excludeHeartbeat` drops heartbeat-task rows via the shared reap-query
 * clause — the L2 idle pass (#2702) must never see the reused heartbeat
 * session. The concurrency check keeps the default (heartbeats count).
 */
export function getActiveExecutions(
  db: Database,
  opts: { excludeHeartbeat?: boolean } = {}
): TaskExecution[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24h lookback
  const rows = (
    opts.excludeHeartbeat
      ? db.prepare(
          `SELECT te.* FROM ${SCHEDULER_EXECS_TABLE} te
             JOIN ${SCHEDULER_TASKS_TABLE} st ON te.task_id = st.id
            WHERE ${holdsSessionSql("te")}
              AND te.session_id IS NOT NULL
              AND te.started_at > ?
              AND ${NON_HEARTBEAT_TASK_SQL}`
        )
      : db.prepare(
          `SELECT * FROM ${SCHEDULER_EXECS_TABLE}
           WHERE ${holdsSessionSql()}
             AND session_id IS NOT NULL
             AND started_at > ?`
        )
  ).all(cutoff) as DbTaskExecutionRow[];
  return rows.map(toTaskExecution);
}

type DbStaleExecutionRow = {
  execution_id: string;
  session_id: string;
  task_id: string;
  task_name: string;
  started_at: number;
  max_runtime_ms: number;
};

/**
 * Executions whose session has outlived its task's runtime ceiling (#2699).
 * The ceiling is the task's explicit `maxRuntimeMs`, else the L3 default —
 * computed once in the inner query, so an explicit value always wins, a
 * pre-existing NULL row needs no migration, and the emitted `maxRuntimeMs` is
 * never null. A heartbeat task keeps only an explicit ceiling: the default
 * would archive the one session it reuses across every run.
 */
export function getStaleScheduledExecutions(
  db: Database,
  nowMs: number
): StaleExecution[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT
           te.id         AS execution_id,
           te.session_id AS session_id,
           te.task_id    AS task_id,
           st.name       AS task_name,
           te.started_at AS started_at,
           COALESCE(st.max_runtime_ms, ?) AS max_runtime_ms
         FROM ${SCHEDULER_EXECS_TABLE} te
         JOIN ${SCHEDULER_TASKS_TABLE} st ON te.task_id = st.id
         WHERE te.status IN ('running', 'delivered')
           AND te.session_id IS NOT NULL
           AND te.started_at IS NOT NULL
           AND (st.max_runtime_ms IS NOT NULL OR ${NON_HEARTBEAT_TASK_SQL})
       )
       WHERE (? - started_at) > max_runtime_ms`
    )
    .all(
      SCHEDULED_SESSION_DEFAULT_MAX_RUNTIME_MS,
      nowMs
    ) as DbStaleExecutionRow[];

  return rows.map(row => ({
    executionId: row.execution_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    taskName: row.task_name,
    startedAt: row.started_at,
    maxRuntimeMs: row.max_runtime_ms,
  }));
}

// ── Reaper queries (#2701, epic #2698) ─────────────────────────────────

/**
 * THE heartbeat-exclusion clause for every reap query (alias `st` = tasks).
 * Heartbeat tasks reuse ONE persistent session across many `delivered`
 * executions, so a reap query that saw them would archive the live heartbeat
 * session. #2699 (default ceiling) and #2702 (idle) reuse this constant.
 */
export const NON_HEARTBEAT_TASK_SQL = "COALESCE(st.heartbeat_mode, 0) = 0";

/**
 * A one-shot the scheduler consumed at spawn: `at` + `deleteAfterRun`,
 * disabled, and with at least one execution that actually spawned a session.
 * A task disabled any other way (a #4033 drop, a user toggle after a failed
 * run) has no such execution, so it is never mistaken for a consumed one.
 */
const CONSUMED_ONE_SHOT_SQL = `
  st.schedule_type = 'at'
  AND st.delete_after_run = 1
  AND st.enabled = 0
  AND EXISTS (
    SELECT 1 FROM ${SCHEDULER_EXECS_TABLE} spawned
     WHERE spawned.task_id = st.id
       AND spawned.session_id IS NOT NULL
       AND spawned.status IN ('delivered', 'completed', 'timed_out')
  )`;

/** Resolve one execution together with the task fields its callers need. */
export function getExecutionWithTask(
  db: Database,
  executionId: string
): ExecutionWithTask | null {
  const row = db
    .prepare(
      `SELECT te.*, st.namespace AS task_namespace, st.name AS task_name,
              COALESCE(st.heartbeat_mode, 0) AS task_heartbeat_mode
         FROM ${SCHEDULER_EXECS_TABLE} te
         JOIN ${SCHEDULER_TASKS_TABLE} st ON te.task_id = st.id
        WHERE te.id = ?`
    )
    .get(executionId) as
    | (DbTaskExecutionRow & {
        task_namespace: string;
        task_name: string;
        task_heartbeat_mode: number;
      })
    | null;
  if (!row) return null;
  return {
    execution: toTaskExecution(row),
    taskNamespace: row.task_namespace,
    taskName: row.task_name,
    heartbeatMode: row.task_heartbeat_mode === 1,
  };
}

/**
 * Mark an execution completed — the session declared its work done. Only a
 * `running`/`delivered` row moves; a terminal row is never overwritten (W3).
 * Returns true when the row changed.
 */
export function completeExecution(
  db: Database,
  executionId: string,
  nowMs: number
): boolean {
  return (
    db
      .prepare(
        `UPDATE ${SCHEDULER_EXECS_TABLE}
            SET status = 'completed', completed_at = ?
          WHERE id = ? AND status IN ('running', 'delivered')`
      )
      .run(nowMs, executionId).changes > 0
  );
}

type DbCompletedExecutionRow = {
  execution_id: string;
  session_id: string;
  task_id: string;
  task_name: string;
  completed_at: number;
};

/**
 * `completed` executions whose session the reaper has not freed yet, for
 * non-heartbeat tasks. Pass `sessionId` to narrow to one session (the event
 * fast path).
 */
export function getCompletedUnreapedExecutions(
  db: Database,
  sessionId?: string
): CompletedExecution[] {
  const rows = db
    .prepare(
      `SELECT te.id AS execution_id, te.session_id AS session_id,
              te.task_id AS task_id, st.name AS task_name,
              te.completed_at AS completed_at
         FROM ${SCHEDULER_EXECS_TABLE} te
         JOIN ${SCHEDULER_TASKS_TABLE} st ON te.task_id = st.id
        WHERE te.status = 'completed'
          AND te.reaped_at IS NULL
          AND te.session_id IS NOT NULL
          AND te.completed_at IS NOT NULL
          AND ${NON_HEARTBEAT_TASK_SQL}
          AND (? IS NULL OR te.session_id = ?)`
    )
    .all(sessionId ?? null, sessionId ?? null) as DbCompletedExecutionRow[];
  return rows.map(row => ({
    executionId: row.execution_id,
    sessionId: row.session_id,
    taskId: row.task_id,
    taskName: row.task_name,
    completedAt: row.completed_at,
  }));
}

/**
 * Record that the reaper freed or settled an execution's slot. Once-only
 * (W2): a row already carrying `reaped_at` is left untouched. Optional
 * `status`/`errorMessage` are written in the same statement. With a status
 * change `completed_at` becomes the reap time; without one it is filled only
 * when still NULL. `onlyFromStatuses` makes the write conditional on the
 * row's current status, so a pass that awaited an archive cannot overwrite a
 * status that changed meanwhile (e.g. a late `completed`, epic F5). Returns
 * true when the row changed.
 */
export function markExecutionReaped(
  db: Database,
  executionId: string,
  reason: ReapReason,
  nowMs: number,
  extra: {
    status?: ExecutionStatus;
    errorMessage?: string;
    onlyFromStatuses?: ExecutionStatus[];
  } = {}
): boolean {
  const sets = ["reaped_at = @now", "reap_reason = @reason"];
  const params: Record<string, string | number> = {
    id: executionId,
    now: nowMs,
    reason,
  };
  if (extra.status !== undefined) {
    // A status change ends the execution now — same as the pre-#2701 stale
    // path, which stamped completed_at with the reap time.
    sets.push("status = @status", "completed_at = @now");
    params.status = extra.status;
  } else {
    // Status kept (e.g. `completed`): keep the time the session signaled.
    sets.push("completed_at = COALESCE(completed_at, @now)");
  }
  if (extra.errorMessage !== undefined) {
    sets.push("error_message = @error_message");
    params.error_message = extra.errorMessage;
  }
  let statusGuard = "";
  if (extra.onlyFromStatuses !== undefined) {
    const names = extra.onlyFromStatuses.map((status, i) => {
      params[`from_status_${i}`] = status;
      return `@from_status_${i}`;
    });
    // An empty list matches no row — never an unconditional write.
    statusGuard = names.length
      ? ` AND status IN (${names.join(", ")})`
      : " AND 0";
  }
  return (
    db
      .prepare(
        `UPDATE ${SCHEDULER_EXECS_TABLE} SET ${sets.join(", ")}
          WHERE id = @id AND reaped_at IS NULL${statusGuard}`
      )
      .run(params).changes > 0
  );
}

type DbUnreapedExecutionRow = {
  execution_id: string;
  session_id: string;
  status: string;
};

/**
 * Executions of consumed one-shots that still hold (or may hold) a session:
 * the rows the sweep must settle before the task can be deleted.
 */
export function getUnreapedConsumedOneShotExecutions(
  db: Database
): Array<{ executionId: string; sessionId: string; status: ExecutionStatus }> {
  const rows = db
    .prepare(
      `SELECT te.id AS execution_id, te.session_id AS session_id,
              te.status AS status
         FROM ${SCHEDULER_EXECS_TABLE} te
         JOIN ${SCHEDULER_TASKS_TABLE} st ON te.task_id = st.id
        WHERE ${CONSUMED_ONE_SHOT_SQL}
          AND te.session_id IS NOT NULL
          AND ${holdsSessionSql("te")}`
    )
    .all() as DbUnreapedExecutionRow[];
  return rows.map(row => ({
    executionId: row.execution_id,
    sessionId: row.session_id,
    status: row.status as ExecutionStatus,
  }));
}

/**
 * Consumed one-shots that no longer hold any session — safe to delete now.
 * Deleting cascades their execution rows, as the pre-#2701 spawn-time delete
 * did; only the timing moved (#2701, review finding 2701-1).
 */
export function getConsumedOneShotTasks(db: Database): ConsumedOneShot[] {
  const rows = db
    .prepare(
      `SELECT st.id AS task_id, st.namespace AS namespace, st.name AS name
         FROM ${SCHEDULER_TASKS_TABLE} st
        WHERE ${CONSUMED_ONE_SHOT_SQL}
          AND NOT EXISTS (
            SELECT 1 FROM ${SCHEDULER_EXECS_TABLE} live
             WHERE live.task_id = st.id
               AND live.session_id IS NOT NULL
               AND ${holdsSessionSql("live")}
          )`
    )
    .all() as Array<{ task_id: string; namespace: string; name: string }>;
  return rows.map(row => ({
    taskId: row.task_id,
    namespace: row.namespace,
    name: row.name,
  }));
}
