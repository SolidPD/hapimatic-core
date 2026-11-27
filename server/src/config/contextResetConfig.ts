// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Context-reset config (issue #6559, Task 6; R11).
 *
 * Loads the "contextReset" key of settings.json, merged with the shared
 * defaults, read FRESH on every call (not cached), like
 * `contextWatermarkConfig.ts`.
 *
 * 🔴 Ships OFF. The environment variable `HAPI_CONTEXT_RESET` overrides
 * `enabled` in BOTH directions ("1"/"true"/"yes" on, "0"/"false"/"no" off; any
 * other value is absent). `HAPI_CONTEXT_RESET=0` on the server unit is the only
 * hard off, because the settings file loses to it.
 *
 * Load only, by ruling Q7a: there is no save function and no route that writes
 * the setting. The environment variable and the settings file are the switch.
 */

import {
  CONTEXT_RESET_DEFAULTS,
  type ContextResetConfig as SharedContextResetConfig,
} from "@hapi/protocol";
import { getSettingsFile, readSettings } from "./settings";

/** Which source decided `enabled`: the environment variable or settings.json. */
export type ContextResetEnabledSource = "env" | "settings";

export type ContextResetConfig = SharedContextResetConfig & {
  enabledSource: ContextResetEnabledSource;
};

/**
 * `HAPI_CONTEXT_RESET` as an explicit boolean, or `null` when it is absent,
 * blank or not one of the six accepted values (→ the settings file decides).
 */
export function contextResetEnvOverride(): boolean | null {
  const raw = process.env.HAPI_CONTEXT_RESET;
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return null;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}

/** Load the context-reset config from settings.json, merged with the defaults. */
export async function loadContextResetConfig(
  dataDir: string
): Promise<ContextResetConfig> {
  // An unreadable settings.json reads as null: the defaults apply (switch off).
  const settings = await readSettings(getSettingsFile(dataDir));
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).contextReset
      : undefined;
  const cr =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const d = CONTEXT_RESET_DEFAULTS;
  const envOverride = contextResetEnvOverride();
  const settingsEnabled =
    typeof cr.enabled === "boolean" ? cr.enabled : d.enabled;

  return {
    // The env override, when present, wins in both directions.
    enabled: envOverride ?? settingsEnabled,
    enabledSource: envOverride === null ? "settings" : "env",
    maxDeferMs: positiveInt(cr.maxDeferMs, d.maxDeferMs),
    settleMs: nonNegativeInt(cr.settleMs, d.settleMs),
    backstopTickMs: positiveInt(cr.backstopTickMs, d.backstopTickMs),
    resultTimeoutMs: positiveInt(cr.resultTimeoutMs, d.resultTimeoutMs),
    instructionsMaxChars: positiveInt(
      cr.instructionsMaxChars,
      d.instructionsMaxChars
    ),
    fireAttemptsMax: positiveInt(cr.fireAttemptsMax, d.fireAttemptsMax),
  };
}
