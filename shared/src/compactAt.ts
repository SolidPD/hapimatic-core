// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Issue #6570 — one "compact at" percentage for every Claude session a node starts.
//
// This module is the SHARED contract: the stored preference, the one accessor that
// decides the effective value (`resolveCompactAt`, used by the server's GET, the boot
// seed and the session wrapper, so Settings and a session cannot disagree), and the
// arithmetic Claude Code uses to turn `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` into a token
// firing point. The arithmetic mirrors the Claude Code bundle exactly; see
// CLAUDE_COMPACT_FORMULA_VERIFIED_VERSION for what a re-read must check.
//
// The session reads its number from the `env` block of the per-session `--settings`
// file (cli generateHookSettings): HAPI_COMPACT_AT_PCT, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
// and HAPI_COMPACT_AT_CLAUDE_VALUE. rp1-home#3126's checkpoint hook reads those names,
// so a rename is a silent fallback there: change them only with that lane.

/** The default where a node stores nothing: 90, on (Matt's ruling "CD1", 2026-11-11). */
export const COMPACT_AT_DEFAULT_PERCENT = 90;
/** Lowest accepted percent: below 50 a summary and a few turns could compact again soon. */
export const COMPACT_AT_MIN_PERCENT = 50;
/** Highest accepted percent: 95 fires at 950,011 on 1M, below the 967,000 default point. */
export const COMPACT_AT_MAX_PERCENT = 95;
/** Every session is sized to this window (ruling D3): exact on 1M, safe on 200K. */
export const COMPACT_AT_SIZING_WINDOW_TOKENS = 1_000_000;
/**
 * R in the bundle: min(maxOutputTokens, 20,000), the summary reserve (2.1.321 `voo`).
 * A `CLAUDE_CODE_MAX_OUTPUT_TOKENS` below 20,000 lowers R and moves the point later
 * (at most about 18,400 tokens on 1M); not set on the fleet.
 */
export const CLAUDE_COMPACT_SUMMARY_RESERVE_TOKENS = 20_000;
/** The headroom the bundle keeps below the effective window (2.1.321 `z4`). */
export const CLAUDE_COMPACT_HEADROOM_TOKENS = 13_000;
/** Decimals in the value Hapimatic writes (ruling D1: two; 0 gives a whole number). */
export const CLAUDE_OVERRIDE_DECIMALS = 2;
/** The windows Settings shows a firing point for. */
export const COMPACT_AT_DISPLAY_WINDOWS = [1_000_000, 200_000] as const;
/** The user's percent of a 1,000,000 window, as a whole-number string. */
export const HAPI_COMPACT_AT_PCT_ENV = "HAPI_COMPACT_AT_PCT";
/** The same string Hapimatic wrote into CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (nested-claude check). */
export const HAPI_COMPACT_AT_CLAUDE_VALUE_ENV = "HAPI_COMPACT_AT_CLAUDE_VALUE";
/** Claude Code's own override variable (parsed with parseFloat, accepted in (0, 100]). */
export const CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV =
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
/**
 * The Claude Code version whose bundle the arithmetic was read from. Re-read it when
 * the fleet moves to a new Claude Code, checking: `z4` (the min/floor expression and
 * its 13,000 headroom), `Moe` and `voo` (window minus min(maxOutputTokens, 20,000)),
 * `Ire`'s `parseFloat` of CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, and `dS`'s window sources.
 */
export const CLAUDE_COMPACT_FORMULA_VERIFIED_VERSION = "2.1.321";

/** The editable preference: a switch and a whole-number percent from 50 to 95. */
export const CompactAtPreferenceSchema = z.object({
  enabled: z.boolean(),
  percent: z
    .number()
    .int()
    .min(COMPACT_AT_MIN_PERCENT)
    .max(COMPACT_AT_MAX_PERCENT),
});
export type CompactAtPreference = z.infer<typeof CompactAtPreferenceSchema>;

/** A PUT body: either field, at least one. Unknown keys are dropped. */
export const CompactAtPreferencePatchSchema =
  CompactAtPreferenceSchema.partial().refine(
    patch => patch.enabled !== undefined || patch.percent !== undefined,
    { message: "Send enabled, percent, or both" }
  );
export type CompactAtPreferencePatch = z.infer<
  typeof CompactAtPreferencePatchSchema
>;

/**
 * The stored object, `settings.json` → `compactAt`. The one schema that names every
 * stored field; `.passthrough()` keeps a field a newer binary added.
 */
export const CompactAtStoredSchema = z
  .object({
    enabled: z.boolean(),
    percent: z
      .number()
      .int()
      .min(COMPACT_AT_MIN_PERCENT)
      .max(COMPACT_AT_MAX_PERCENT),
    seededFrom: z.enum(["contextWatermark", "default"]).optional(),
    seededAt: z.string().optional(),
  })
  .passthrough();
export type CompactAtStored = z.infer<typeof CompactAtStoredSchema>;

/**
 * Where the effective value came from. `invalid` (a stored `compactAt` that fails the
 * schema) and `unreadable` (a settings file that cannot be read or parsed) are both off.
 */
export type CompactAtSource =
  | "stored"
  | "legacy-watermark"
  | "default"
  | "invalid"
  | "unreadable";

