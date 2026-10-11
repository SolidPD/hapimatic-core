// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Time-log cutover override loader (issue #2247, epic #1662 Sub H).
 *
 * Loads the operator cutover override from the "timelogCutover" key in
 * settings.json, read FRESH on each call (not cached) so an operator edit takes
 * effect without a restart — mirrors `timeLogConfig.ts` / `parityThresholds.ts`.
 *
 * Ratified by the #1892 "Gate re-scope #2 (2026-07-19)" decision record: the
 * time-metric parity soak is retired as a cutover gate (the legacy baseline
 * measures browser attention, not work). Setting
 * `{ "timelogCutover": { "force": true } }` forces the turns-derived read-path
 * gate open while the nightly parity harness keeps running as a NON-gating
 * background self-audit.
 *
 * Fail-safe direction: every failure mode (missing file, parse error, absent
 * key, wrong type) yields `{ force: false }` — the parity-driven default path
 * stays byte-identical unless the operator explicitly sets the flag.
 */

import { getSettingsFile, readSettings } from "./settings";

export interface TimelogCutoverConfig {
  /** When true, the cutover gate reports ready regardless of parity streaks. */
  force: boolean;
}

/** Load the cutover override from settings.json, defaulting to override-off. */
export async function loadTimelogCutoverConfig(
  dataDir: string
): Promise<TimelogCutoverConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  if (!settings || typeof settings !== "object") {
    return { force: false };
  }

  const raw = (settings as Record<string, unknown>).timelogCutover;
  if (!raw || typeof raw !== "object") {
    return { force: false };
  }

  // `=== true` implies the boolean type check — any non-boolean (or false)
  // value resolves to override-off.
  return { force: (raw as Record<string, unknown>).force === true };
}
