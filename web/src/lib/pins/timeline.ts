// SPDX-License-Identifier: AGPL-3.0-only

/**
 * #6451 (R8): the timeline of upcoming automatic picks — its span, ticks,
 * weekday labels and points, as pure math over epoch ms in one time zone.
 * Behaviour of record: mockup v6 `timeline` (:821-845), with three changes:
 * midnights come from the zone's wall clock instead of adding 24 h, which
 * drifts an hour across a daylight-saving change; the 6-hour ticks of a short
 * strip sit at 06:00, 12:00 and 18:00 wall time, not at +6 h steps from now;
 * and picks past the strip's end are counted (`later`).
 */

import { wallClock, wallToInstant, zoneFormatters } from "./zoneTime";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** The spans a strip can have, in days. */
export const TIMELINE_SPANS = [1, 2, 3, 5, 7, 10, 14, 21, 30, 60] as const;

/**
 * The first span at least 1.4× the last pick's distance from now, so the strip
 * ends with an empty stretch. With no picks the distance counts as one day (a
 * two-day strip). The span stops at 60 days: from a last pick about 43 days
 * out the stretch after it is shorter than 1.4×, and a pick past 60 days falls
 * off the strip into `later`.
 */
export function timelineSpanDays(latestMs?: number): number {
  const latest = latestMs ?? DAY_MS;
  return (
    TIMELINE_SPANS.find(days => days * DAY_MS >= latest * 1.4) ??
    TIMELINE_SPANS[TIMELINE_SPANS.length - 1]
  );
}

export type TimelinePick = {
  key: string;
  title: string;
  /** The option the pick will choose. */
  option: string;
  /** The pick's instant, epoch ms. */
  at: number;
};

export type TimelinePoint = TimelinePick & {
  /** Percent across the strip, 2-98. */
  x: number;
  /** The dot's short time ("Sun 3:00 PM"), or only the dot when it would collide. */
  showLabel: boolean;
  label: string;
  anchor: "start" | "center" | "end";
};

export type Timeline = {
  days: number;
  /** Every upcoming pick, inside the strip or not. */
  total: number;
  ticks: Array<{ x: number; at: number; day: boolean }>;
  dayLabels: Array<{ x: number; text: string }>;
  points: TimelinePoint[];
  /** Picks beyond the strip (only past 60 days). */
  later: number;
};

/** The zone's wall times on the days from `now`'s date on, at the given hours. */
function wallInstants(
  now: number,
  end: number,
  zone: string,
  hours: readonly number[]
): number[] {
  const today = wallClock(now, zone);
  const out: number[] = [];
  for (let day = 0; ; day++) {
    const dayStart = wallToInstant(
      Date.UTC(today.y, today.m - 1, today.d + day),
      zone
    );
    if (dayStart >= end) break;
    for (const hour of hours) {
      const at = wallToInstant(
        Date.UTC(today.y, today.m - 1, today.d + day, hour),
        zone
      );
      if (at > now && at < end) out.push(at);
    }
  }
  return out;
}

const clamp = (low: number, high: number, value: number) =>
  Math.max(low, Math.min(high, value));

/**
 * The strip for the given picks (R8). `picks` may be in any order and may
 * include past picks; only those later than `now` count.
 */
export function buildTimeline(input: {
  picks: readonly TimelinePick[];
  now: number;
  zone: string;
}): Timeline {
  const { now, zone } = input;
  const picks = input.picks
    .filter(pick => pick.at > now)
    .sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : 1));
  const last = picks[picks.length - 1];
  const days = timelineSpanDays(last ? last.at - now : undefined);
  const span = days * DAY_MS;
  const end = now + span;
  const xOf = (at: number) => ((at - now) / span) * 100;

  const midnights = wallInstants(now, end, zone, [0]);
  const ticks: Timeline["ticks"] = midnights.map(at => ({
    x: xOf(at),
    at,
    day: true,
  }));
  if (days <= 2) {
    for (const at of wallInstants(now, end, zone, [6, 12, 18])) {
      ticks.push({ x: xOf(at), at, day: false });
    }
    ticks.sort((a, b) => a.x - b.x);
  }

  const every = days <= 7 ? 1 : days <= 14 ? 2 : 7;
  const { weekday, short } = zoneFormatters(zone);
  const dayLabels: Timeline["dayLabels"] = [];
  midnights.forEach((at, index) => {
    const x = xOf(at);
    if (index % every !== 0 || x <= 4 || x >= 96) return;
    // An hour in, so the label names the day the midnight starts.
    dayLabels.push({ x, text: weekday.format(at + HOUR_MS) });
  });

  let lastLabelled = -100;
  const points: TimelinePoint[] = [];
  for (const pick of picks) {
    if (pick.at - now > span) continue;
    const x = clamp(2, 98, xOf(pick.at));
    const showLabel = x - lastLabelled >= 16;
    if (showLabel) lastLabelled = x;
    points.push({
      ...pick,
      x,
      showLabel,
      label: short.format(pick.at),
      anchor: x < 14 ? "start" : x > 86 ? "end" : "center",
    });
  }

  return {
    days,
    total: picks.length,
    ticks,
    dayLabels,
    points,
    later: picks.length - points.length,
  };
}
