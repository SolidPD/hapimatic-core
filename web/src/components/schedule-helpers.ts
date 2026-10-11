// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Schedule-specific helper functions.
 * Extracted from SchedulesPage.tsx for reuse in unified list view.
 */
import type { ScheduledTask, TaskExecution } from "@/types/api";

/**
 * Format a timestamp as bidirectional relative time.
 * Unlike sessionHelpers.formatRelativeTime (past-only), this handles future times too.
 * e.g., "5m ago", "in 2h", "just now", "in < 1m"
 */
export function formatScheduleRelativeTime(ms: number): string {
  const now = Date.now();
  const diff = ms - now;
  const absDiff = Math.abs(diff);
  const isPast = diff < 0;

  if (absDiff < 60_000) return isPast ? "just now" : "in < 1m";
  if (absDiff < 3_600_000) {
    const mins = Math.round(absDiff / 60_000);
    return isPast ? `${mins}m ago` : `in ${mins}m`;
  }
  if (absDiff < 86_400_000) {
    const hrs = Math.round(absDiff / 3_600_000);
    return isPast ? `${hrs}h ago` : `in ${hrs}h`;
  }
  const days = Math.round(absDiff / 86_400_000);
  return isPast ? `${days}d ago` : `in ${days}d`;
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return remSecs > 0 ? `${mins}m ${remSecs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export function scheduleDescription(task: ScheduledTask): string {
  switch (task.scheduleType) {
    case "at":
      return task.scheduledAt
        ? `Once at ${formatDateTime(task.scheduledAt)}`
        : "Once (no time set)";
    case "every":
      return task.intervalMs
        ? `Every ${formatDuration(task.intervalMs)}`
        : "Interval (not set)";
    case "cron":
      return task.cronExpression
        ? `Cron: ${task.cronExpression}`
        : "Cron (no expression)";
  }
}

export function statusColor(status: TaskExecution["status"]): string {
  switch (status) {
    case "delivered":
      return "text-green-400";
    // #2701: the session itself declared its work done
    case "completed":
      return "text-emerald-400";
    case "running":
      return "text-blue-400";
    case "pending":
      return "text-yellow-400";
    case "failed":
      return "text-red-400";
    case "timed_out":
      return "text-orange-400";
    case "skipped":
      return "text-[var(--app-hint)]";
  }
}

export function statusBgColor(status: TaskExecution["status"]): string {
  switch (status) {
    case "delivered":
      return "bg-green-500/10";
    case "completed":
      return "bg-emerald-500/10";
    case "running":
      return "bg-blue-500/10";
    case "pending":
      return "bg-yellow-500/10";
    case "failed":
      return "bg-red-500/10";
    case "timed_out":
      return "bg-orange-500/10";
    case "skipped":
      return "bg-[var(--app-secondary-bg)]";
  }
}
