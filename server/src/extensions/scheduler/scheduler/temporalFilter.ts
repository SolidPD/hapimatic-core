// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Temporal Filter Chain — Pure Functions
 *
 * 5-layer filter chain for the Advanced Scheduling System:
 *   1. Lifetime — Is the candidate within schedule start/end bounds?
 *   2. Operating Schedule — Is the candidate in an active week, day, and hour window?
 *   3. Exclusion Schedule — Is the candidate NOT on an excluded date?
 *   4. Interval — Does the candidate satisfy the interval/cron requirement? (handled by base calculation)
 *   5. Event Count — Has the event count limit been reached?
 *
 * All functions are pure (no side effects, no DB access, no imports from other
 * scheduler modules except types). This makes them testable without mocks.
 */

import { Cron } from "croner";
import type { ScheduledTask } from "./types";

// ── Parsed JSON column shapes ──────────────────────────────────────

/** Parsed from `operating_schedule` JSON column */
export type OperatingSchedule = {
  everyNWeeks: number; // 1 = every week, 2 = every other week, etc.
  activeDays: number[]; // 0=Sun, 1=Mon, ..., 6=Sat
  clockIn: string; // "HH:MM" in task's timezone (e.g., "09:00")
  clockOut: string; // "HH:MM" in task's timezone (e.g., "17:00")
};

/** Parsed from `exclusion_schedule` JSON column */
export type ExclusionEntry = {
  label: string; // "Christmas", "Sprint Planning"
  month: number; // 1-12
  day: number; // 1-31
  annualRepeat: boolean; // true = recurs every year
  year?: number; // only if annualRepeat === false
};

/** Parsed from `rotation_config` JSON column */
export type RotationConfig = {
  mode: "count" | "time";
  count?: number; // rotate after X uses (count mode)
  day?: number; // 0-6 day of week to rotate (time mode)
  hour?: number; // 0-23 hour to rotate (time mode)
};

/** Parsed from `backoff_config` JSON column */
export type BackoffConfig = number[]; // Array of delay values in ms, indexed by error count

// ── Minimal input type for calculateNextWithLayers ─────────────────

/** Only the fields needed by the temporal filter chain */
export type TemporalFilterInput = Pick<
  ScheduledTask,
  | "scheduleType"
  | "cronExpression"
  | "scheduledAt"
  | "intervalMs"
  | "timezone"
  | "lastExecutedAt"
  | "createdAt"
  | "operatingSchedule"
  | "exclusionSchedule"
  | "lifetimeStart"
  | "lifetimeEnd"
  | "eventCountCurrent"
  | "eventCountLimit"
>;

/** Maximum iterations for the filter loop safety valve */
const MAX_FILTER_ITERATIONS = 1000;

// ── Pure filter functions ──────────────────────────────────────────

/**
 * Compute integer calendar-day difference between two timestamps in a given timezone.
 * DST-safe: converts to YYYY-MM-DD strings first, eliminating 23h/25h day variation.
 */
export function calendarDayDiff(
  anchorMs: number,
  nowMs: number,
  tz: string
): number {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  const anchorStr = fmt.format(new Date(anchorMs)); // "YYYY-MM-DD"
  const nowStr = fmt.format(new Date(nowMs));

  // Parse YYYY-MM-DD to UTC midnight Date for integer arithmetic
  const anchorDate = new Date(anchorStr + "T00:00:00Z");
  const nowDate = new Date(nowStr + "T00:00:00Z");

  return Math.floor((nowDate.getTime() - anchorDate.getTime()) / 86_400_000);
}

/**
 * Is the candidate timestamp in an active week?
 * Weeks are counted from an anchor (typically lifetime start or task creation).
 */
export function isActiveWeek(
  anchorMs: number,
  candidateMs: number,
  everyNWeeks: number,
  tz: string
): boolean {
  if (everyNWeeks <= 1) return true; // Every week is active
  const dayDiff = calendarDayDiff(anchorMs, candidateMs, tz);
  const weeksSinceAnchor = Math.floor(dayDiff / 7);
  return weeksSinceAnchor % everyNWeeks === 0;
}

/**
 * Is the candidate timestamp on an active day of the week?
 */
export function isActiveDayOfWeek(
  candidateMs: number,
  activeDays: number[],
  tz: string
): boolean {
  if (activeDays.length === 0) return false;

  // Get day of week in the task's timezone
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
  });
  const weekdayStr = fmt.format(new Date(candidateMs));

  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = dayMap[weekdayStr];
  if (dayOfWeek === undefined) return false;

  return activeDays.includes(dayOfWeek);
}

