// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bidirectional converters between ScheduledTask (API) and ScheduleState (UI).
 *
 * scheduledTaskToScheduleState() — hydrates the ScheduleSection UI from an
 *   existing schedule returned by the API.
 * scheduleStateToUpdateRequest() — serializes ScheduleSection UI state back
 *   into an UpdateScheduledTaskRequest for the API.
 */
import type { ScheduledTask, UpdateScheduledTaskRequest } from "@/types/api";
import type { ScheduleState } from "@/components/NewSession/ScheduleSection";
import type { ExclusionEntryUI } from "@/components/NewSession/ExclusionListEditor";
import { defaultScheduleState } from "@/components/NewSession/ScheduleSection";
import {
  DEFAULT_PRE_WORK_INSTRUCTIONS,
  DEFAULT_CLOSING_INSTRUCTIONS,
} from "@/lib/schedulerDefaults";

// ── Helpers ────────────────────────────────────────────────

function epochToDatetimeLocal(ms: number | null | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function safeParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

// ── API → UI ───────────────────────────────────────────────

export function scheduledTaskToScheduleState(
  task: ScheduledTask
): ScheduleState {
  // Parse operating schedule
  const opSched = safeParse<{
    everyNWeeks?: number;
    activeDays?: number[];
    clockIn?: string;
    clockOut?: string;
  }>(task.operatingSchedule, {});

  // Convert activeDays from index array [0,1,4] to boolean array
  const activeDays: boolean[] = defaultScheduleState.activeDays.map(
    (_, i) => opSched.activeDays?.includes(i) ?? true
  );

  // Parse exclusion schedule
  const rawExclusions = safeParse<
    Array<{
      label?: string;
      month?: number;
      day?: number;
      annualRepeat?: boolean;
      year?: number;
    }>
  >(task.exclusionSchedule, []);

  const exclusions: ExclusionEntryUI[] = rawExclusions.map((e, i) => {
    const year = e.year ?? new Date().getFullYear();
    const month = (e.month ?? 1) - 1;
    const day = e.day ?? 1;
    const startAt = epochToDatetimeLocal(new Date(year, month, day).getTime());
    return {
      id: `exc-${i}`,
      startAt,
      endAt: startAt,
      description: e.label ?? "",
      annualRepeat: e.annualRepeat ?? false,
    };
  });

  // Parse rotation config
  const rotation = safeParse<{
    mode?: "time" | "count";
    count?: number;
    days?: boolean[];
    time?: string;
  }>(task.rotationConfig, {});

  // Parse backoff config
  const backoff = task.backoffConfig
    ? safeParse<{ multiplier?: number; threshold?: number }>(
        task.backoffConfig,
        { multiplier: 2, threshold: 3 }
      )
    : null;

  // Determine standing orders mode
  const standingOrders = task.standingOrders ?? "";
  const isFilePath =
    standingOrders.startsWith("/") || standingOrders.startsWith("~");

  return {
    prompt: task.prompt,
    scheduleEnabled: task.enabled,
    timezone: task.timezone || "America/New_York",
    dstAdjustment: task.dstAdjustment === "skip",
    runOnceAtCreation: task.runOnceAtCreation,

    intervalMs: task.intervalMs ?? defaultScheduleState.intervalMs,

    lifetimeStart: epochToDatetimeLocal(task.lifetimeStart),
    lifetimeEnd: epochToDatetimeLocal(task.lifetimeEnd),

    everyNWeeks: opSched.everyNWeeks ?? 1,
    activeDays,
    clockIn: opSched.clockIn ?? "00:00",
    clockOut: opSched.clockOut ?? "23:59",

    exclusions,

    eventCountLimit: task.eventCountLimit ? String(task.eventCountLimit) : "",
    rotationMode: rotation.mode ?? "count",
    rotationDays: rotation.days ?? defaultScheduleState.rotationDays,
    rotationTime: rotation.time ?? "00:00",
    rotationCount: rotation.count ? String(rotation.count) : "5",
    backoffEnabled: backoff !== null,
    backoffMultiplier: backoff?.multiplier ? String(backoff.multiplier) : "2",
    backoffThreshold: backoff?.threshold ? String(backoff.threshold) : "3",
    jitterMs: task.jitterMaxMs ?? defaultScheduleState.jitterMs,

    responseSuppression: task.ackMaxChars ? String(task.ackMaxChars) : "100",

    preWorkInstructions:
      task.preWorkInstructions ?? DEFAULT_PRE_WORK_INSTRUCTIONS,
    closingInstructions:
      task.closingInstructions ?? DEFAULT_CLOSING_INSTRUCTIONS,

    heartbeatMode: task.heartbeatMode,
    standingOrdersMode: isFilePath ? "file" : "inline",
    standingOrdersText: isFilePath ? "" : standingOrders,
    standingOrdersFile: isFilePath ? standingOrders : "",
    ackToken: "HEARTBEAT_OK",

    maxRuntimeMinutes: task.maxRuntimeMs
      ? String(Math.round(task.maxRuntimeMs / 60_000))
      : "",
    notifyOn: task.notifyOn,
    overlapPolicy: task.overlapPolicy,
  };
}

// ── UI → API ───────────────────────────────────────────────

export function scheduleStateToUpdateRequest(
  state: ScheduleState
): UpdateScheduledTaskRequest {
  const req: UpdateScheduledTaskRequest = {
    prompt: state.prompt.trim(),
    scheduleType: "every",
    timezone: state.timezone,
    enabled: state.scheduleEnabled,
    deleteAfterRun: false,
    notifyOn: state.notifyOn,
    overlapPolicy: state.overlapPolicy,
    intervalMs: state.intervalMs,

    operatingSchedule: JSON.stringify({
      everyNWeeks: state.everyNWeeks,
      activeDays: state.activeDays
        .map((enabled, i) => (enabled ? i : -1))
        .filter(i => i >= 0),
      clockIn: state.clockIn,
      clockOut: state.clockOut,
    }),

    exclusionSchedule: JSON.stringify(
      state.exclusions.map(e => ({
        label: e.description,
        month: new Date(e.startAt).getMonth() + 1,
        day: new Date(e.startAt).getDate(),
        annualRepeat: e.annualRepeat,
        year: e.annualRepeat ? undefined : new Date(e.startAt).getFullYear(),
      }))
    ),

    lifetimeStart: state.lifetimeStart
      ? new Date(state.lifetimeStart).getTime()
      : undefined,
    lifetimeEnd: state.lifetimeEnd
      ? new Date(state.lifetimeEnd).getTime()
      : undefined,

    eventCountLimit: state.eventCountLimit
      ? parseInt(state.eventCountLimit, 10)
      : undefined,

    jitterMaxMs: state.jitterMs || undefined,
    heartbeatMode: state.heartbeatMode,

    preWorkInstructions: !state.heartbeatMode
      ? state.preWorkInstructions || undefined
      : undefined,
    closingInstructions: !state.heartbeatMode
      ? state.closingInstructions || undefined
      : undefined,

    standingOrders: state.heartbeatMode
      ? state.standingOrdersMode === "inline"
        ? state.standingOrdersText
        : state.standingOrdersFile
      : undefined,

    ackMaxChars: parseInt(state.responseSuppression, 10) || 100,

    rotationConfig: JSON.stringify({
      mode: state.rotationMode,
      ...(state.rotationMode === "count"
        ? { count: parseInt(state.rotationCount, 10) || 5 }
        : { days: state.rotationDays, time: state.rotationTime }),
    }),

    backoffConfig: state.backoffEnabled
      ? JSON.stringify({
          multiplier: parseFloat(state.backoffMultiplier) || 2,
          threshold: parseInt(state.backoffThreshold, 10) || 3,
        })
      : undefined,

    runOnceAtCreation: state.runOnceAtCreation,
    dstAdjustment: state.dstAdjustment ? "skip" : "none",
  };

  if (state.maxRuntimeMinutes) {
    req.maxRuntimeMs = parseInt(state.maxRuntimeMinutes, 10) * 60_000;
  } else {
    req.maxRuntimeMs = null;
  }

  return req;
}
