// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wall-clock math in one IANA time zone, for the Pins tab (#6451, #6452). The
 * timeline's helpers moved here unchanged; F adds what the deadline dialog
 * needs. None of these reads the device's zone except `resolvePinZone`'s last
 * resort, so a deadline means the same instant on every device.
 *
 * Every zone must pass through `resolvePinZone` first, because
 * `zoneFormatters` throws a RangeError on a name the runtime does not know.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type ZoneFormatters = {
  parts: Intl.DateTimeFormat;
  weekday: Intl.DateTimeFormat;
  short: Intl.DateTimeFormat;
};

// Built once per zone (#6208, `ledger.ts`): constructing an Intl.DateTimeFormat
// costs far more than formatting with one.
const formatters = new Map<string, ZoneFormatters>();

export function zoneFormatters(zone: string): ZoneFormatters {
  let cached = formatters.get(zone);
  if (!cached) {
    cached = {
      parts: new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      }),
      weekday: new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
      }),
      short: new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }),
    };
    formatters.set(zone, cached);
  }
  return cached;
}

export type Wall = {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
};

export function wallClock(ms: number, zone: string): Wall {
  const out: Record<string, number> = {};
  for (const part of zoneFormatters(zone).parts.formatToParts(ms)) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    y: out.year ?? 1970,
    m: out.month ?? 1,
    d: out.day ?? 1,
    h: out.hour ?? 0,
    min: out.minute ?? 0,
    s: out.second ?? 0,
  };
}

/** The zone's offset from UTC at an instant, in ms. */
export function offsetAt(ms: number, zone: string): number {
  const w = wallClock(ms, zone);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall time (as `Date.UTC` of its fields) happens in the zone. */
export function wallToInstant(wallMs: number, zone: string): number {
  const guess = wallMs - offsetAt(wallMs, zone);
  const offset = offsetAt(guess, zone);
  return wallMs - offset;
}

const validZones = new Map<string, boolean>();

/** True when the runtime knows the zone. Cached: an Intl constructor is costly. */
export function isValidZone(zone: string): boolean {
  let valid = validZones.get(zone);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      valid = true;
    } catch {
      valid = false;
    }
    validZones.set(zone, valid);
  }
  return valid;
}

/**
 * The zone Pins times render in: the operator's Time Log zone the server sent
 * when the runtime knows it, else the browser's, else UTC. The server decides
 * the preference (`loadTimeLogPreferenceTimezone`); the client adds only the
 * browser fallback the server's Submit uses (`browserOrHostTimeZone`).
 */
export function resolvePinZone(preferred?: string | null): string {
  if (preferred && isValidZone(preferred)) return preferred;
  try {
    const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (device && isValidZone(device)) return device;
  } catch {
    // Fall through to UTC.
  }
  return "UTC";
}

/**
 * The instant a wall time happens in the zone, with the two times a wall
 * clock cannot name exactly made definite: a time skipped by a spring-forward
 * gap resolves forward (02:30 on a 02:00-to-03:00 night is 03:30), and a time
 * repeated by a fall-back overlap resolves to the later of its two instants.
 * `wallToInstant` alone puts a gap time an hour early.
 *
 * Each candidate uses the zone's offset a day before or a day after, which
 * spans any one transition; a candidate is real when it reads back as the
 * same wall time.
 */
export function resolveWallTime(wallMs: number, zone: string): number {
  const candidates = [
    wallMs - offsetAt(wallMs - DAY_MS, zone),
    wallMs - offsetAt(wallMs + DAY_MS, zone),
  ];
  const real = candidates.filter(at => at + offsetAt(at, zone) === wallMs);
  return Math.max(...(real.length > 0 ? real : candidates));
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An instant as a `datetime-local` value (`YYYY-MM-DDTHH:mm`) in the zone. */
export function instantToZonedInput(ms: number, zone: string): string {
  const w = wallClock(ms, zone);
  return `${String(w.y).padStart(4, "0")}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.min)}`;
}

const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * A `datetime-local` value read as a wall time in the zone, as epoch ms; null
 * for a value that names no real date or time. See `resolveWallTime` for the
 * daylight-saving rules.
 */
export function zonedInputToInstant(
  value: string,
  zone: string
): number | null {
  const match = INPUT.exec(value);
  if (!match) return null;
  const [y, m, d, h, min, s] = match.slice(1).map(part => Number(part ?? 0));
  const wall = Date.UTC(y!, m! - 1, d!, h!, min!, s!);
  const check = new Date(wall);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== m! - 1 ||
    check.getUTCDate() !== d ||
    check.getUTCHours() !== h ||
    check.getUTCMinutes() !== min
  ) {
    return null;
  }
  return resolveWallTime(wall, zone);
}

/** A wall time on a day relative to `now`'s date in the zone ("Tomorrow 9 AM"). */
export function wallTimeOn(
  now: number,
  zone: string,
  at: { addDays: number; hour: number; minute?: number }
): number {
  const today = wallClock(now, zone);
  return resolveWallTime(
    Date.UTC(
      today.y,
      today.m - 1,
      today.d + at.addDays,
      at.hour,
      at.minute ?? 0
    ),
    zone
  );
}

/**
 * The next given weekday (0 Sunday, 1 Monday, ...) strictly after today in the
 * zone, at the hour: "Next Monday 9 AM" on a Monday is a week away.
 */
export function nextWeekdayAt(
  now: number,
  zone: string,
  weekday = 1,
  hour = 9
): number {
  const today = wallClock(now, zone);
  const day = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
  const ahead = (weekday - day + 7) % 7 || 7;
  return wallTimeOn(now, zone, { addDays: ahead, hour });
}

const whenFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * An instant with its weekday and the zone's short name, "Sun Nov 8, 9:00 AM
 * EST" (mockup v6 `when`): the automatic pick's time in the deadline dialog.
 * The zone must come from `resolvePinZone`.
 */
export function formatZonedWhen(ms: number, zone: string): string {
  let format = whenFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    whenFormats.set(zone, format);
  }
  return format.format(ms).replace(/^(\w+),/, "$1");
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();

function cachedFormat(
  cache: Map<string, Intl.DateTimeFormat>,
  zone: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  let format = cache.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options });
    cache.set(zone, format);
  }
  return format;
}

/**
 * A pick's time as short as it can be and still name one moment, for the
 * one-line automatic-pick row (#6452, 393 px wide): "3:24 PM" today, "Mon 3:24
 * PM" within the next six days, else "Nov 18, 3:24 PM". Days are the zone's.
 */
export function formatPickTime(at: number, now: number, zone: string): string {
  const a = wallClock(at, zone);
  const n = wallClock(now, zone);
  const days = Math.round(
    (Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(n.y, n.m - 1, n.d)) / DAY_MS
  );
  if (days === 0) {
    return cachedFormat(clockFormats, zone, {
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
  }
  if (days > 0 && days < 7) return zoneFormatters(zone).short.format(at);
  return cachedFormat(dateTimeFormats, zone, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}
