// SPDX-License-Identifier: AGPL-3.0-only
/**
 * US Federal Holidays — Pure computation, no dependencies.
 * Used by the frontend Create Session form (ExclusionListEditor)
 * and the scheduler engine for exclusion processing.
 */

export type HolidayEntry = {
  name: string;
  month: number; // 1-12
  day: number;
  year?: number; // undefined for fixed-date annual holidays
  annualRepeat: boolean;
};

/** Fixed-date US federal holidays (month is 1-indexed) */
export const US_FIXED_HOLIDAYS: readonly {
  name: string;
  month: number;
  day: number;
}[] = [
  { name: "New Year's Day", month: 1, day: 1 },
  { name: "Juneteenth", month: 6, day: 19 },
  { name: "Independence Day", month: 7, day: 4 },
  { name: "Veterans Day", month: 11, day: 11 },
  { name: "Christmas Day", month: 12, day: 25 },
];

type FloatingHolidayDef = {
  name: string;
  month: number; // 0-indexed (for Date constructor)
  weekday: number; // 0=Sun, 1=Mon, ...
  nth: number; // positive = nth occurrence, -1 = last
};

const FLOATING_HOLIDAY_DEFS: readonly FloatingHolidayDef[] = [
  { name: "Martin Luther King Jr. Day", month: 0, weekday: 1, nth: 3 },
  { name: "Presidents' Day", month: 1, weekday: 1, nth: 3 },
  { name: "Memorial Day", month: 4, weekday: 1, nth: -1 },
  { name: "Labor Day", month: 8, weekday: 1, nth: 1 },
  { name: "Columbus Day", month: 9, weekday: 1, nth: 2 },
  { name: "Thanksgiving", month: 10, weekday: 4, nth: 4 },
];

/** Find the Nth occurrence of a weekday in a month */
function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number
): Date {
  const first = new Date(year, month, 1);
  const firstDay = first.getDay();
  const day = 1 + ((weekday - firstDay + 7) % 7) + (n - 1) * 7;
  return new Date(year, month, day);
}

/** Find the last occurrence of a weekday in a month */
function lastWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number
): Date {
  const last = new Date(year, month + 1, 0); // last day of month
  const lastDay = last.getDay();
  const diff = (lastDay - weekday + 7) % 7;
  return new Date(year, month, last.getDate() - diff);
}

/** Compute floating US holidays for a given year */
export function computeFloatingHolidays(
  year: number
): { name: string; month: number; day: number; year: number }[] {
  return FLOATING_HOLIDAY_DEFS.map(def => {
    const date =
      def.nth === -1
        ? lastWeekdayOfMonth(year, def.month, def.weekday)
        : nthWeekdayOfMonth(year, def.month, def.weekday, def.nth);
    return {
      name: def.name,
      month: date.getMonth() + 1, // 1-indexed
      day: date.getDate(),
      year,
    };
  });
}

/** Generate exclusion entries for US holidays across multiple years */
export function generateUSHolidayExclusions(
  startYear: number,
  count: number = 3
): HolidayEntry[] {
  const entries: HolidayEntry[] = [];

  // Fixed-date holidays (annual repeat)
  for (const h of US_FIXED_HOLIDAYS) {
    entries.push({
      name: h.name,
      month: h.month,
      day: h.day,
      annualRepeat: true,
    });
  }

  // Floating holidays (year-specific, no annual repeat)
  for (let y = startYear; y < startYear + count; y++) {
    const floating = computeFloatingHolidays(y);
    for (const h of floating) {
      entries.push({
        name: h.name,
        month: h.month,
        day: h.day,
        year: h.year,
        annualRepeat: false,
      });
    }
  }

  return entries;
}
