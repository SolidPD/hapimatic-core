// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import type { ApiClient } from "@/api/client";
import type { NotifyOn, OverlapPolicy } from "@/types/api";
import { FormField } from "./FormField";
import { Button } from "@/components/ui/button";
import { UiSelect, UiInput } from "./controls";
import { CollapsibleLayer } from "./CollapsibleLayer";
import { PromptTextarea } from "./PromptTextarea";
import { TimezoneSelect } from "./TimezoneSelect";
import { ScheduleLifetimePicker } from "./ScheduleLifetimePicker";
import { OperatingSchedulePicker } from "./OperatingSchedulePicker";
import {
  ExclusionListEditor,
  type ExclusionEntryUI,
} from "./ExclusionListEditor";
import { EventTimingSection } from "./EventTimingSection";
import { HeartbeatModeSection } from "./HeartbeatModeSection";
import { InstructionsTextarea } from "./InstructionsTextarea";
import {
  DEFAULT_PRE_WORK_INSTRUCTIONS,
  DEFAULT_CLOSING_INSTRUCTIONS,
} from "@/lib/schedulerDefaults";

export type ScheduleState = {
  // Core
  prompt: string;
  scheduleEnabled: boolean;
  timezone: string;
  dstAdjustment: boolean;
  runOnceAtCreation: boolean;

  // Interval (used as default schedule type)
  intervalMs: number;

  // Layer 1: Lifetime
  lifetimeStart: string;
  lifetimeEnd: string;

  // Layer 2: Operating Schedule
  everyNWeeks: number;
  activeDays: boolean[];
  clockIn: string;
  clockOut: string;

  // Layer 3: Exclusion Schedule
  exclusions: ExclusionEntryUI[];

  // Layer 4: Event Timing
  eventCountLimit: string;
  rotationMode: "time" | "count";
  rotationDays: boolean[];
  rotationTime: string;
  rotationCount: string;
  backoffEnabled: boolean;
  backoffMultiplier: string;
  backoffThreshold: string;
  jitterMs: number;

  // Layer 5: Response Handling
  responseSuppression: string;

  // Session Lifecycle (non-heartbeat)
  preWorkInstructions: string;
  closingInstructions: string;

  // Heartbeat Mode
  heartbeatMode: boolean;
  standingOrdersMode: "inline" | "file";
  standingOrdersText: string;
  standingOrdersFile: string;
  ackToken: string;

  // Existing preserved fields
  maxRuntimeMinutes: string;
  notifyOn: NotifyOn;
  overlapPolicy: OverlapPolicy;
};

