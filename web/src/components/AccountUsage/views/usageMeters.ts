// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The pure meter model behind the Arcs and Chips usage views (#4467, epic #4460
 * G). One ordered column list per account, shared by both views so their cells
 * line up on the same grid, plus the small formatters they render with.
 *
 * Column order (R2): 5-hour, Weekly, the first `weekly_scoped` window (titled
 * by its `scope.model.display_name`), any further populated meters (the
 * per-model weekly windows and extra scoped windows, the same inclusion rule as
 * Bars), then Credits. A canonical meter the account lacks keeps a placeholder
 * column so the columns align across accounts. OpenAI shows its two codex
 * windows only.
 */
import type { CSSProperties } from "react";
import type { AccountUsage, ProviderId } from "@hapi/protocol";
import { centsToUsd, moneyToUsd, overagePercent } from "../AccountUsageCard";

export type UsageColumn = {
  /** Stable key: "five_hour", "seven_day", "scoped:<name>:<index>" (or
   *  "scoped" for the placeholder), the per-model window keys, "credits". */
  id: string;
  /** Full title ("5-hour", "Weekly", "Fable", "Credits"). */
  title: string;
  /** Compact title for narrow chips ("5h", "Wk", "Fbl", "Cr"). */
  shortTitle: string;
  /** 0–100+ (credits are uncapped); null for a placeholder. */
  pct: number | null;
  /** ISO reset time; null when the window carries none. */
  resetsAt: string | null;
  /** Text shown where the reset would be (credits: "monthly", G-1 A). */
  resetLabel?: string;
  /** A canonical meter this account does not report (an empty column). */
  placeholder?: boolean;
  /** Dollar amounts for the credits column. */
  credits?: { usedUsd: number | null; limitUsd: number | null };
};

type Utilization = AccountUsage["utilization"];

/** Credits reset text (ruling G-1 A): the envelope carries no reset or period
 *  field, so the column says how often it resets instead of a date. */
export const CREDITS_RESET_LABEL = "monthly";
/** A credits placeholder (no spend limit and no legacy pool). */
export const CREDITS_PLACEHOLDER_LABEL = "not enabled";

const SHORT_TITLES: Record<string, string> = {
  "5-hour": "5h",
  Weekly: "Wk",
  Credits: "Cr",
};

/**
 * The compact chip name (R4): a known title maps to its fixed short form ("5h",
 * "Wk", "Cr"); a model name keeps its first letter plus the following
 * consonants, at most three letters ("Fable" → "Fbl", "Opus" → "Ops"). A
 * "Weekly <Model>" title abbreviates the model part.
 */
export function abbreviate(title: string): string {
  const known = SHORT_TITLES[title];
  if (known) return known;
  const name = title.replace(/^Weekly\s+/i, "").trim();
  if (name === "") return title;
  const [first, ...rest] = Array.from(name);
  const consonants = rest.filter(
    ch => /[a-z]/i.test(ch) && !/[aeiou]/i.test(ch)
  );
  return [first, ...consonants].slice(0, 3).join("");
}

function windowColumn(
  id: string,
  title: string,
  win:
    | { utilization?: number | null; resets_at?: string | null }
    | null
    | undefined
): UsageColumn {
  const pct = win?.utilization ?? null;
  if (pct == null) {
    return {
      id,
      title,
      shortTitle: abbreviate(title),
      pct: null,
      resetsAt: null,
      placeholder: true,
    };
  }
  return {
    id,
    title,
    shortTitle: abbreviate(title),
    pct,
    resetsAt: win?.resets_at ?? null,
  };
}

/** The credits column: `spend` first (the source Bars uses), then the legacy
 *  `extra_usage` pool in cents, else a placeholder. */
function creditsColumn(u: Utilization): UsageColumn {
  const base = { id: "credits", title: "Credits", shortTitle: "Cr" };
  const overPct = overagePercent(u.spend);
  if (overPct != null && u.spend?.limit != null) {
    return {
      ...base,
      pct: overPct,
      resetsAt: null,
      resetLabel: CREDITS_RESET_LABEL,
      credits: {
        usedUsd: moneyToUsd(u.spend?.used),
        limitUsd: moneyToUsd(u.spend?.limit),
      },
    };
  }
  const extra = u.extra_usage;
  const limitUsd = centsToUsd(extra?.monthly_limit);
  if (extra?.is_enabled && limitUsd != null && limitUsd > 0) {
    const usedUsd = centsToUsd(extra.used_credits);
    return {
      ...base,
      pct: ((usedUsd ?? 0) / limitUsd) * 100,
      resetsAt: null,
      resetLabel: CREDITS_RESET_LABEL,
      credits: { usedUsd, limitUsd },
    };
  }
  return {
    ...base,
    pct: null,
    resetsAt: null,
    resetLabel: CREDITS_PLACEHOLDER_LABEL,
    placeholder: true,
  };
}

/**
 * The ordered columns for one account (R2). Pure; both views build from it,
 * and the Session Configuration modal (#4600) is to reuse it.
 */
