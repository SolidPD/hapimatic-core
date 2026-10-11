// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { DayOfWeekSelector } from "./DayOfWeekSelector";
import { BareButton } from "@/components/ui/BareButton";

function nowTimeLocal(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function OperatingSchedulePicker(props: {
  everyNWeeks: number;
  activeDays: boolean[];
  clockIn: string;
  clockOut: string;
  onEveryNWeeksChange: (n: number) => void;
  onActiveDaysChange: (days: boolean[]) => void;
  onClockInChange: (time: string) => void;
  onClockOutChange: (time: string) => void;
  isDisabled?: boolean;
}) {
  const {
    everyNWeeks,
    activeDays,
    clockIn,
    clockOut,
    onEveryNWeeksChange,
    onActiveDaysChange,
    onClockInChange,
    onClockOutChange,
    isDisabled = false,
  } = props;

  return (
    <div className="flex flex-col gap-2.5">
      <FormField
        label="Every X Weeks"
        tooltip="How many weeks between active periods. 'Every 1 week' means every week. The cycle anchors to the Schedule Lifetime start date."
        bookmarkId="schedule.everyNWeeks"
      >
        <input
          autoCapitalize="none"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          min="1"
          value={everyNWeeks}
          onChange={e => {
            const v = Math.max(1, parseInt(e.target.value) || 1);
            onEveryNWeeksChange(v);
          }}
          onFocus={e => e.target.select()}
          disabled={isDisabled}
          className="w-full rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
        />
      </FormField>

      <FormField
        label="Active Days"
        tooltip="On active weeks, which days the schedule is eligible to fire."
        bookmarkId="schedule.activeDays"
      >
        <DayOfWeekSelector
          activeDays={activeDays}
          onChange={onActiveDaysChange}
          isDisabled={isDisabled}
        />
      </FormField>

      <div className="grid grid-cols-2 gap-2">
        <FormField
          label="Clock-in"
          tooltip="Start of the daily active window."
          bookmarkId="schedule.clockIn"
        >
          <div className="flex gap-1">
            <input
              type="time"
              value={clockIn}
              onChange={e => onClockInChange(e.target.value)}
              disabled={isDisabled}
              className="flex-1 min-w-0 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <BareButton
              type="button"
              onClick={() => onClockInChange(nowTimeLocal())}
              disabled={isDisabled}
              className="shrink-0 rounded-md border border-[var(--app-border)] px-1.5 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-30"
              title="Set to current time"
            >
              Now
            </BareButton>
          </div>
        </FormField>

        <FormField
          label="Clock-out"
          tooltip="End of the daily active window."
          bookmarkId="schedule.clockOut"
        >
          <div className="flex gap-1">
            <input
              type="time"
              value={clockOut}
              onChange={e => onClockOutChange(e.target.value)}
              disabled={isDisabled}
              className="flex-1 min-w-0 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <BareButton
              type="button"
              onClick={() => onClockOutChange(nowTimeLocal())}
              disabled={isDisabled}
              className="shrink-0 rounded-md border border-[var(--app-border)] px-1.5 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-30"
              title="Set to current time"
            >
              Now
            </BareButton>
          </div>
        </FormField>
      </div>
    </div>
  );
}
