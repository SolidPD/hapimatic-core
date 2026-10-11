// SPDX-License-Identifier: AGPL-3.0-only
import { getSettingsFile, readSettings, writeSettings } from "./settings";

/**
 * Harness-poll config loader (issue #1770). Reads the `"harnessPoll"` key of
 * settings.json, falling back to defaults. Precedence is settings.json > default
 * ONLY — deliberately NO env-var tier (KD-9), so the settings surface #1775
 * builds is honest by construction: a value saved via its PUT always takes
 * effect on the next loop start. Loaded fresh on each call (mirrors
 * `heartbeatConfig.ts`) to support runtime updates.
 */
export interface HarnessPollConfig {
  /** When false, the SupervisedLoop registers a `"stopped"` job row and never
   *  ticks — but the service is still constructed and `detectNow()` still works
   *  (KD-9), so "check now" (R7) functions with the daily poll disabled. */
  enabled: boolean;
  /** Cadence between poll ticks, in ms. Default: 24h. */
  pollIntervalMs: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum poll cadence (#1775, R2/KD-7). A cadence below this is REJECTED by the
 * `PUT /api/harness/poll-config` route's Zod validation and CLAMPED on load/save
 * (defense-in-depth) so the poll can never run at an abusive rate that hammers
 * npm/GitHub. 1h is generous for a tool that releases ~daily; a 60s floor would
 * be too aggressive.
 */
export const MIN_HARNESS_POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Maximum poll cadence (#1775, R2/KD-7). Beyond a week is indistinguishable from
 * disabled — that is what `enabled: false` is for. Enforced by the PUT route's
 * Zod `.max()`; deliberately NOT clamped on load, so a hand-edited slower cadence
 * still loads verbatim (a very-slow read-only poll is harmless).
 */
export const MAX_HARNESS_POLL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getDefaults(): HarnessPollConfig {
  // enabled: true — the epic wants daily detection by default; it is read-only
  // and cheap (one npm-registry + one changelog fetch per harness per day).
  return { enabled: true, pollIntervalMs: DAY_MS };
}

/** Load harness-poll config from settings.json, merged with defaults. */
export async function loadHarnessPollConfig(
  dataDir: string
): Promise<HarnessPollConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const defaults = getDefaults();

  if (!settings) return defaults;

  const raw = (settings as Record<string, unknown>).harnessPoll;
  if (!raw || typeof raw !== "object") return defaults;

  const hp = raw as Record<string, unknown>;
  return {
    enabled: typeof hp.enabled === "boolean" ? hp.enabled : defaults.enabled,
    pollIntervalMs:
      typeof hp.pollIntervalMs === "number" && hp.pollIntervalMs > 0
        ? // R2/KD-7 defense-in-depth: clamp a sub-minimum positive value (e.g. a
          // hand edit) up to the floor on load. The PUT route's Zod is the
          // primary gate; this covers values reaching settings.json outside the
          // API. A 0/negative value falls through to the 24h default.
          Math.max(MIN_HARNESS_POLL_INTERVAL_MS, hp.pollIntervalMs)
        : defaults.pollIntervalMs,
  };
}

/**
 * Persist harness-poll config updates to settings.json (#1775). Mirrors
 * `saveHeartbeatConfig`: read → shallow-merge under the `harnessPoll` key →
 * clamp the interval to the minimum (R2/KD-7) → atomic write → return the
 * reloaded config (save-then-read-back, so the caller sees exactly what will
 * run). No env-var tier (KD-8) — settings.json is the single source of truth.
 */
export async function saveHarnessPollConfig(
  dataDir: string,
  updates: Partial<HarnessPollConfig>
): Promise<HarnessPollConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = (await readSettings(settingsFile)) ?? {};
  const raw = (settings as Record<string, unknown>).harnessPoll;
  const existing = raw && typeof raw === "object" ? raw : {};

  const merged: Record<string, unknown> = { ...existing, ...updates };
  // R2/KD-7: clamp the interval to the floor BEFORE persisting so a 0/negative/
  // sub-minimum value can never reach the poll loop. Defense-in-depth — the PUT
  // route's Zod is the primary type gate (a bare Math.max is NOT a type gate:
  // Math.max(MIN, NaN) is NaN, which would persist as null).
  if (typeof merged.pollIntervalMs === "number") {
    merged.pollIntervalMs = Math.max(
      MIN_HARNESS_POLL_INTERVAL_MS,
      merged.pollIntervalMs
    );
  }
  (settings as Record<string, unknown>).harnessPoll = merged;

  await writeSettings(settingsFile, settings);
  return loadHarnessPollConfig(dataDir);
}