function nowDatetimeLocal(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/* ── Badge formatting helpers ─────────────────────────── */

function formatTimezoneBadge(tz: string, dst: boolean): string {
  const display = tz.replace(/_/g, " ");
  return dst ? `${display} (DST)` : display;
}

function formatLifetimeBadge(start: string, end: string): string {
  const fmt = (dt: string) => {
    if (!dt) return "Never";
    const d = new Date(dt);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  return `${fmt(start)} \u2013 ${end ? fmt(end) : "Never"}`;
}

function formatOperatingBadge(
  weeks: number,
  days: boolean[],
  clockIn: string,
  clockOut: string
): string {
  const dayLetters = ["M", "T", "W", "T", "F", "S", "S"];
  const dayStr = days.map((d, i) => (d ? dayLetters[i] : "\u00B7")).join("");
  return `${weeks} wk [${dayStr}] ${clockIn} \u2013 ${clockOut}`;
}

function formatIntervalBadge(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  const days = Math.floor(totalMin / 1440);
  const hrs = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hrs > 0) parts.push(`${hrs} hrs`);
  if (mins > 0) parts.push(`${mins} min`);
  return parts.join(" ") || "0 min";
}

/* ── Default state ────────────────────────────────────── */

export const defaultScheduleState: ScheduleState = {
  prompt: "",
  scheduleEnabled: true,
  timezone: "America/New_York",
  dstAdjustment: true,
  runOnceAtCreation: true,
  intervalMs: 1_800_000,
  lifetimeStart: nowDatetimeLocal(),
  lifetimeEnd: "",
  everyNWeeks: 1,
  activeDays: [true, true, true, true, true, true, true],
  clockIn: "00:00",
  clockOut: "23:59",
  exclusions: [],
  eventCountLimit: "",
  rotationMode: "count",
  rotationDays: [true, true, true, true, true, true, true],
  rotationTime: "00:00",
  rotationCount: "5",
  backoffEnabled: true,
  backoffMultiplier: "2",
  backoffThreshold: "3",
  jitterMs: 60_000,
  responseSuppression: "100",
  preWorkInstructions: DEFAULT_PRE_WORK_INSTRUCTIONS,
  closingInstructions: DEFAULT_CLOSING_INSTRUCTIONS,
  heartbeatMode: false,
  standingOrdersMode: "inline",
  standingOrdersText: "",
  standingOrdersFile: "",
  ackToken: "HEARTBEAT_OK",
  maxRuntimeMinutes: "",
  notifyOn: "both",
  overlapPolicy: "queue",
};

/* ── Component ────────────────────────────────────────── */

export function ScheduleSection(props: {
  state: ScheduleState;
  onChange: (state: ScheduleState) => void;
  isDisabled?: boolean;
  api?: ApiClient;
  machineId?: string | null;
  nodeId?: string | null;
}) {
  const { state, onChange, isDisabled = false } = props;

  // Collapsible layer states
  const [timezoneOpen, setTimezoneOpen] = useState(false);
  const [layer1Open, setLayer1Open] = useState(false);
  const [layer2Open, setLayer2Open] = useState(false);
  const [layer3Open, setLayer3Open] = useState(false);
  const [layer4Open, setLayer4Open] = useState(true);
  const [layer5Open, setLayer5Open] = useState(false);
  const [heartbeatOpen, setHeartbeatOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);

  const update = (partial: Partial<ScheduleState>) => {
    onChange({ ...state, ...partial });
  };

  return (
    <div className="flex flex-col divide-y divide-[var(--app-divider)]">
      {/* === Heading + Schedule Status (always full opacity) === */}
      <div className="px-3 py-2.5 flex flex-col gap-2.5">
        <span className="text-xs font-semibold text-[var(--app-link)] uppercase tracking-wide">
          Scheduled Event Settings
        </span>

        {/* Schedule Status toggle */}
        <FormField
          label="Schedule Status"
          tooltip="Master on/off switch. When disabled, the schedule is preserved but will not fire."
          bookmarkId="schedule.status"
        >
          <div className="flex items-center gap-3">
            <label className="relative inline-flex h-5 w-9 items-center">
              <input
                type="checkbox"
                checked={state.scheduleEnabled}
                onChange={e => update({ scheduleEnabled: e.target.checked })}
                disabled={isDisabled}
                className="peer sr-only"
              />
              <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-[var(--app-link)] peer-disabled:opacity-50" />
              <span className="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
            </label>
            <span className="text-xs text-[var(--app-fg)]">
              {state.scheduleEnabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        </FormField>
      </div>

      {/* === Everything below — grayed out when schedule is disabled === */}
      <div
        className={`flex flex-col divide-y divide-[var(--app-divider)] transition-opacity duration-200 ${
          !state.scheduleEnabled ? "opacity-50" : ""
        }`}
      >
        {/* Core fields: Prompt, Overlap/Notify, Max Runtime */}
        <div className="px-3 py-2.5 flex flex-col gap-2.5">
          {/* Prompt — label + toolbar merged on one row via PromptTextarea */}
          <PromptTextarea
            label="Prompt"
            tooltip="The message sent to the LLM each time this scheduled event fires."
            bookmarkId="schedule.prompt"
            value={state.prompt}
            onChange={prompt => update({ prompt })}
            isDisabled={isDisabled}
          />

          {/* Grid: overlap + notify */}
          <div className="grid grid-cols-2 gap-2">
            <FormField
              label="On Overlap"
              tooltip="What to do if the previous run is still active when next fires."
              bookmarkId="schedule.overlap"
            >
              <UiSelect
                value={state.overlapPolicy}
                onChange={e =>
                  update({ overlapPolicy: e.target.value as OverlapPolicy })
                }
                disabled={isDisabled}
              >
                <option value="skip">Skip</option>
                <option value="queue">Queue</option>
                <option value="allow">Allow</option>
              </UiSelect>
            </FormField>

            <FormField
              label="Notify"
              tooltip="When to send push notifications about task execution."
              bookmarkId="schedule.notify"
            >
              <UiSelect
                value={state.notifyOn}
                onChange={e => update({ notifyOn: e.target.value as NotifyOn })}
                disabled={isDisabled}
              >
                <option value="both">Both</option>
                <option value="completion">Completion</option>
                <option value="error">Error only</option>
                <option value="none">None</option>
              </UiSelect>
            </FormField>
          </div>

          {/* Max runtime */}
          <FormField
            label="Max Runtime (minutes)"
            hint="leave empty for no limit"
            tooltip="Maximum time a single scheduled session run is allowed to execute before being terminated."
            bookmarkId="schedule.maxRuntime"
          >
            <UiInput
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              min="1"
              value={state.maxRuntimeMinutes}
              onChange={e => update({ maxRuntimeMinutes: e.target.value })}
              onFocus={e => e.target.select()}
              disabled={isDisabled}
              placeholder="120"
            />
          </FormField>
        </div>

        {/* === Session Lifecycle (hidden for heartbeat mode) === */}
        {!state.heartbeatMode && (
          <CollapsibleLayer
            title="Session Lifecycle"
            isOpen={lifecycleOpen}
            onToggle={() => setLifecycleOpen(!lifecycleOpen)}
            badge={
              state.preWorkInstructions || state.closingInstructions
                ? "Configured"
                : "None"
            }
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <InstructionsTextarea
                  label="Pre-Work Instructions"
                  tooltip="Lifecycle setup that runs before your prompt: authentication, guard file creation, and stale session cleanup."
                  bookmarkId="schedule.preWork"
                  dialogTitle="Pre-Work Instructions"
                  value={state.preWorkInstructions}
                  onChange={v => update({ preWorkInstructions: v })}
                  isDisabled={isDisabled}
                  placeholder="# Pre-work instructions (bash/shell commands for Claude to run)"
                />
                {state.preWorkInstructions !==
                  DEFAULT_PRE_WORK_INSTRUCTIONS && (
                  <Button
                    type="button"
                    variant="ghostStatic"
                    size="bare"
                    onClick={() =>
                      update({
                        preWorkInstructions: DEFAULT_PRE_WORK_INSTRUCTIONS,
                      })
                    }
                    className="self-end text-[length:var(--text-caption-xs)] font-normal text-[var(--app-link)] hover:text-[var(--app-fg)] hover:underline"
                  >
                    Reset to default
                  </Button>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <InstructionsTextarea
                  label="Closing Instructions"
                  tooltip="Lifecycle teardown that runs after your prompt: guard file cleanup and session self-archive."
                  bookmarkId="schedule.closing"
                  dialogTitle="Closing Instructions"
                  value={state.closingInstructions}
                  onChange={v => update({ closingInstructions: v })}
                  isDisabled={isDisabled}
                  placeholder="# Closing instructions (bash/shell commands for Claude to run)"
                />
                {state.closingInstructions !== DEFAULT_CLOSING_INSTRUCTIONS && (
                  <Button
                    type="button"
                    variant="ghostStatic"
                    size="bare"
                    onClick={() =>
                      update({
                        closingInstructions: DEFAULT_CLOSING_INSTRUCTIONS,
                      })
                    }
                    className="self-end text-[length:var(--text-caption-xs)] font-normal text-[var(--app-link)] hover:text-[var(--app-fg)] hover:underline"
                  >
                    Reset to default
                  </Button>
                )}
              </div>
            </div>
          </CollapsibleLayer>
        )}

        {/* === Timezone (collapsed by default) === */}
        <CollapsibleLayer
          title="Timezone"
          isOpen={timezoneOpen}
          onToggle={() => setTimezoneOpen(!timezoneOpen)}
          badge={formatTimezoneBadge(state.timezone, state.dstAdjustment)}
        >
          <div className="flex flex-col gap-2.5">
            <FormField
              label="Timezone"
              tooltip="All schedule times are interpreted in this timezone. The DST checkbox controls daylight-saving adjustment."
              bookmarkId="schedule.timezone"
            >
              <TimezoneSelect
                value={state.timezone}
                onChange={timezone => update({ timezone })}
                disabled={isDisabled}
              />
            </FormField>

            <label className="flex items-center gap-2 text-xs text-[var(--app-fg)] cursor-pointer">
              <input
                type="checkbox"
                checked={state.dstAdjustment}
                onChange={e => update({ dstAdjustment: e.target.checked })}
                disabled={isDisabled}
                className="accent-[var(--app-link)]"
              />
              DST Adjustment
            </label>
          </div>
        </CollapsibleLayer>

        {/* === Layer 1: Schedule Lifetime === */}
        <CollapsibleLayer
          title="Schedule Lifetime"
          isOpen={layer1Open}
          onToggle={() => setLayer1Open(!layer1Open)}
          badge={formatLifetimeBadge(state.lifetimeStart, state.lifetimeEnd)}
        >
          <ScheduleLifetimePicker
            startAt={state.lifetimeStart}
            endAt={state.lifetimeEnd}
            onStartChange={v => update({ lifetimeStart: v })}
            onEndChange={v => update({ lifetimeEnd: v })}
            isDisabled={isDisabled}
          />
        </CollapsibleLayer>

        {/* === Layer 2: Operating Schedule === */}
        <CollapsibleLayer
          title="Operating Schedule"
          isOpen={layer2Open}
          onToggle={() => setLayer2Open(!layer2Open)}
          badge={formatOperatingBadge(
            state.everyNWeeks,
            state.activeDays,
            state.clockIn,
            state.clockOut
          )}
        >
          <OperatingSchedulePicker
            everyNWeeks={state.everyNWeeks}
            activeDays={state.activeDays}
            clockIn={state.clockIn}
            clockOut={state.clockOut}
            onEveryNWeeksChange={v => update({ everyNWeeks: v })}
            onActiveDaysChange={v => update({ activeDays: v })}
            onClockInChange={v => update({ clockIn: v })}
            onClockOutChange={v => update({ clockOut: v })}
            isDisabled={isDisabled}
          />
        </CollapsibleLayer>

        {/* === Layer 3: Exclusion Schedule === */}
        <CollapsibleLayer
          title="Exclusion Schedule"
          isOpen={layer3Open}
          onToggle={() => setLayer3Open(!layer3Open)}
          badge={
            state.exclusions.length > 0
              ? `${state.exclusions.length} active`
              : "None"
          }
        >
          <ExclusionListEditor
            exclusions={state.exclusions}
            onChange={exclusions => update({ exclusions })}
            isDisabled={isDisabled}
          />
        </CollapsibleLayer>

        {/* === Layer 4: Event Timing (expanded by default) === */}
        <CollapsibleLayer
          title="Event Timing"
          isOpen={layer4Open}
          onToggle={() => setLayer4Open(!layer4Open)}
          badge={formatIntervalBadge(state.intervalMs)}
        >
          <EventTimingSection
            intervalMs={state.intervalMs}
            eventCountLimit={state.eventCountLimit}
            backoffEnabled={state.backoffEnabled}
            backoffMultiplier={state.backoffMultiplier}
            backoffThreshold={state.backoffThreshold}
            jitterMs={state.jitterMs}
            heartbeatMode={state.heartbeatMode}
            onIntervalChange={v => update({ intervalMs: v })}
            onEventCountLimitChange={v => update({ eventCountLimit: v })}
            onBackoffEnabledChange={v => update({ backoffEnabled: v })}
            onBackoffMultiplierChange={v => update({ backoffMultiplier: v })}
            onBackoffThresholdChange={v => update({ backoffThreshold: v })}
            onJitterChange={v => update({ jitterMs: v })}
            isDisabled={isDisabled}
          />
        </CollapsibleLayer>

        {/* === Layer 5: Response Handling === */}
        <CollapsibleLayer
          title="Response Handling"
          isOpen={layer5Open}
          onToggle={() => setLayer5Open(!layer5Open)}
          badge={`${state.responseSuppression || "0"} chars`}
        >
          <FormField
            label="Suppression Threshold"
            hint="characters"
            tooltip="Responses shorter than this character count are suppressed from push notifications. Useful for heartbeat sessions that return short acknowledgment tokens."
            bookmarkId="schedule.suppression"
          >
            <input
              autoCapitalize="none"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={state.responseSuppression}
              onChange={e => update({ responseSuppression: e.target.value })}
              onFocus={e => e.target.select()}
              disabled={isDisabled}
              placeholder="100"
              className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
          </FormField>
        </CollapsibleLayer>

        {/* === Heartbeat Mode === */}
        <CollapsibleLayer
          title="Heartbeat Mode"
          isOpen={heartbeatOpen}
          onToggle={() => setHeartbeatOpen(!heartbeatOpen)}
          badge={state.heartbeatMode ? "ON" : "OFF"}
          badgeVariant={state.heartbeatMode ? "default" : "muted"}
        >
          <HeartbeatModeSection
            heartbeatMode={state.heartbeatMode}
            standingOrdersMode={state.standingOrdersMode}
            standingOrdersText={state.standingOrdersText}
            standingOrdersFile={state.standingOrdersFile}
            ackToken={state.ackToken}
            rotationMode={state.rotationMode}
            rotationDays={state.rotationDays}
            rotationTime={state.rotationTime}
            rotationCount={state.rotationCount}
            onHeartbeatModeChange={v => update({ heartbeatMode: v })}
            onStandingOrdersModeChange={v => update({ standingOrdersMode: v })}
            onStandingOrdersTextChange={v => update({ standingOrdersText: v })}
            onStandingOrdersFileChange={v => update({ standingOrdersFile: v })}
            onAckTokenChange={v => update({ ackToken: v })}
            onRotationModeChange={v => update({ rotationMode: v })}
            onRotationDaysChange={v => update({ rotationDays: v })}
            onRotationTimeChange={v => update({ rotationTime: v })}
            onRotationCountChange={v => update({ rotationCount: v })}
            isDisabled={isDisabled}
            api={props.api}
            machineId={props.machineId}
            nodeId={props.nodeId}
          />
        </CollapsibleLayer>

        {/* === Run Once at Creation === */}
        <div className="px-3 py-2.5">
          <FormField
            label="Run Once at Creation"
            tooltip="When enabled, the scheduled task fires once immediately when created, regardless of the interval timer. For recurring tasks this ensures no gap before the first execution. For heartbeat agents this guarantees an initial health check. For one-shot tasks (event count limit = 1) this is the primary trigger mechanism."
            bookmarkId="schedule.runOnce"
          >
            <div className="flex items-center gap-3">
              <label className="relative inline-flex h-5 w-9 items-center">
                <input
                  type="checkbox"
                  checked={state.runOnceAtCreation}
                  onChange={e =>
                    update({ runOnceAtCreation: e.target.checked })
                  }
                  disabled={isDisabled}
                  className="peer sr-only"
                />
                <span className="absolute inset-0 rounded-full bg-[var(--app-border)] transition-colors peer-checked:bg-[var(--app-link)] peer-disabled:opacity-50" />
                <span className="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--app-bg)] transition-transform peer-checked:translate-x-4 peer-disabled:opacity-50" />
              </label>
              <span className="text-xs text-[var(--app-fg)]">
                {state.runOnceAtCreation ? "Enabled" : "Disabled"}
              </span>
            </div>
          </FormField>
        </div>
      </div>
    </div>
  );
}
