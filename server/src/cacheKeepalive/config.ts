// SPDX-License-Identifier: AGPL-3.0-only
import {
  CACHE_KEEPALIVE_DEFAULTS,
  CACHE_KEEPALIVE_RANGES,
} from "@hapi/protocol";
import type { Settings } from "../config/settings";

/**
 * Prompt-cache keep-alive configuration (issue #6169, epic #6163 Sub C2 — R5).
 *
 * Precedence: env `HAPI_CACHE_KEEPALIVE` (`0`/`1`, the on/off switch only) >
 * `settings.cacheKeepalive` > `CACHE_KEEPALIVE_DEFAULTS`. An invalid value falls
 * through to the next layer and is listed in `rejected`, which the service logs
 * once per distinct value. A `cacheKeepalive` that is not an object, or an
 * `enabled` that is not a boolean, is rejected and turns the feature off. The
 * service re-reads settings.json on every tick, so `"enabled": false` there
 * needs no restart; the env var is read from the server's own environment,
 * which changes only at a restart.
 */

export type CacheKeepaliveSettings = NonNullable<Settings["cacheKeepalive"]>;

export interface CacheKeepaliveConfig {
  enabled: boolean;
  source: "env" | "settings" | "default";
  contextThresholdTokens: number;
  intervalMs: number;
  deadlineMs: number;
  capMs: number;
  typingQuietMs: number;
  /** Ignored invalid values, e.g. `HAPI_CACHE_KEEPALIVE=maybe`. */
  rejected: string[];
}

/**
 * The warm window (interval → deadline) must span at least two 60 s ticks, or a
 * session can fall between them and miss it.
 */
const MIN_WINDOW_MINUTES = 2;
const OFF = new Set(["0", "false", "no", "off"]);
const ON = new Set(["1", "true", "yes", "on"]);
const MIN = 60_000;

type RangedKey = keyof typeof CACHE_KEEPALIVE_RANGES;

/** A settings number inside its range, else the default (listed in `rejected`). */
function ranged(
  s: CacheKeepaliveSettings,
  key: RangedKey,
  rejected: string[]
): number {
  const raw = (s as Record<string, unknown>)[key];
  const fallback = CACHE_KEEPALIVE_DEFAULTS[key];
  if (raw === undefined) return fallback;
  const { min, max } = CACHE_KEEPALIVE_RANGES[key];
  if (
    typeof raw === "number" &&
    Number.isFinite(raw) &&
    raw >= min &&
    raw <= max
  ) {
    return raw;
  }
  rejected.push(`cacheKeepalive.${key}=${JSON.stringify(raw)}`);
  return fallback;
}

export function loadCacheKeepaliveConfig(input: {
  settings: Settings | null;
  env?: Record<string, string | undefined>;
}): CacheKeepaliveConfig {
  const env = input.env ?? process.env;
  const rejected: string[] = [];
  // settings.json is hand-edited, so the section can be any JSON value. One
  // that is not an object (`"cacheKeepalive": false` meant as "off") is
  // rejected and turns keep-alives off: every guard errs toward not sending.
  const raw: unknown = input.settings?.cacheKeepalive;
  const malformed =
    raw !== undefined &&
    raw !== null &&
    (typeof raw !== "object" || Array.isArray(raw));
  if (malformed) {
    rejected.push(
      `cacheKeepalive=${JSON.stringify(raw)} (not an object: keep-alives off)`
    );
  }
  const s: CacheKeepaliveSettings = malformed
    ? {}
    : ((raw as CacheKeepaliveSettings | null | undefined) ?? {});

  let enabled: boolean = CACHE_KEEPALIVE_DEFAULTS.enabled;
  let source: CacheKeepaliveConfig["source"] = "default";
  const rawEnv = env.HAPI_CACHE_KEEPALIVE?.trim().toLowerCase() ?? "";
  if (ON.has(rawEnv) || OFF.has(rawEnv)) {
    enabled = ON.has(rawEnv);
    source = "env";
  } else {
    if (rawEnv !== "") {
      rejected.push(`HAPI_CACHE_KEEPALIVE=${env.HAPI_CACHE_KEEPALIVE}`);
    }
    if (malformed) {
      enabled = false;
      source = "settings";
    } else if (typeof s.enabled === "boolean") {
      enabled = s.enabled;
      source = "settings";
    } else if (s.enabled !== undefined) {
      // A switch that is set but unreadable ("false", 0) turns it off too.
      rejected.push(
        `cacheKeepalive.enabled=${JSON.stringify(s.enabled)} (not a boolean: keep-alives off)`
      );
      enabled = false;
      source = "settings";
    }
  }

  const contextThresholdTokens = ranged(s, "contextThresholdTokens", rejected);
  let intervalMinutes = ranged(s, "intervalMinutes", rejected);
  let deadlineMinutes = ranged(s, "deadlineMinutes", rejected);
  // The deadline closes the warm window, so it must come after the interval,
  // by at least two ticks.
  if (deadlineMinutes - intervalMinutes < MIN_WINDOW_MINUTES) {
    rejected.push(
      `cacheKeepalive.deadlineMinutes=${deadlineMinutes} (not ${MIN_WINDOW_MINUTES}+ minutes after intervalMinutes=${intervalMinutes})`
    );
    deadlineMinutes = CACHE_KEEPALIVE_DEFAULTS.deadlineMinutes;
    if (deadlineMinutes - intervalMinutes < MIN_WINDOW_MINUTES) {
      intervalMinutes = CACHE_KEEPALIVE_DEFAULTS.intervalMinutes;
    }
  }
  const capHours = ranged(s, "capHours", rejected);
  const typingQuietMinutes = ranged(s, "typingQuietMinutes", rejected);

  return {
    enabled,
    source,
    contextThresholdTokens,
    intervalMs: intervalMinutes * MIN,
    deadlineMs: deadlineMinutes * MIN,
    capMs: capHours * 60 * MIN,
    typingQuietMs: typingQuietMinutes * MIN,
    rejected,
  };
}
