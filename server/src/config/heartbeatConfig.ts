// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Heartbeat Configuration Loader
 *
 * Loads heartbeat settings from the "heartbeat" key in settings.json.
 * Falls back to sensible defaults when not configured.
 * Config is loaded fresh on each call (not cached) to support runtime updates.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { getSettingsFile, readSettings, writeSettings } from "./settings";
import type { HeartbeatConfig } from "../heartbeat/types";

function getDefaults(dataDir: string): HeartbeatConfig {
  return {
    enabled: false,
    every: 1_800_000, // 30 minutes
    activeHours: {
      start: 8,
      end: 22,
      timezone: "America/New_York",
    },
    instructionsFile: join(dataDir, "heartbeat-instructions.md"),
    sessionDirectory: homedir(),
    ackMaxChars: 300,
    rotateAfterBeats: 48,
    maxSessionAgeMs: 86_400_000, // 24 hours
  };
}

/** Load heartbeat config from settings.json, merging with defaults */
export async function loadHeartbeatConfig(
  dataDir: string
): Promise<HeartbeatConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const defaults = getDefaults(dataDir);

  if (!settings) {
    return defaults;
  }

  const raw = (settings as Record<string, unknown>).heartbeat;
  if (!raw || typeof raw !== "object") {
    return defaults;
  }

  const hb = raw as Record<string, unknown>;

  // Merge active hours
  const rawActiveHours = hb.activeHours;
  let activeHours = defaults.activeHours;
  if (rawActiveHours && typeof rawActiveHours === "object") {
    const ah = rawActiveHours as Record<string, unknown>;
    activeHours = {
      start:
        typeof ah.start === "number" ? ah.start : defaults.activeHours.start,
      end: typeof ah.end === "number" ? ah.end : defaults.activeHours.end,
      timezone:
        typeof ah.timezone === "string"
          ? ah.timezone
          : defaults.activeHours.timezone,
    };
  }

  return {
    enabled: typeof hb.enabled === "boolean" ? hb.enabled : defaults.enabled,
    every: typeof hb.every === "number" ? hb.every : defaults.every,
    activeHours,
    instructionsFile:
      typeof hb.instructionsFile === "string"
        ? hb.instructionsFile
        : defaults.instructionsFile,
    sessionDirectory:
      typeof hb.sessionDirectory === "string"
        ? hb.sessionDirectory
        : defaults.sessionDirectory,
    ackMaxChars:
      typeof hb.ackMaxChars === "number"
        ? hb.ackMaxChars
        : defaults.ackMaxChars,
    rotateAfterBeats:
      typeof hb.rotateAfterBeats === "number"
        ? hb.rotateAfterBeats
        : defaults.rotateAfterBeats,
    maxSessionAgeMs:
      typeof hb.maxSessionAgeMs === "number"
        ? hb.maxSessionAgeMs
        : defaults.maxSessionAgeMs,
    ...(typeof hb.machine === "string" ? { machine: hb.machine } : {}),
    ...(typeof hb.sessionName === "string"
      ? { sessionName: hb.sessionName }
      : {}),
    ...(typeof hb.sessionEmoji === "string"
      ? { sessionEmoji: hb.sessionEmoji }
      : {}),
    ...(hb.sessionType === "simple" || hb.sessionType === "worktree"
      ? { sessionType: hb.sessionType }
      : {}),
    ...(typeof hb.worktreeBranchName === "string"
      ? { worktreeBranchName: hb.worktreeBranchName }
      : {}),
  };
}

/** Check whether a heartbeat configuration exists in settings.json */
export async function hasHeartbeatConfig(dataDir: string): Promise<boolean> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  if (!settings) return false;
  const raw = (settings as Record<string, unknown>).heartbeat;
  return raw != null && typeof raw === "object";
}

/** Remove the heartbeat key from settings.json entirely */
export async function deleteHeartbeatConfig(dataDir: string): Promise<void> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = (await readSettings(settingsFile)) ?? {};
  delete (settings as Record<string, unknown>).heartbeat;
  await writeSettings(settingsFile, settings);
}

/** Persist heartbeat config updates to settings.json */
export async function saveHeartbeatConfig(
  dataDir: string,
  updates: Partial<HeartbeatConfig>
): Promise<HeartbeatConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = (await readSettings(settingsFile)) ?? {};
  const raw = (settings as Record<string, unknown>).heartbeat;
  const existing = raw && typeof raw === "object" ? raw : {};

  // Merge updates into existing heartbeat config
  const merged = { ...existing, ...updates };
  (settings as Record<string, unknown>).heartbeat = merged;

  await writeSettings(settingsFile, settings);

  // Return the full resolved config
  return loadHeartbeatConfig(dataDir);
}
