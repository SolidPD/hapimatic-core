// SPDX-License-Identifier: AGPL-3.0-only
import { FormField } from "./FormField";
import { Button } from "@/components/ui/button";
import { BareButton } from "@/components/ui/BareButton";

function nowDatetimeLocal(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function ScheduleLifetimePicker(props: {
  startAt: string;
  endAt: string;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  isDisabled?: boolean;
}) {
  const {
    startAt,
    endAt,
    onStartChange,
    onEndChange,
    isDisabled = false,
  } = props;

  return (
    <div className="flex flex-col gap-2.5 min-[480px]:flex-row min-[480px]:gap-3">
      <div className="min-w-0 flex-1">
        <FormField
          label="Start"
          tooltip="When this schedule becomes active. Also serves as the anchor point for week-cycle calculations."
          bookmarkId="schedule.lifetimeStart"
        >
          <div className="flex gap-1.5">
            <input
              type="datetime-local"
              value={startAt}
              onChange={e => onStartChange(e.target.value)}
              disabled={isDisabled}
              className="flex-1 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
            />
            <BareButton
              type="button"
              onClick={() => onStartChange(nowDatetimeLocal())}
              disabled={isDisabled}
              className="shrink-0 rounded-md border border-[var(--app-border)] px-2 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-50"
              title="Reset to now"
            >
              Now
            </BareButton>
          </div>
        </FormField>
      </div>

      <div className="min-w-0 flex-1">
        <FormField
          label="End"
          hint={!endAt ? "never" : undefined}
          tooltip="When this schedule expires. Leave empty for no end date."
          bookmarkId="schedule.lifetimeEnd"
        >
          <div className="flex gap-1.5">
            {endAt ? (
              <>
                <input
                  type="datetime-local"
                  value={endAt}
                  onChange={e => onEndChange(e.target.value)}
                  disabled={isDisabled}
                  className="flex-1 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50"
                />
                <BareButton
                  type="button"
                  onClick={() => onEndChange("")}
                  disabled={isDisabled}
                  className="shrink-0 rounded-md border border-[var(--app-border)] px-2 py-1 text-[length:var(--text-caption-xs)] font-medium text-[var(--app-hint)] hover:text-[var(--app-fg)] hover:bg-[var(--app-hover)] transition-colors disabled:opacity-50"
                  title="Set to never"
                >
                  Never
                </BareButton>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={() => onEndChange(nowDatetimeLocal())}
                disabled={isDisabled}
                className="h-auto w-full justify-start rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-bg)] p-2 text-left text-sm font-normal text-[var(--app-hint)] hover:bg-[var(--app-hover)] hover:text-[var(--app-fg)] disabled:opacity-50"
              >
                Never — tap to set end date
              </Button>
            )}
          </div>
        </FormField>
      </div>
    </div>
  );
}