/**
 * Is the candidate timestamp within the active hours window?
 * Handles overnight spans (clockOut < clockIn, e.g., 22:00-06:00).
 */
export function isWithinActiveHours(
  candidateMs: number,
  clockIn: string,
  clockOut: string,
  tz: string
): boolean {
  // Extract HH:MM of candidate in task's timezone
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date(candidateMs));
  const h = parts.find(p => p.type === "hour")?.value ?? "00";
  const m = parts.find(p => p.type === "minute")?.value ?? "00";

  // Normalize hour "24" → "00" (some locales produce this)
  const normalizedH = h === "24" ? "00" : h;
  const candidateTime = `${normalizedH.padStart(2, "0")}:${m.padStart(2, "0")}`;

  if (clockIn <= clockOut) {
    // Normal span: e.g., 09:00-17:00
    // clockIn is inclusive, clockOut is exclusive
    return candidateTime >= clockIn && candidateTime < clockOut;
  } else {
    // Overnight span: e.g., 22:00-06:00
    // Active if time >= clockIn OR time < clockOut
    return candidateTime >= clockIn || candidateTime < clockOut;
  }
}

/**
 * Is the candidate timestamp on an excluded date?
 */
export function isExcluded(
  candidateMs: number,
  exclusions: ExclusionEntry[],
  tz: string
): boolean {
  if (exclusions.length === 0) return false;

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const partsList = fmt.formatToParts(new Date(candidateMs));
  const month = Number(partsList.find(p => p.type === "month")?.value);
  const day = Number(partsList.find(p => p.type === "day")?.value);
  const year = Number(partsList.find(p => p.type === "year")?.value);

  return exclusions.some(
    ex =>
      ex.month === month &&
      ex.day === day &&
      (ex.annualRepeat || ex.year === year)
  );
}

/**
 * Is the candidate timestamp within the schedule's lifetime bounds?
 */
export function isWithinLifetime(
  candidateMs: number,
  lifetimeStart: number | null,
  lifetimeEnd: number | null
): boolean {
  if (lifetimeStart !== null && candidateMs < lifetimeStart) return false;
  if (lifetimeEnd !== null && candidateMs > lifetimeEnd) return false;
  return true;
}

/**
 * Has the event count limit been reached?
 */
export function hasReachedEventLimit(
  eventCountCurrent: number,
  eventCountLimit: number | null
): boolean {
  if (eventCountLimit === null) return false;
  return eventCountCurrent >= eventCountLimit;
}

// ── Base candidate calculation ─────────────────────────────────────

/**
 * Calculate the raw next candidate timestamp from the base schedule type.
 * This is the pure logic extracted from the old calculateNextExecution() switch.
 */
function calculateBaseCandidate(
  task: TemporalFilterInput,
  now: number
): number | null {
  switch (task.scheduleType) {
    case "at": {
      if (task.scheduledAt && task.scheduledAt > now) {
        return task.scheduledAt;
      }
      return null;
    }

    case "every": {
      if (!task.intervalMs) return null;
      const base = task.lastExecutedAt ?? now;
      return base + task.intervalMs;
    }

    case "cron": {
      if (!task.cronExpression) return null;
      try {
        const opts: Record<string, unknown> = {
          timezone: task.timezone,
        };
        // Use croner's startAt/stopAt for lifetime if applicable
        if (task.lifetimeStart) {
          opts.startAt = new Date(task.lifetimeStart).toISOString();
        }
        if (task.lifetimeEnd) {
          opts.stopAt = new Date(task.lifetimeEnd).toISOString();
        }
        const cron = new Cron(task.cronExpression, opts);
        const next = cron.nextRun();
        return next ? next.getTime() : null;
      } catch (error) {
        console.error(
          `[TemporalFilter] Invalid cron expression:`,
          task.cronExpression,
          error
        );
        return null;
      }
    }

    default:
      return null;
  }
}

// ── Candidate advancement helpers ──────────────────────────────────

/**
 * Advance a candidate past the current failed layer.
 * Returns the next candidate to evaluate, or null if advancement is impossible.
 */
