// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useCallback, useEffect } from "react";
import type { ApiClient } from "@/api/client";
import type { HeartbeatConfig, HeartbeatStatus } from "@/types/api";
import {
  useHeartbeatConfig,
  useHeartbeatStatus,
} from "@/extensions/heartbeat/useHeartbeat";
import { useHeartbeatMutations } from "@/extensions/heartbeat/useHeartbeatActions";
import {
  IntervalPicker,
  formatInterval,
} from "@/components/NewSession/IntervalPicker";
import { FormField, Tooltip } from "@/components/NewSession/FormField";
import { TimezoneSelect } from "@/components/NewSession/TimezoneSelect";
import { InstructionsEditorModal } from "@/extensions/heartbeat/InstructionsEditorModal";
import { HeartbeatHistoryModal } from "@/extensions/heartbeat/HeartbeatHistoryModal";

export function HeartbeatSettings(props: {
  api: ApiClient;
  isDisabled?: boolean;
}) {
  const { api, isDisabled = false } = props;
  const { config, isLoading: configLoading } = useHeartbeatConfig(api);
  const { status } = useHeartbeatStatus(api);
  const { updateConfig, isPending } = useHeartbeatMutations(api);

  // Local form state — synced from server config when loaded
  const [enabled, setEnabled] = useState(false);
  const [activeStartTime, setActiveStartTime] = useState("08:00");
  const [activeEndTime, setActiveEndTime] = useState("22:00");
  const [activeTimezone, setActiveTimezone] = useState("America/New_York");
  const [tickIntervalMs, setTickIntervalMs] = useState(1_800_000); // 30 min default
  const [rotateAfterBeats, setRotateAfterBeats] = useState(48);
  const [rotateAfterBeatsStr, setRotateAfterBeatsStr] = useState("48");
  const [ackMaxChars, setAckMaxChars] = useState(300);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Sync form state from server config
  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setActiveStartTime(
        `${String(config.activeHours.start).padStart(2, "0")}:00`
      );
      setActiveEndTime(`${String(config.activeHours.end).padStart(2, "0")}:00`);
      setActiveTimezone(config.activeHours.timezone);
      setTickIntervalMs(config.every);
      setRotateAfterBeats(config.rotateAfterBeats);
      setRotateAfterBeatsStr(String(config.rotateAfterBeats));
      setAckMaxChars(config.ackMaxChars);
    }
  }, [config]);

  const handleSave = useCallback(async () => {
    setSaveError(null);
    setSaveSuccess(false);
    try {
      await updateConfig({
        enabled,
        every: tickIntervalMs,
        activeHours: {
          start: parseInt(activeStartTime.split(":")[0], 10),
          end: parseInt(activeEndTime.split(":")[0], 10),
          timezone: activeTimezone,
        },
        rotateAfterBeats,
        ackMaxChars,
      });
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    }
  }, [
    enabled,
    tickIntervalMs,
    activeStartTime,
    activeEndTime,
    activeTimezone,
    rotateAfterBeats,
    ackMaxChars,
    updateConfig,
  ]);

  if (configLoading) {
    return (
      <div className="px-3 py-3 text-sm text-[var(--app-hint)]">
        Loading heartbeat config...
      </div>
    );
  }

  const tickTranslation = formatInterval(rotateAfterBeats * tickIntervalMs);

  return (
    <>
      <div className="flex flex-col gap-2.5 px-3 py-2.5">
        {saveError && (
          <div className="rounded-lg bg-red-500/10 p-2 text-xs text-red-400">
            {saveError}
          </div>
        )}

        {/* Enable/disable toggle */}
        <label className="flex items-center gap-2 text-sm text-[var(--app-fg)]">
          <input
            type="checkbox"
            checked={enabled}
            onChange={e => setEnabled(e.target.checked)}
            disabled={isDisabled || isPending}
            className="h-4 w-4 rounded border-[var(--app-border)] accent-[var(--brand-accent)]"
          />
          Enable heartbeat
          <Tooltip text="When enabled, the heartbeat system runs periodic autonomous sessions within active hours" />
        </label>

        {/* Active hours */}
        <FormField
          label="Active Hours"
          tooltip="Heartbeats only fire within this time window"
        >
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={activeStartTime}
              onChange={e => setActiveStartTime(e.target.value)}
              disabled={isDisabled || isPending}
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <span className="text-xs text-[var(--app-hint)]">to</span>
            <input
              type="time"
              value={activeEndTime}
              onChange={e => setActiveEndTime(e.target.value)}
              disabled={isDisabled || isPending}
              className="rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <NowButton
              onSetStart={setActiveStartTime}
              onSetEnd={setActiveEndTime}
              disabled={isDisabled || isPending}
            />
          </div>
        </FormField>

        {/* Timezone */}
        <FormField
          label="Timezone"
          tooltip="IANA timezone for active hours window"
        >
          <TimezoneSelect
            value={activeTimezone}
            onChange={setActiveTimezone}
            disabled={isDisabled || isPending}
          />
        </FormField>

        {/* Tick interval */}
        <FormField
          label="Tick Interval"
          tooltip="Time between each heartbeat tick. Determines how often the agent is prompted."
        >
          <IntervalPicker
            valueMs={tickIntervalMs}
            onChange={setTickIntervalMs}
            isDisabled={isDisabled || isPending}
          />
        </FormField>

        {/* Rotation interval */}
        <FormField
          label="Rotation Interval"
          tooltip="Session is rotated (archived + fresh spawn) after this many ticks"
        >
          <div className="flex items-center gap-2">
            <input
              autoCapitalize="none"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={rotateAfterBeatsStr}
              onChange={e => {
                const raw = e.target.value.replace(/\D/g, "");
                setRotateAfterBeatsStr(raw);
                const parsed = parseInt(raw, 10);
                if (parsed > 0) setRotateAfterBeats(parsed);
              }}
              onBlur={() => {
                const parsed = parseInt(rotateAfterBeatsStr, 10);
                if (!parsed || parsed < 1) {
                  setRotateAfterBeats(1);
                  setRotateAfterBeatsStr("1");
                }
              }}
              onFocus={e => e.target.select()}
              disabled={isDisabled || isPending}
              className="w-20 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 text-center text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <span className="text-xs text-[var(--app-hint)]">
              ticks = {tickTranslation}
            </span>
          </div>
        </FormField>

        {/* ackMaxChars */}
        <FormField
          label="Suppression Threshold"
          tooltip="Responses shorter than this (in characters) are treated as HEARTBEAT_OK and suppressed from notifications"
        >
          <input
            autoCapitalize="none"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={ackMaxChars}
            onChange={e => {
              const raw = e.target.value.replace(/\D/g, "");
              setAckMaxChars(parseInt(raw, 10) || 0);
            }}
            onFocus={e => e.target.select()}
            disabled={isDisabled || isPending}
            className="w-20 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 text-center text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
          />
        </FormField>

        {/* Instructions file editor link */}
        <button
          type="button"
          onClick={() => setInstructionsOpen(true)}
          disabled={isDisabled}
          className="flex items-center gap-1.5 text-sm text-[var(--app-link)] hover:underline disabled:opacity-50"
        >
          Edit Instructions File
        </button>

        {/* Health mini-dashboard */}
        <HealthDashboard status={status} />

        {/* History link */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          disabled={isDisabled}
          className="flex items-center gap-1.5 text-sm text-[var(--app-link)] hover:underline disabled:opacity-50"
        >
          View Heartbeat History
        </button>

        {/* Save button */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {saveSuccess && <span className="text-xs text-green-400">Saved</span>}
          <button
            type="button"
            onClick={handleSave}
            disabled={isDisabled || isPending}
            className="rounded-lg bg-[var(--brand-accent)] px-4 py-1.5 text-sm font-medium text-[var(--brand-primary)] transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            {isPending ? "Saving..." : "Save Configuration"}
          </button>
        </div>
      </div>

      <InstructionsEditorModal
        api={api}
        isOpen={instructionsOpen}
        onClose={() => setInstructionsOpen(false)}
      />
      <HeartbeatHistoryModal
        api={api}
        isOpen={historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
    </>
  );
}

function NowButton(props: {
  onSetStart: (time: string) => void;
  onSetEnd: (time: string) => void;
  disabled?: boolean;
}) {
  const handleNow = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    props.onSetStart(`${hh}:${mm}`);
  };

  return (
    <button
      type="button"
      onClick={handleNow}
      disabled={props.disabled}
      className="shrink-0 rounded-md border border-[var(--app-border)] bg-[var(--app-secondary-bg)] px-2 py-1 text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-50"
    >
      Now
    </button>
  );
}

function HealthDashboard(props: { status: HeartbeatStatus | null }) {
  const { status } = props;
  if (!status) return null;

  return (
    <div className="rounded-lg bg-[var(--app-secondary-bg)] p-2.5 text-xs text-[var(--app-hint)]">
      <div className="flex items-center gap-1.5 mb-1.5 text-sm font-medium text-[var(--app-fg)]">
        <span
          className={`h-2 w-2 rounded-full ${
            status.running ? "bg-green-400" : "bg-gray-500"
          }`}
        />
        {status.running ? "Running" : "Stopped"}
      </div>
      <div className="grid grid-cols-2 gap-1">
        <span>Beats since rotation:</span>
        <span className="text-[var(--app-fg)]">
          {status.beatsSinceRotation}
        </span>
        <span>Last tick:</span>
        <span className="text-[var(--app-fg)]">
          {status.lastTickAt
            ? new Date(status.lastTickAt).toLocaleTimeString()
            : "—"}
        </span>
        <span>Next tick:</span>
        <span className="text-[var(--app-fg)]">
          {status.nextTickAt
            ? new Date(status.nextTickAt).toLocaleTimeString()
            : "—"}
        </span>
        <span>Consecutive failures:</span>
        <span
          className={
            status.consecutiveFailures > 0
              ? "text-red-400"
              : "text-[var(--app-fg)]"
          }
        >
          {status.consecutiveFailures}
        </span>
      </div>
    </div>
  );
}
