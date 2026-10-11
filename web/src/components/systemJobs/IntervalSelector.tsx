// SPDX-License-Identifier: AGPL-3.0-only
import {
  parseInterval,
  formatInterval,
  UNIT_BOUNDS,
  type IntervalUnit,
} from "./loopCronInterval";

/**
 * IntervalSelector — a constrained interval picker for loop-cron schedules
 * (issue #3294, Session-UI Redesign S9).
 *
 * Replaces the loop-cron schedule's bare-text field: a numeric field + a unit
 * dropdown offering **m and h ONLY**, with per-unit clamps (m: 1-59, h: 1-23)
 * that re-clamp when the unit switches (e.g. 45 with m→h clamps to 23). It is a
 * thin input-constraint layer — `value`/`onChange` are the interval STRING form
 * (`"5m"`, `"1h"`) so it drops straight into the existing `reschedule` flow with
 * no scheduler-backend change (R1/R2). Because every emission routes through
 * `formatInterval` (which clamps), the selector CANNOT produce a value the
 * backend grammar `1-59m | 1-23h` rejects.
 *
 * Interaction modelled on `NewSession/OperatingSchedulePicker.tsx` (numeric input
 * + clamp-on-change). A `value` that does not parse (a cron expression, an
 * out-of-grammar legacy value, or empty) renders as an EMPTY number field on the
 * `m` unit and emits nothing until the user picks a value — so a non-simple
 * stored schedule is never silently corrupted (R3, graceful degrade). The
 * consuming card owns the "this is a custom schedule" note (it alone knows the
 * cron form) and gates its Apply button on `parseInterval(value)`.
 */
export function IntervalSelector({
  value,
  onChange,
  disabled = false,
  testIdPrefix = "interval",
}: {
  /** The interval string form (`"5m"` / `"1h"`); unparseable values degrade. */
  value: string;
  /** Emits the new interval string; always grammar-valid. */
  onChange: (interval: string) => void;
  disabled?: boolean;
  /** Prefix for the number/unit `data-testid`s. */
  testIdPrefix?: string;
}) {
  const parsed = parseInterval(value);
  const unit: IntervalUnit = parsed?.unit ?? "m";
  // For clamp math when the field is empty/unparseable, anchor at the unit floor.
  const num = parsed?.value ?? UNIT_BOUNDS[unit].min;

  const clampFor = (u: IntervalUnit, n: number): number => {
    const { min, max } = UNIT_BOUNDS[u];
    return Math.min(max, Math.max(min, n));
  };

  const handleNumberChange = (raw: string) => {
    const n = clampFor(unit, parseInt(raw, 10) || UNIT_BOUNDS[unit].min);
    onChange(formatInterval({ value: n, unit }));
  };

  const handleUnitChange = (nextUnit: IntervalUnit) => {
    // Re-clamp the current number into the new unit's bounds (45m → 23h).
    onChange(
      formatInterval({ value: clampFor(nextUnit, num), unit: nextUnit })
    );
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        autoCapitalize="none"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={parsed ? num : ""}
        onChange={e => handleNumberChange(e.target.value)}
        onFocus={e => e.target.select()}
        disabled={disabled}
        aria-label="Interval value"
        data-testid={`${testIdPrefix}-value`}
        className="h-8 w-16 min-w-0 rounded-md border border-[var(--app-secondary-bg)] bg-transparent px-2 text-[length:var(--text-body)] text-[var(--app-fg)] disabled:opacity-50"
      />
      <select
        value={unit}
        onChange={e => handleUnitChange(e.target.value as IntervalUnit)}
        disabled={disabled}
        aria-label="Interval unit"
        data-testid={`${testIdPrefix}-unit`}
        className="h-8 min-w-0 flex-1 rounded-md border border-[var(--app-secondary-bg)] bg-transparent px-2 text-[length:var(--text-body)] text-[var(--app-fg)] disabled:opacity-50"
      >
        <option value="m">minutes</option>
        <option value="h">hours</option>
      </select>
    </div>
  );
}
