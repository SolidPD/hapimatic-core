// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from "react";
import { UiSelect } from "./controls";

/** Common timezones shown at top of the list for quick access */
const PINNED_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
] as const;

export function TimezoneSelect(props: {
  value: string;
  onChange: (tz: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const { value, onChange, disabled, className } = props;

  const allTimezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      // Fallback for older browsers
      return [...PINNED_TIMEZONES];
    }
  }, []);

  const remaining = useMemo(
    () => allTimezones.filter(tz => !PINNED_TIMEZONES.includes(tz as never)),
    [allTimezones]
  );

  return (
    <UiSelect
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className={className}
    >
      <optgroup label="Common">
        {PINNED_TIMEZONES.map(tz => (
          <option key={tz} value={tz}>
            {tz.replace(/_/g, " ")}
          </option>
        ))}
      </optgroup>
      <optgroup label="All Timezones">
        {remaining.map(tz => (
          <option key={tz} value={tz}>
            {tz.replace(/_/g, " ")}
          </option>
        ))}
      </optgroup>
    </UiSelect>
  );
}
