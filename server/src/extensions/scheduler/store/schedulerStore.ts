// SPDX-License-Identifier: AGPL-3.0-only
/**
 * SchedulerStore — Thin wrapper around scheduler SQL queries.
 *
 * Receives a Database instance in the constructor and delegates all
 * operations to the pure query functions in schedulerQueries.ts.
 *
 * Pattern: follows server/src/store/timeLogStore.ts
 */

import type { Database } from "bun:sqlite";

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
import {
  completeExecution,
  createExecution,
  createTask,
  deleteTask,
  getAllTasks,
  getDueTasks,
  getEnabledTasks,
  getExecutionHistory,
  getActiveExecutions,
  getCompletedUnreapedExecutions,
  getConsumedOneShotTasks,
  getCreationRunState,
  getExecutionWithTask,
  getRunningExecutions,
  getStaleScheduledExecutions,
  getStuckExecutions,
  getTask,
  getUnreapedConsumedOneShotExecutions,
  markExecutionReaped,
  toggleTask,
  updateConsecutiveErrors,
  updateEventCount,
  updateExecution,
  updateLastExecuted,
  updateLastSessionId,
  updateNextExecution,
  updateTask,
} from "./schedulerQueries";

export class SchedulerStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ── Task operations ────────────────────────────────────────────────

  createTask(input: CreateScheduledTask, namespace: string): ScheduledTask {
    return createTask(this.db, input, namespace);
  }

  getTask(id: string, namespace: string): ScheduledTask | null {
    return getTask(this.db, id, namespace);
  }

  getAllTasks(namespace: string): ScheduledTask[] {
    return getAllTasks(this.db, namespace);
  }

  getEnabledTasks(): ScheduledTask[] {
    return getEnabledTasks(this.db);
  }

  updateTask(
    id: string,
    input: UpdateScheduledTask,
    namespace: string
  ): ScheduledTask | null {
    return updateTask(this.db, id, input, namespace);
  }

  deleteTask(id: string, namespace: string): boolean {
    return deleteTask(this.db, id, namespace);
  }

  toggleTask(id: string, namespace: string): ScheduledTask | null {
    return toggleTask(this.db, id, namespace);
  }

  updateNextExecution(id: string, nextExecutionAt: number | null): void {
    updateNextExecution(this.db, id, nextExecutionAt);
  }

  updateLastExecuted(id: string, lastExecutedAt: number): void {
    updateLastExecuted(this.db, id, lastExecutedAt);
  }

  updateConsecutiveErrors(id: string, count: number): void {
    updateConsecutiveErrors(this.db, id, count);
  }

  updateEventCount(id: string, count: number): void {
    updateEventCount(this.db, id, count);
  }

  updateLastSessionId(id: string, sessionId: string | null): void {
    updateLastSessionId(this.db, id, sessionId);
  }

  getDueTasks(nowMs: number): ScheduledTask[] {
    return getDueTasks(this.db, nowMs);
  }

  // ── Execution operations ───────────────────────────────────────────

  createExecution(taskId: string, scheduledFor: number): TaskExecution {
    return createExecution(this.db, taskId, scheduledFor);
  }

  updateExecution(
    id: string,
    updates: {
      sessionId?: string | null;
      startedAt?: number;
      completedAt?: number;
      status?: ExecutionStatus;
      errorMessage?: string | null;
    }
  ): void {
    updateExecution(this.db, id, updates);
  }

  getExecutionHistory(
    taskId: string,
    limit?: number,
    offset?: number
  ): TaskExecution[] {
    return getExecutionHistory(this.db, taskId, limit, offset);
  }

  getCreationRunState(taskId: string): {
    firstExecutionAt: number | null;
    nonSkipped: number;
  } {
    return getCreationRunState(this.db, taskId);
  }

  getRunningExecutions(taskId: string): TaskExecution[] {
    return getRunningExecutions(this.db, taskId);
  }

  getStuckExecutions(timeoutMs: number): TaskExecution[] {
    return getStuckExecutions(this.db, timeoutMs);
  }

  getActiveExecutions(
    opts: { excludeHeartbeat?: boolean } = {}
  ): TaskExecution[] {
    return getActiveExecutions(this.db, opts);
  }

  getStaleScheduledExecutions(nowMs: number): StaleExecution[] {
    return getStaleScheduledExecutions(this.db, nowMs);
  }

  // ── Reaper (#2701) ──────────────────────────────────────────────────

  getExecutionWithTask(executionId: string): ExecutionWithTask | null {
    return getExecutionWithTask(this.db, executionId);
  }

  completeExecution(executionId: string, nowMs: number): boolean {
    return completeExecution(this.db, executionId, nowMs);
  }

  getCompletedUnreapedExecutions(sessionId?: string): CompletedExecution[] {
    return getCompletedUnreapedExecutions(this.db, sessionId);
  }

  markExecutionReaped(
    executionId: string,
    reason: ReapReason,
    nowMs: number,
    extra?: {
      status?: ExecutionStatus;
      errorMessage?: string;
      onlyFromStatuses?: ExecutionStatus[];
    }
  ): boolean {
    return markExecutionReaped(this.db, executionId, reason, nowMs, extra);
  }

  getUnreapedConsumedOneShotExecutions(): Array<{
    executionId: string;
    sessionId: string;
    status: ExecutionStatus;
  }> {
    return getUnreapedConsumedOneShotExecutions(this.db);
  }

  getConsumedOneShotTasks(): ConsumedOneShot[] {
    return getConsumedOneShotTasks(this.db);
  }
}
