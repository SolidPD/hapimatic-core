// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stall Watchdog Configuration Loader
 *
 * Loads stall watchdog settings from the "stallWatchdog" key in settings.json.
 * Falls back to sensible defaults when not configured.
 * Config is loaded fresh on each call (not cached) to support runtime updates.
 */

import {
  getSettingsFile,
  readSettings,
  writeSettings,
} from "../../config/settings";
import type { StallWatchdogConfig } from "./types";

function getDefaults(): StallWatchdogConfig {
  return {
    enabled: true,
    pollIntervalMs: 30_000, // 30 seconds
    thinkingThresholdMs: 300_000, // 5 minutes
    confirmationWindowMs: 60_000, // 1 minute
    cooldownMs: 600_000, // 10 minutes
    nudgeEnabled: false,
    nudgeMessage: "[WATCHDOG] Session appears stalled. Are you stuck?",
  };
}

/** Load stall watchdog config from settings.json, merging with defaults */
export async function loadStallWatchdogConfig(
  dataDir: string
): Promise<StallWatchdogConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const defaults = getDefaults();

  if (!settings) {
    return defaults;
  }

  const raw = (settings as Record<string, unknown>).stallWatchdog;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const sw = raw as Record<string, unknown>;

  return {
    enabled: typeof sw.enabled === "boolean" ? sw.enabled : defaults.enabled,
    pollIntervalMs:
      typeof sw.pollIntervalMs === "number"
        ? sw.pollIntervalMs
        : defaults.pollIntervalMs,
    thinkingThresholdMs:
      typeof sw.thinkingThresholdMs === "number"
        ? sw.thinkingThresholdMs
        : defaults.thinkingThresholdMs,
    confirmationWindowMs:
      typeof sw.confirmationWindowMs === "number"
        ? sw.confirmationWindowMs
        : defaults.confirmationWindowMs,
    cooldownMs:
      typeof sw.cooldownMs === "number" ? sw.cooldownMs : defaults.cooldownMs,
    nudgeEnabled:
      typeof sw.nudgeEnabled === "boolean"
        ? sw.nudgeEnabled
        : defaults.nudgeEnabled,
    nudgeMessage:
      typeof sw.nudgeMessage === "string"
        ? sw.nudgeMessage
        : defaults.nudgeMessage,
  };
}

/** Persist stall watchdog config updates to settings.json */
export async function saveStallWatchdogConfig(
  dataDir: string,
  updates: Partial<StallWatchdogConfig>
): Promise<StallWatchdogConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = (await readSettings(settingsFile)) ?? {};
  const raw = (settings as Record<string, unknown>).stallWatchdog;
  const existing = raw && typeof raw === "object" ? raw : {};

  const merged = { ...existing, ...updates };
  (settings as Record<string, unknown>).stallWatchdog = merged;

  await writeSettings(settingsFile, settings);

  return loadStallWatchdogConfig(dataDir);
}
