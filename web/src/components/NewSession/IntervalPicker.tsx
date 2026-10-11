// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useRef, useMemo } from "react";

/**
 * DD HH:MM interval picker.
 * Converts to/from milliseconds for storage.
 */
export function IntervalPicker(props: {
  valueMs: number;
  onChange: (ms: number) => void;
  isDisabled?: boolean;
  minMs?: number;
}) {
  const { valueMs, onChange, isDisabled = false, minMs = 60_000 } = props;

  const { days, hours, minutes } = useMemo(() => {
    const totalMinutes = Math.round(valueMs / 60_000);
    return {
      days: Math.floor(totalMinutes / (24 * 60)),
      hours: Math.floor((totalMinutes % (24 * 60)) / 60),
      minutes: totalMinutes % 60,
    };
  }, [valueMs]);

  const updateFromParts = useCallback(
    (d: number, h: number, m: number) => {
      const totalMs = (d * 24 * 60 + h * 60 + m) * 60_000;
      onChange(Math.max(totalMs, minMs));
    },
    [onChange, minMs]
  );

  const containerRef = useRef<HTMLDivElement>(null);

  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // Select all text so typing replaces the existing value. Positioning on
    // focus is owned by useKeyboardAwareFieldFocus (container-level).
    e.target.select();
  }, []);

  const inputClass =
    "w-16 rounded-md border border-[var(--app-border)] h-9 bg-[var(--app-bg)] px-2.5 text-center text-sm text-[var(--app-fg)] focus:outline-none focus:ring-1 focus:ring-[var(--app-link)] disabled:opacity-50";

  return (
    <div
      ref={containerRef}
      className="flex items-center gap-1.5 text-sm text-[var(--app-fg)]"
    >
      <div className="flex items-center gap-1">
        <input
          autoCapitalize="none"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          min="0"
          max="365"
          value={days}
          onFocus={handleFocus}
          onChange={e => {
            const v = parseInt(e.target.value) || 0;
            updateFromParts(Math.max(0, v), hours, minutes);
          }}
          disabled={isDisabled}
          className={inputClass}
        />
        <span className="text-xs text-[var(--app-hint)]">d</span>
      </div>
      <div className="flex items-center gap-1">
        <input
          autoCapitalize="none"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          min="0"
          max="23"
          value={hours}
          onFocus={handleFocus}
          onChange={e => {
            const v = Math.min(23, Math.max(0, parseInt(e.target.value) || 0));
            updateFromParts(days, v, minutes);
          }}
          disabled={isDisabled}
          className={inputClass}
        />
        <span className="text-xs text-[var(--app-hint)]">h</span>
      </div>
      <div className="flex items-center gap-1">
        <input
          autoCapitalize="none"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          min="0"
          max="59"
          value={minutes}
          onFocus={handleFocus}
          onChange={e => {
            const v = Math.min(59, Math.max(0, parseInt(e.target.value) || 0));
            updateFromParts(days, hours, v);
          }}
          disabled={isDisabled}
          className={inputClass}
        />
        <span className="text-xs text-[var(--app-hint)]">m</span>
      </div>
    </div>
  );
}

/** Format milliseconds as human-readable interval string */
export function formatInterval(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}