function advanceCandidate(
  task: TemporalFilterInput,
  candidate: number,
  _os: OperatingSchedule | null
): number | null {
  if (task.scheduleType === "at") {
    // One-shot: if the one time doesn't pass filters, it's blocked
    return null;
  }

  if (task.scheduleType === "every" && task.intervalMs) {
    // For interval-based: advance by one interval
    return candidate + task.intervalMs;
  }

  if (task.scheduleType === "cron" && task.cronExpression) {
    // For cron-based: ask croner for the next tick after this candidate
    try {
      const opts: Record<string, unknown> = {
        timezone: task.timezone,
        startAt: new Date(candidate + 1000).toISOString(), // 1s past current
      };
      if (task.lifetimeEnd) {
        opts.stopAt = new Date(task.lifetimeEnd).toISOString();
      }
      const cron = new Cron(task.cronExpression, opts);
      const next = cron.nextRun();
      return next ? next.getTime() : null;
    } catch {
      return null;
    }
  }

  return null;
}

// ── Main filter chain ──────────────────────────────────────────────

/**
 * Calculate the next execution time applying all 5 temporal filter layers.
 *
 * 1. Lifetime — reject if candidate is outside lifetime bounds
 * 2. Operating Schedule — reject if wrong week, day, or hour
 * 3. Exclusion Schedule — reject if on an excluded date
 * 4. Interval — already satisfied by the base candidate
 * 5. Event Count — reject if limit reached
 *
 * Returns the next valid execution time in ms, or null if no valid time exists.
 */
export function calculateNextWithLayers(
  task: TemporalFilterInput,
  now: number
): number | null {
  // Layer 5 (Event Count) — check early, it's independent of candidate
  if (hasReachedEventLimit(task.eventCountCurrent, task.eventCountLimit)) {
    return null;
  }

  // Calculate raw candidate from base schedule type
  let candidate = calculateBaseCandidate(task, now);
  if (candidate === null) return null;

  // Parse JSON columns (once, before the loop)
  let os: OperatingSchedule | null = null;
  if (task.operatingSchedule) {
    try {
      os = JSON.parse(task.operatingSchedule) as OperatingSchedule;
    } catch {
      // Invalid JSON — skip operating schedule layer
    }
  }

  let exclusions: ExclusionEntry[] = [];
  if (task.exclusionSchedule) {
    try {
      exclusions = JSON.parse(task.exclusionSchedule) as ExclusionEntry[];
    } catch {
      // Invalid JSON — skip exclusion layer
    }
  }

  const anchor = task.lifetimeStart ?? task.createdAt;

  // Filter loop with safety valve
  for (let i = 0; i < MAX_FILTER_ITERATIONS; i++) {
    // Layer 1 — Lifetime
    if (!isWithinLifetime(candidate, task.lifetimeStart, task.lifetimeEnd)) {
      // If we've passed the lifetime end, no future candidate will work
      if (task.lifetimeEnd !== null && candidate > task.lifetimeEnd) {
        return null;
      }
      // If before lifetime start, advance to lifetime start
      if (task.lifetimeStart !== null && candidate < task.lifetimeStart) {
        candidate = task.lifetimeStart;
        continue;
      }
    }

    // Layer 2 — Operating Schedule
    if (os) {
      if (!isActiveWeek(anchor, candidate, os.everyNWeeks, task.timezone)) {
        const advanced = advanceCandidate(task, candidate, os);
        if (advanced === null) return null;
        candidate = advanced;
        continue;
      }

      if (!isActiveDayOfWeek(candidate, os.activeDays, task.timezone)) {
        const advanced = advanceCandidate(task, candidate, os);
        if (advanced === null) return null;
        candidate = advanced;
        continue;
      }

      if (
        !isWithinActiveHours(candidate, os.clockIn, os.clockOut, task.timezone)
      ) {
        const advanced = advanceCandidate(task, candidate, os);
        if (advanced === null) return null;
        candidate = advanced;
        continue;
      }
    }

    // Layer 3 — Exclusion Schedule
    if (isExcluded(candidate, exclusions, task.timezone)) {
      const advanced = advanceCandidate(task, candidate, os);
      if (advanced === null) return null;
      candidate = advanced;
      continue;
    }

    // Layer 4 — Interval: already satisfied by base candidate calculation

    // All layers passed
    return candidate;
  }

  // Safety valve — max iterations reached
  console.warn(
    `[TemporalFilter] Safety valve: max ${MAX_FILTER_ITERATIONS} iterations reached. ` +
      `Returning null. Check schedule configuration.`
  );
  return null;
}
