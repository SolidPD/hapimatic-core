// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Auto-Switch-On-Rate-Limit Configuration Loader (#3618)
 *
 * Loads the auto-switch STORM-GUARD tunables from the "autoSwitch" key in
 * settings.json. Falls back to sensible defaults when not configured. Config is
 * loaded fresh on each call (not cached) — mirrors `autoRecoveryConfig.ts`.
 *
 * ⚠️ Deliberately NO `enabled` field. The global auto-switch on/off toggle lives
 * in the SEPARATE `autoSwitchOnRateLimitPreference` settings key (schema in
 * `shared/src/schemas.ts`) and is read via `readAutoSwitchOnRateLimitPreference`
 * FRESH at each switch decision. A startup-cached `enabled` here would be an
 * admin kill-switch disconnect — the same 1234-1 finding that keeps
 * `autoRecoveryConfig.ts` toggle-free.
 */

import { getSettingsFile, readSettings, writeSettings } from "./settings";

export interface AutoSwitchConfig {
  /**
   * Max POST-KILL switches per node per rolling window (R6 / Task 4). Only a
   * switch that actually killed the session (`success`, `switch_failed_*`)
   * counts; pre-kill no-ops (`not_active`, `no_change`, `at_capacity`, …) do not.
   * Bounds a restart storm when many sessions on one capped account rise-edge
   * together.
   */
  maxSwitchesPerWindow: number;
  /** Rolling-window length in ms for `maxSwitchesPerWindow`. */
  windowMs: number;
  /**
   * Max concurrent in-flight switches per node. `1` serializes via an in-service
   * FIFO queue — #2301 warns that N concurrent capacity waiters load the daemon
   * exactly at saturation (`issue-2301-directives.md:68`), so the switch storm
   * is drained one at a time rather than fanned out.
   */
  maxConcurrentSwitches: number;
  /**
   * Per-session cooldown in ms between switch ATTEMPTS. Covers the post-switch
   * respawn window so a session that immediately re-rises on a stale-cache
   * capped target does not thrash.
   */
  perSessionCooldownMs: number;
  /**
   * When ≥2 healthy candidates exist, a target chosen within this window is
   * excluded so consecutive switches spread across accounts rather than all
   * piling onto the single lowest-score account (which would immediately cap it).
   * With exactly 1 candidate, it is used regardless.
   */
  targetSpreadMs: number;
}

function getDefaults(): AutoSwitchConfig {
  return {
    maxSwitchesPerWindow: 5,
    windowMs: 600_000, // 10 min
    maxConcurrentSwitches: 1, // serialize (see #2301 saturation note)
    perSessionCooldownMs: 600_000, // 10 min
    targetSpreadMs: 60_000, // 60 s
  };
}

/** Load auto-switch storm-guard tunables from settings.json, merging defaults. */
export async function loadAutoSwitchConfig(
  dataDir: string
): Promise<AutoSwitchConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const defaults = getDefaults();

  if (!settings) {
    return defaults;
  }

  const raw = (settings as Record<string, unknown>).autoSwitch;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const as = raw as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  return {
    maxSwitchesPerWindow: num(
      as.maxSwitchesPerWindow,
      defaults.maxSwitchesPerWindow
    ),
    windowMs: num(as.windowMs, defaults.windowMs),
    maxConcurrentSwitches: num(
      as.maxConcurrentSwitches,
      defaults.maxConcurrentSwitches
    ),
    perSessionCooldownMs: num(
      as.perSessionCooldownMs,
      defaults.perSessionCooldownMs
    ),
    targetSpreadMs: num(as.targetSpreadMs, defaults.targetSpreadMs),
  };
}

/** Persist auto-switch storm-guard tunables (NOT the global toggle). */
export async function saveAutoSwitchConfig(
  dataDir: string,
  updates: Partial<AutoSwitchConfig>
): Promise<AutoSwitchConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = (await readSettings(settingsFile)) ?? {};
  const raw = (settings as Record<string, unknown>).autoSwitch;
  const existing = raw && typeof raw === "object" ? raw : {};

  const merged = { ...existing, ...updates };
  (settings as Record<string, unknown>).autoSwitch = merged;

  await writeSettings(settingsFile, settings);

  return loadAutoSwitchConfig(dataDir);
}
