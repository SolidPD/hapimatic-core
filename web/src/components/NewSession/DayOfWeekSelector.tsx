// SPDX-License-Identifier: AGPL-3.0-only
import { Button } from "@/components/ui/button";

const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"] as const;

export function DayOfWeekSelector(props: {
  activeDays: boolean[];
  onChange: (days: boolean[]) => void;
  isDisabled?: boolean;
}) {
  const { activeDays, onChange, isDisabled = false } = props;

  const toggle = (index: number) => {
    const next = [...activeDays];
    next[index] = !next[index];
    onChange(next);
  };

  return (
    <div className="flex gap-1.5">
      {DAY_LABELS.map((label, i) => {
        const active = activeDays[i] ?? false;
        return (
          <Button
            key={i}
            type="button"
            variant="ghost"
            onClick={() => toggle(i)}
            disabled={isDisabled}
            className={`h-8 w-8 rounded-md p-0 text-xs font-medium transition-colors ${
              active
                ? "bg-[var(--app-link)] text-white hover:bg-[var(--app-link)] hover:text-white"
                : "border border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] hover:bg-[var(--app-bg)] hover:text-[var(--app-hint)]"
            } disabled:opacity-50`}
          >
            {label}
          </Button>
        );
      })}
    </div>
  );
}