export interface ResolvedCompactAt {
  enabled: boolean;
  /** For `invalid` and `unreadable` this is the default, for display only. */
  percent: number;
  source: CompactAtSource;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampPercent(percent: number): number {
  return Math.min(
    COMPACT_AT_MAX_PERCENT,
    Math.max(COMPACT_AT_MIN_PERCENT, percent)
  );
}

/**
 * The one accessor (R2). Pass the parsed `settings.json`, `{}` for a missing file and
 * `null` for one that cannot be read or parsed. Precedence:
 * 1. a stored `compactAt`: valid → its value (`enabled: false` is off); invalid → off;
 * 2. no `compactAt`: a stored `contextWatermark.watermarkPercent` that is a finite
 *    number above 0 (the handoff loader's own rule), rounded with Math.round and
 *    clamped to 50–95;
 * 3. otherwise the default, 90, on.
 * Anything that is not an object (null, an array, a string) is `unreadable`: off,
 * which is today's behavior.
 */
export function resolveCompactAt(settings: unknown): ResolvedCompactAt {
  if (!isPlainObject(settings)) {
    return {
      enabled: false,
      percent: COMPACT_AT_DEFAULT_PERCENT,
      source: "unreadable",
    };
  }
  if (settings.compactAt !== undefined) {
    const parsed = CompactAtStoredSchema.safeParse(settings.compactAt);
    if (!parsed.success) {
      return {
        enabled: false,
        percent: COMPACT_AT_DEFAULT_PERCENT,
        source: "invalid",
      };
    }
    return {
      enabled: parsed.data.enabled,
      percent: parsed.data.percent,
      source: "stored",
    };
  }
  const watermark = settings.contextWatermark;
  if (isPlainObject(watermark)) {
    const legacy = watermark.watermarkPercent;
    if (typeof legacy === "number" && Number.isFinite(legacy) && legacy > 0) {
      return {
        enabled: true,
        percent: clampPercent(Math.round(legacy)),
        source: "legacy-watermark",
      };
    }
  }
  return {
    enabled: true,
    percent: COMPACT_AT_DEFAULT_PERCENT,
    source: "default",
  };
}

function roundTo(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}

/**
 * The CLAUDE_AUTOCOMPACT_PCT_OVERRIDE value that makes a 1,000,000 window fire at
 * `percent`% of the window (R5): percent × W / (W − R), to CLAUDE_OVERRIDE_DECIMALS,
 * never above 100 (Claude Code ignores a value above 100). 90 → 91.84.
 */
export function claudeOverrideForPercent(percent: number): number {
  const effectiveWindow =
    COMPACT_AT_SIZING_WINDOW_TOKENS - CLAUDE_COMPACT_SUMMARY_RESERVE_TOKENS;
  const value = roundTo(
    (percent * COMPACT_AT_SIZING_WINDOW_TOKENS) / effectiveWindow,
    CLAUDE_OVERRIDE_DECIMALS
  );
  return Math.min(100, value);
}

/**
 * The token count at which Claude Code compacts a window of `windowTokens`, for an
 * override value `override` (undefined = no override). Mirrors 2.1.321 `z4` in the
 * bundle's own float order — division first — because `floor(e * v / 100)` lands one
 * token off at 95 (950,012 against 950,011):
 *   e = window − 20,000; r = e − 13,000;
 *   v in (0, 100] ? min(floor(e * (v / 100)), r) : r
 */
export function claudeCompactFiringPoint(
  override: number | undefined,
  windowTokens: number
): number {
  const e = windowTokens - CLAUDE_COMPACT_SUMMARY_RESERVE_TOKENS;
  const r = e - CLAUDE_COMPACT_HEADROOM_TOKENS;
  if (
    override !== undefined &&
    !Number.isNaN(override) &&
    override > 0 &&
    override <= 100
  ) {
    return Math.min(Math.floor(e * (override / 100)), r);
  }
  return r;
}

export type CompactAtSessionEnv = {
  CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: string;
  HAPI_COMPACT_AT_PCT: string;
  HAPI_COMPACT_AT_CLAUDE_VALUE: string;
};

/**
 * The per-session `env` block (R6): `null` when the resolved value is off, else three
 * strings. The value is written as JavaScript String(v), so 88 gives "89.8", not
 * "89.80"; HAPI_COMPACT_AT_CLAUDE_VALUE carries the same string so a reader can tell
 * a value Hapimatic set from one a nested claude's own user file supplied.
 */
export function compactAtSessionEnv(
  resolved: ResolvedCompactAt
): CompactAtSessionEnv | null {
  if (!resolved.enabled) return null;
  const value = String(claudeOverrideForPercent(resolved.percent));
  return {
    [CLAUDE_AUTOCOMPACT_PCT_OVERRIDE_ENV]: value,
    [HAPI_COMPACT_AT_PCT_ENV]: String(resolved.percent),
    [HAPI_COMPACT_AT_CLAUDE_VALUE_ENV]: value,
  } as CompactAtSessionEnv;
}

export interface CompactAtEffectivePoint {
  windowTokens: number;
  firingTokens: number;
  /** firingTokens as a percent of windowTokens, one decimal. */
  percentOfWindow: number;
}

/** One firing point per display window for `percent` (the Settings rows and the GET). */
export function compactAtEffectivePoints(
  percent: number
): CompactAtEffectivePoint[] {
  const override = claudeOverrideForPercent(percent);
  return COMPACT_AT_DISPLAY_WINDOWS.map(windowTokens => {
    const firingTokens = claudeCompactFiringPoint(override, windowTokens);
    return {
      windowTokens,
      firingTokens,
      percentOfWindow: roundTo((firingTokens / windowTokens) * 100, 1),
    };
  });
}

/** The latest point a window can compact at, whatever the value (W − R − 13,000). */
export function claudeCompactMaxPoint(windowTokens: number): number {
  return claudeCompactFiringPoint(undefined, windowTokens);
}

/** GET / PUT /api/preferences/compact-at response (R9). */
export interface CompactAtPreferenceResponse {
  enabled: boolean;
  percent: number;
  source: CompactAtSource;
  claudeOverride: number;
  effective: CompactAtEffectivePoint[];
  seededFrom?: "contextWatermark" | "default";
  seededAt?: string;
}
