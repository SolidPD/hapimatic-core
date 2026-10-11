// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback } from "react";
import { FormField, Tooltip } from "./FormField";
import { BookmarkToggle } from "./bookmarkContext";
import { UiToggle } from "./controls";
import { IntervalPicker } from "./IntervalPicker";

export function EventTimingSection(props: {
  intervalMs: number;
  eventCountLimit: string;
  backoffEnabled: boolean;
  backoffMultiplier: string;
  backoffThreshold: string;
  jitterMs: number;
  heartbeatMode: boolean;
  onIntervalChange: (ms: number) => void;
  onEventCountLimitChange: (value: string) => void;
  onBackoffEnabledChange: (enabled: boolean) => void;
  onBackoffMultiplierChange: (value: string) => void;
  onBackoffThresholdChange: (value: string) => void;
  onJitterChange: (ms: number) => void;
  isDisabled?: boolean;
}) {
  const {
    intervalMs,
    eventCountLimit,
    backoffEnabled,
    backoffMultiplier,
    backoffThreshold,
    jitterMs,
    heartbeatMode,
    onIntervalChange,
    onEventCountLimitChange,
    onBackoffEnabledChange,
    onBackoffMultiplierChange,
    onBackoffThresholdChange,
    onJitterChange,
    isDisabled = false,
  } = props;

  // Jitter: MM:SS decomposition
  const jitterMinutes = Math.floor(jitterMs / 60_000);
  const jitterSeconds = Math.round((jitterMs % 60_000) / 1000);

  return (
    <div className="flex flex-col gap-2.5">
      {/* Event Interval + Event Count Limit share one row — Interval's d/h/m
        inputs take only their natural width, and the single-number Count Limit
        fills the rest, saving a row. */}
      <div className="flex items-start gap-3">
        <FormField
          label="Event Interval"
          tooltip="Within the Operating Schedule, how frequently the scheduled session fires."
          bookmarkId="schedule.interval"
        >
          <IntervalPicker
            valueMs={intervalMs}
            onChange={onIntervalChange}
            isDisabled={isDisabled}
            minMs={30_000}
          />
        </FormField>

        <div className="min-w-0 flex-1">
          <FormField
            label="Event Count Limit"
            hint="leave empty for no limit"
            tooltip="Maximum number of times this event fires across its entire lifetime. After reaching this count, the schedule is automatically disabled."
            bookmarkId="schedule.eventCountLimit"
          >
            <div className="relative">
              <input
                autoCapitalize="none"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={eventCountLimit}
                onChange={e => onEventCountLimitChange(e.target.value)}
                onFocus={e => e.target.select()}
                disabled={isDisabled || heartbeatMode}
                placeholder="No limit"
                className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
              />
              {heartbeatMode && (
                <span
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-red-400 text-sm"
                  title="Not applicable in heartbeat mode — this value will be ignored."
                >
                  *
                </span>
              )}
            </div>
          </FormField>
        </div>
      </div>

      {/* Failure Backoff — the heading sits on the SAME label row as the
        Multiplier / Threshold sub-labels (three columns, each label above its
        control) so the heading is no longer separated from its switch. The
        heading keeps its normal label size; the smaller sub-label font is what
        marks Multiplier/Threshold as subheadings. */}
      <div className="flex items-start gap-4">
        <div className="shrink-0">
          <label className="mb-0.5 flex items-center gap-1 text-xs font-medium text-[var(--app-hint)]">
            Failure Backoff
            <Tooltip text="When enabled, the system increases the interval between firing attempts after consecutive failures." />
            <BookmarkToggle id="schedule.backoff" />
          </label>
          <div className="flex h-9 items-center">
            <UiToggle
              checked={backoffEnabled}
              onChange={onBackoffEnabledChange}
              disabled={isDisabled}
            />
          </div>
        </div>

        {/* Multiplier + Threshold always render — when backoff is OFF they
            stay visible but grayed-out + disabled (so the user can see the
            configured values without them being active). */}
        <div
          className={`w-24 transition-opacity ${
            backoffEnabled ? "" : "opacity-50"
          }`}
        >
          <label className="mb-0.5 flex items-center gap-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
            Multiplier
            <Tooltip text="The factor by which the interval increases after each consecutive failure. Example: with multiplier 2 and base interval 30m, delays become 30m → 60m → 120m." />
            <BookmarkToggle id="schedule.backoffMultiplier" />
          </label>
          <input
            autoCapitalize="none"
            type="text"
            inputMode="decimal"
            value={backoffMultiplier}
            onChange={e => onBackoffMultiplierChange(e.target.value)}
            onFocus={e => e.target.select()}
            disabled={isDisabled || !backoffEnabled}
            placeholder="2"
            className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
          />
        </div>
        <div
          className={`w-24 transition-opacity ${
            backoffEnabled ? "" : "opacity-50"
          }`}
        >
          <label className="mb-0.5 flex items-center gap-1 text-[length:var(--text-caption-xs)] text-[var(--app-hint)]">
            Threshold
            <Tooltip text="Number of consecutive failures before backoff activates. Until this count is reached, the schedule fires at its normal interval." />
            <BookmarkToggle id="schedule.backoffThreshold" />
          </label>
          <input
            autoCapitalize="none"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={backoffThreshold}
            onChange={e => onBackoffThresholdChange(e.target.value)}
            onFocus={e => e.target.select()}
            disabled={isDisabled || !backoffEnabled}
            placeholder="3"
            className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
          />
        </div>
      </div>

      {/* Jitter Window */}
      <FormField
        label="Jitter Window"
        hint="MM:SS"
        tooltip="Adds a small random delay to each scheduled firing to prevent multiple events from triggering at the same time (thundering herd)."
        bookmarkId="schedule.jitter"
      >
        <div className="flex items-center gap-1.5 text-sm text-[var(--app-fg)]">
          <div className="flex items-center gap-1">
            <input
              autoCapitalize="none"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              min="0"
              max="59"
              value={jitterMinutes}
              onChange={e => {
                const m = Math.min(
                  59,
                  Math.max(0, parseInt(e.target.value) || 0)
                );
                onJitterChange(m * 60_000 + jitterSeconds * 1000);
              }}
              onFocus={e => e.target.select()}
              disabled={isDisabled}
              className="w-14 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-center text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <span className="text-xs text-[var(--app-hint)]">m</span>
          </div>
          <div className="flex items-center gap-1">
            <input
              autoCapitalize="none"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              min="0"
              max="59"
              value={jitterSeconds}
              onChange={e => {
                const s = Math.min(
                  59,
                  Math.max(0, parseInt(e.target.value) || 0)
                );
                onJitterChange(jitterMinutes * 60_000 + s * 1000);
              }}
              onFocus={e => e.target.select()}
              disabled={isDisabled}
              className="w-14 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-center text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <span className="text-xs text-[var(--app-hint)]">s</span>
          </div>
        </div>
      </FormField>
    </div>
  );
}
