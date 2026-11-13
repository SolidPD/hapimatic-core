// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Context-Watermark successor-handoff config (issue #2158, epic rp1-home#1319).
 *
 * Loads from the "contextWatermark" key in settings.json, merged with defaults,
 * read FRESH on each call (not cached) to support runtime updates — mirrors
 * `stallWatchdogConfig.ts`.
 *
 * 🔴 DEFAULT DISABLED (R5). Unlike the stall watchdog (default-enabled — it only
 * *notifies*), this feature autonomously *terminates* sessions, so it inherits
 * `workflowReconcileConfig`'s opt-in posture: it is off until explicitly enabled.
 *
 * 🔴 The env var `HAPI_CONTEXT_WATERMARK_ENABLED` is a TRUE kill-switch: an
 * explicit falsy value force-DISABLES the feature even when settings.json says
 * `enabled: true`. A kill-switch that could only be flipped in the same file the
 * running system also writes is not a kill-switch. (A truthy value force-enables,
 * symmetric with `workflowReconcileConfig`'s env-enable — but the load-bearing
 * requirement is the force-OFF.)
 */

import {
  getSettingsFile,
  readSettings,
  updateSettings,
  type Settings,
} from "./settings";

/** Which source decided `enabled` (#6570 R11): the env variable or settings.json. */
export type ContextWatermarkEnabledSource = "env" | "settings";

export interface ContextWatermarkConfig {
  /** R5 kill-switch. Default false. Env `HAPI_CONTEXT_WATERMARK_ENABLED` overrides. */
  enabled: boolean;
  /**
   * #6570 R11: `"env"` when `HAPI_CONTEXT_WATERMARK_ENABLED` decides `enabled` (it
   * forces the feature on or off), else `"settings"`. Always set by the loader;
   * optional only so hand-built test configs need not carry it.
   */
  enabledSource?: ContextWatermarkEnabledSource;
  /** Hand off once a session has used this share of its context window (percent).
   *  Default 85 (#2587); user-editable via the admin UI + PUT /api/watermark/config. */
  watermarkPercent: number;
  /** Monitor poll cadence (ms). */
  pollIntervalMs: number;
  /**
   * Roles eligible to arm (R1). The issue says "orchestrator"; in this codebase
   * the orchestrator IS the `pm` role (#2155 `PROFILE_ROLES`, matched against
   * `session.metadata.sessionRole`). Configurable so a future role rename or an
   * additional orchestrator role needs only a settings edit.
   */
  roles: string[];
  /** Whether to wind the predecessor down after a confirmed handover (R3(e)). */
  reapPredecessor: boolean;
  /** After this bound the detached pipeline FAILS SAFE (R7). */
  handoffTimeoutMs: number;
  /** Anti-chain: a session younger than this never arms (successors must not
   *  chain-handoff moments after boot). */
  minSessionAgeMs: number;
  /** Anti-chain: packet generation cap. At the cap, alert instead of arming. */
  maxHandoffGeneration: number;
}

function getDefaults(): ContextWatermarkConfig {
  return {
    enabled: false, // R5 — opt-in; this feature ends the handed-off session
    watermarkPercent: 85, // #2587: hand off once a session has used 85% of its context
    pollIntervalMs: 30_000,
    roles: ["pm"],
    reapPredecessor: true,
    handoffTimeoutMs: 120_000,
    minSessionAgeMs: 600_000, // 10 min
    maxHandoffGeneration: 3,
  };
}

/**
 * Resolve the env kill-switch to an explicit boolean, or `null` when the env var
 * is absent/blank (→ defer to settings.json). Truthy: "1"/"true"/"yes";
 * falsy: "0"/"false"/"no". Any other value is treated as absent (defer).
 * Exported for the #6570 compact-at seed, which notes when the variable decides.
 */
export function envEnabledOverride(): boolean | null {
  const raw = process.env.HAPI_CONTEXT_WATERMARK_ENABLED;
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return null;
}

/** Load context-watermark config from settings.json, merging with defaults. */
export async function loadContextWatermarkConfig(
  dataDir: string
): Promise<ContextWatermarkConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const defaults = getDefaults();
  const envOverride = envEnabledOverride();

  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).contextWatermark
      : undefined;
  const cw =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const settingsEnabled =
    typeof cw.enabled === "boolean" ? cw.enabled : defaults.enabled;

  return {
    // The env override, when present, wins in BOTH directions — a force-off must
    // beat a settings `enabled: true`.
    enabled: envOverride ?? settingsEnabled,
    enabledSource: envOverride === null ? "settings" : "env",
    watermarkPercent:
      typeof cw.watermarkPercent === "number" && cw.watermarkPercent > 0
        ? cw.watermarkPercent
        : defaults.watermarkPercent,
    pollIntervalMs:
      typeof cw.pollIntervalMs === "number" && cw.pollIntervalMs > 0
        ? cw.pollIntervalMs
        : defaults.pollIntervalMs,
    roles:
      Array.isArray(cw.roles) && cw.roles.every(r => typeof r === "string")
        ? (cw.roles as string[])
        : defaults.roles,
    reapPredecessor:
      typeof cw.reapPredecessor === "boolean"
        ? cw.reapPredecessor
        : defaults.reapPredecessor,
    handoffTimeoutMs:
      typeof cw.handoffTimeoutMs === "number" && cw.handoffTimeoutMs > 0
        ? cw.handoffTimeoutMs
        : defaults.handoffTimeoutMs,
    minSessionAgeMs:
      typeof cw.minSessionAgeMs === "number" && cw.minSessionAgeMs >= 0
        ? cw.minSessionAgeMs
        : defaults.minSessionAgeMs,
    maxHandoffGeneration:
      typeof cw.maxHandoffGeneration === "number" &&
      cw.maxHandoffGeneration >= 0
        ? cw.maxHandoffGeneration
        : defaults.maxHandoffGeneration,
  };
}

/**
 * Persist context-watermark config updates to settings.json.
 *
 * #6570 R13: through `updateSettings`, so an unreadable settings.json is refused
 * with `SettingsUnreadableError` and left byte-identical. The prior
 * `(await readSettings(...)) ?? {}` + `writeSettings` replaced an unreadable file
 * with this one key, deleting `cliApiToken`, `apiKeys` and the federation keys.
 * The merge is over the stored block, so keys this type does not name (the #6570
 * `compactAtSwitchOffAt` marker) survive.
 */
export async function saveContextWatermarkConfig(
  dataDir: string,
  updates: Partial<ContextWatermarkConfig>
): Promise<ContextWatermarkConfig> {
  const settingsFile = getSettingsFile(dataDir);
  await updateSettings(settingsFile, current => {
    const raw = (current as Record<string, unknown>).contextWatermark;
    const existing =
      raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return {
      ...current,
      contextWatermark: { ...existing, ...updates },
    } as Settings;
  });

  return loadContextWatermarkConfig(dataDir);
}