export function buildUsageColumns(
  u: Utilization,
  provider: ProviderId = "anthropic"
): UsageColumn[] {
  if (provider === "openai") {
    return [
      windowColumn("five_hour", "5-hour", u.five_hour),
      windowColumn("seven_day", "Weekly", u.seven_day),
    ];
  }
  const scoped = (u.limits ?? []).filter(
    l =>
      l != null &&
      l.kind === "weekly_scoped" &&
      l.percent != null &&
      l.scope?.model?.display_name != null &&
      l.scope.model.display_name !== ""
  );
  const scopedColumn = (
    l: (typeof scoped)[number],
    idx: number
  ): UsageColumn => {
    const name = l.scope?.model?.display_name as string;
    return {
      id: `scoped:${name}:${idx}`,
      title: name,
      shortTitle: abbreviate(name),
      pct: l.percent ?? null,
      resetsAt: l.resets_at ?? null,
    };
  };
  const first = scoped[0];
  const columns: UsageColumn[] = [
    windowColumn("five_hour", "5-hour", u.five_hour),
    windowColumn("seven_day", "Weekly", u.seven_day),
    first
      ? scopedColumn(first, 0)
      : {
          id: "scoped",
          title: "Model",
          shortTitle: "Mdl",
          pct: null,
          resetsAt: null,
          placeholder: true,
        },
  ];
  // Further populated meters sit before Credits (Bars' inclusion rule: the
  // per-model weekly windows when populated, never `seven_day_oauth_apps`).
  // They are titled by model, like the scoped "Fable" column, so a narrow
  // column never truncates a shared "Weekly" prefix.
  for (const [id, title, win] of [
    ["seven_day_sonnet", "Sonnet", u.seven_day_sonnet],
    ["seven_day_opus", "Opus", u.seven_day_opus],
  ] as const) {
    if (win != null && win.utilization != null) {
      columns.push(windowColumn(id, title, win));
    }
  }
  scoped.slice(1).forEach((l, i) => columns.push(scopedColumn(l, i + 1)));
  columns.push(creditsColumn(u));
  return columns;
}

/**
 * The relative time to a reset, compact: "41m", "2h 14m", "3d 4h", "now" for a
 * past reset, "" when missing or unparseable. `now` is injectable for tests.
 */
export function formatResetShort(
  resetsAt: string | null | undefined,
  now: number = Date.now()
): string {
  if (!resetsAt) return "";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "";
  const deltaMs = target - now;
  if (deltaMs <= 0) return "now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(minutes / (24 * 60));
  const h = Math.floor((minutes % (24 * 60)) / 60);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * The absolute reset as two parts, America/New_York like Bars:
 * `{ day: "Thu Oct 2", time: "3:40 PM" }`. Null when missing or unparseable.
 */
export function formatResetParts(
  resetsAt: string | null | undefined
): { day: string; time: string } | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return null;
  const date = new Date(t);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).formatToParts(date);
  const pick = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return { day: `${pick("weekday")} ${pick("month")} ${pick("day")}`, time };
}

/** The arc's sweep in degrees: 0% → 0°, 100% → 180°, clamped (credits can
 *  exceed 100%), NaN → 0°. */
export function arcSweepDeg(pct: number | null | undefined): number {
  if (pct == null || !Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct)) * 1.8;
}

/**
 * The half-ring fill: a conic gradient anchored at the box's bottom centre,
 * starting at 9 o'clock and sweeping clockwise through 12 to 3 o'clock. The
 * filled part takes the band colour, the rest of the half the track colour,
 * and the lower half is transparent. The ring's hole is a mask on the element.
 */
export function arcBackground(sweep: number, color: string): string {
  const s = Math.min(180, Math.max(0, sweep));
  return `conic-gradient(from 270deg at 50% 100%, ${color} 0deg ${s}deg, var(--app-subtle-bg) ${s}deg 180deg, transparent 180deg)`;
}

/**
 * A column's reset text, shared by the arc's line and the chip's third part:
 * the column's own label (credits: "monthly"), "" for a placeholder, "not
 * started" for a window with no reset yet, else the compact relative time
 * ("2h 14m", "now").
 */
export function columnResetText(col: UsageColumn, now?: number): string {
  if (col.resetLabel) return col.resetLabel;
  if (col.placeholder) return "";
  if (!col.resetsAt) return "not started";
  return formatResetShort(col.resetsAt, now);
}

/** The grid both compact views share: one equal column per meter, with the
 *  arc width capped at 56px and shrinking with the column. */
export function usageGridStyle(n: number): CSSProperties {
  return {
    gridTemplateColumns: `repeat(${Math.max(1, n)}, minmax(0, 1fr))`,
    ["--arc-size" as string]: "min(56px, 100%)",
  };
}

/** Below this column width a chip shows its compact two-row form (R4). */
export const CHIP_COMPACT_BELOW_PX = 120;

export function chipCompact(columnPx: number): boolean {
  return columnPx > 0 && columnPx < CHIP_COMPACT_BELOW_PX;
}
