// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Auto-Recovery Configuration Loader (#1234, Epic #1231 Sub-Issue C)
 *
 * Loads auto-recovery TUNABLES from the "autoRecovery" key in settings.json.
 * Falls back to sensible defaults when not configured. Config is loaded fresh
 * on each call (not cached) to support runtime updates — mirrors the
 * `stallWatchdogConfig.ts` structure.
 *
 * ⚠️ Deliberately NO `enabled` field. The global auto-recover on/off toggle
 * lives in the SEPARATE `autoRecoverPreference` settings key (owned by #1236)
 * and is read via `readAutoRecoverPreference(settingsFile)` FRESH at each
 * recovery decision. A startup-cached `enabled` here would be an admin
 * kill-switch disconnect — see directive finding 1234-1.
 */

import { getSettingsFile, readSettings, writeSettings } from "./settings";

export interface AutoRecoveryConfig {
  /**
   * Cooldown before each recovery attempt, indexed by the session's attempt
   * count within the rolling hour. `[60s, 5min, 15min]` by default; the 4th
   * attempt (index out of range) triggers R4/max-attempts give-up.
   */
  cooldownLadderMs: number[];
  /** Max recovery attempts per session per rolling hour (R2). */
  maxAttemptsPerHour: number;
  /** Default recovery prompt text (R7). */
  defaultPrompt: string;
  /**
   * Window with no new exhausted event after which a pending attempt is marked
   * "recovered" (R9). MUST comfortably exceed the ~10-min SDK retry-exhaustion
   * latency — a shorter window falsely marks sustained overload as recovered
   * and produces an unbounded prompt loop.
   */
  successWindowMs: number;
  /**
   * Number of consecutive recovery attempts latched "api-error-again" before the
   * R4 persistent-overload give-up fires.
   */
  requestAbortGuard: number;
}

/** R7 default recovery prompt — conservative "pick up where you left off". */
export const DEFAULT_RECOVERY_PROMPT =
  "An API overload error interrupted the previous response. Please pick up " +
  "where you left off without re-explaining what you've done.";

function getDefaults(): AutoRecoveryConfig {
  return {
    cooldownLadderMs: [60_000, 300_000, 900_000], // 60s → 5min → 15min
    maxAttemptsPerHour: 3,
    defaultPrompt: DEFAULT_RECOVERY_PROMPT,
    successWindowMs: 900_000, // 15 min — MUST exceed the ~10-min SDK retry latency (R9)
    requestAbortGuard: 2,
  };
}

/** Load auto-recovery tunables from settings.json, merging with defaults. */
export async function loadAutoRecoveryConfig(
  dataDir: string
): Promise<AutoRecoveryConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const defaults = getDefaults();

  if (!settings) {
    return defaults;
  }

  const raw = (settings as Record<string, unknown>).autoRecovery;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const ar = raw as Record<string, unknown>;

  return {
    cooldownLadderMs:
      Array.isArray(ar.cooldownLadderMs) &&
      (ar.cooldownLadderMs as unknown[]).every(
        (n): n is number => typeof n === "number"
      )
        ? (ar.cooldownLadderMs as number[])
        : defaults.cooldownLadderMs,
    maxAttemptsPerHour:
      typeof ar.maxAttemptsPerHour === "number"
        ? ar.maxAttemptsPerHour
        : defaults.maxAttemptsPerHour,
    defaultPrompt:
      typeof ar.defaultPrompt === "string"
        ? ar.defaultPrompt
        : defaults.defaultPrompt,
    successWindowMs:
      typeof ar.successWindowMs === "number"
        ? ar.successWindowMs
        : defaults.successWindowMs,
    requestAbortGuard:
      typeof ar.requestAbortGuard === "number"
        ? ar.requestAbortGuard
        : defaults.requestAbortGuard,
  };
}

/** Persist auto-recovery tunables (NOT the global toggle) to settings.json. */
export async function saveAutoRecoveryConfig(
  dataDir: string,
  updates: Partial<AutoRecoveryConfig>
): Promise<AutoRecoveryConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = (await readSettings(settingsFile)) ?? {};
  const raw = (settings as Record<string, unknown>).autoRecovery;
  const existing = raw && typeof raw === "object" ? raw : {};

  const merged = { ...existing, ...updates };
  (settings as Record<string, unknown>).autoRecovery = merged;

  await writeSettings(settingsFile, settings);

  return loadAutoRecoveryConfig(dataDir);
}
