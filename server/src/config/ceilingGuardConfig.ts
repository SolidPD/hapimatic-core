// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Runaway-session guard config (issue #1905) — loader/saver over the
 * "ceilingGuard" key in settings.json, merged with the generous defaults baked
 * into {@link CeilingGuardConfigSchema}. Read FRESH on demand. Mirrors
 * `contextWatermarkConfig.ts` (same getDefaults / load / save shape + env
 * kill-switch), but keyed by `settingsFile` (both callers — `index.ts` and the
 * `/preferences/ceiling-guard` route — already hold the settings-file path).
 *
 * 🔴 The env var `HAPI_CEILING_GUARD_ENABLED` is a TRUE kill-switch: an explicit
 * falsy value force-DISABLES the guard even when settings.json says
 * `enabled: true`. A kill-switch that could only be flipped in the same file the
 * running system also writes is not a kill-switch (1905-2). A truthy value
 * force-enables (symmetric), but the load-bearing requirement is the force-OFF.
 * `saveCeilingGuardConfig` returns via `loadCeilingGuardConfig`, so the env
 * override always re-applies after a settings PUT.
 */

import {
  CeilingGuardConfigSchema,
  type CeilingGuardConfig,
  type CeilingGuardPreferencePatch,
} from "@hapi/protocol/schemas";

import { readSettings, writeSettings } from "./settings";

/** The generous defaults (K2 — derived from prod P99/max, see the schema doc). */
export function getCeilingGuardDefaults(): CeilingGuardConfig {
  return CeilingGuardConfigSchema.parse({});
}

/**
 * Resolve the env kill-switch to an explicit boolean, or `null` when the env var
 * is absent/blank (→ defer to settings.json). Truthy: "1"/"true"/"yes";
 * falsy: "0"/"false"/"no". Any other value is treated as absent (defer).
 * Mirrors `contextWatermarkConfig.ts` `envEnabledOverride`.
 */
function envEnabledOverride(): boolean | null {
  const raw = process.env.HAPI_CEILING_GUARD_ENABLED;
  if (raw == null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "") return null;
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return null;
}

/**
 * Load the ceiling-guard config from settings.json, merged with defaults. A
 * stored partial has its missing fields filled by the schema's `.default(...)`;
 * an invalid `roleOverrides` map alone is dropped (logged); any other malformed
 * value falls back wholesale to the generous defaults, also logged
 * ({@link parseStoredConfig}).
 */
export async function loadCeilingGuardConfig(
  settingsFile: string
): Promise<CeilingGuardConfig> {
  const settings = await readSettings(settingsFile);
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).ceilingGuard
      : undefined;
  const input: Record<string, unknown> =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const config = parseStoredConfig(input);

  const envOverride = envEnabledOverride();
  // The env override wins in BOTH directions — a force-off must beat a settings
  // `enabled: true` (the load-bearing R5 kill-switch requirement, 1905-2).
  return envOverride == null ? config : { ...config, enabled: envOverride };
}

/**
 * Parse the stored `ceilingGuard` block. A failure is LOGGED, never silent
 * (#5254 SF-1): before `roleOverrides`, a bad block was hard to produce, but one
 * mistyped role key or a non-positive ceiling inside a role profile (a hand
 * edit, or a rollback to a build without a newer role) would otherwise throw
 * away the operator's whole config. When only `roleOverrides` is invalid, drop
 * that map (the default role profiles apply) and keep every other field.
 */
function parseStoredConfig(input: Record<string, unknown>): CeilingGuardConfig {
  const parsed = CeilingGuardConfigSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues
    .map(i => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  if (parsed.error.issues.every(i => i.path[0] === "roleOverrides")) {
    const { roleOverrides: _invalid, ...rest } = input;
    const retry = CeilingGuardConfigSchema.safeParse(rest);
    if (retry.success) {
      console.error(
        `[ceilingGuard] ignoring invalid roleOverrides in settings.json (default role profiles apply; the rest of the config is kept): ${issues}`
      );
      return retry.data;
    }
  }
  console.error(
    `[ceilingGuard] invalid ceilingGuard block in settings.json — using the defaults: ${issues}`
  );
  return getCeilingGuardDefaults();
}

/**
 * Persist a partial ceiling-guard config update to settings.json, merging over
 * the stored value (an omitted key means "unchanged"; an explicit `null` clears
 * that ceiling dimension). Returns the freshly re-loaded config (env override
 * re-applied, validated). The merge is SHALLOW: a supplied `roleOverrides`
 * (#5254) replaces the stored map wholesale, so a PUT must carry every role
 * profile it wants to keep.
 */
export async function saveCeilingGuardConfig(
  settingsFile: string,
  updates: CeilingGuardPreferencePatch
): Promise<CeilingGuardConfig> {
  const settings = (await readSettings(settingsFile)) ?? {};
  const raw = (settings as Record<string, unknown>).ceilingGuard;
  const existing = raw && typeof raw === "object" ? raw : {};

  const merged: Record<string, unknown> = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    // Drop `undefined` so an absent key never overwrites the stored value; a
    // present `null` (clear-this-dimension) is preserved.
    if (value !== undefined) merged[key] = value;
  }
  (settings as Record<string, unknown>).ceilingGuard = merged;

  await writeSettings(settingsFile, settings);

  return loadCeilingGuardConfig(settingsFile);
}
