// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Launch `pwsh` from a test without writing to the system log (issue #6158, D5).
 *
 * PowerShell on Linux logs to syslog by default, and it automatically logs every
 * script block that contains "suspicious" text as a `ScriptBlock_Compile_Detail`
 * warning, in 13-part chunks. The porter export script trips that check, so a
 * run of the porter suites put ~1 GB a day into ms1's syslog (2026-11-01..03,
 * ~97% of `syslog.1`).
 *
 * `-SettingsFile` points pwsh at a settings file that turns script-block
 * logging off and raises `LogLevel` to `Critical`. Measured with pwsh 7.6.7:
 * policy-off alone still writes 3-4 startup/IPC lines per process; with
 * `LogLevel: Critical` pwsh writes nothing. On Windows the argv is unchanged
 * (PowerShell logs to the event log there, and the Windows CI leg stays as it was).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { testScratchRoot } from "./scratchRoot";

export const PWSH_QUIET_SETTINGS = {
  PowerShellPolicies: {
    ScriptBlockLogging: { EnableScriptBlockLogging: false },
  },
  LogLevel: "Critical",
} as const;

const SETTINGS_NAME = "pwsh-quiet-settings.json";

/** The settings file, written into this run's scratch root on demand. */
export function pwshQuietSettingsFile(): string {
  const file = join(testScratchRoot(), SETTINGS_NAME);
  writeFileSync(file, JSON.stringify(PWSH_QUIET_SETTINGS));
  return file;
}

/**
 * The pwsh options every test spawn passes before `-File` / `-Command`
 * (pwsh hands everything after `-File` to the script).
 */
export function pwshArgs(
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === "win32") return ["-NoProfile"];
  return ["-NoProfile", "-SettingsFile", pwshQuietSettingsFile()];
}

/** `["pwsh", ...pwshArgs()]` — the start of a test's pwsh argv. */
export function pwshCommand(
  platform: NodeJS.Platform = process.platform
): string[] {
  return ["pwsh", ...pwshArgs(platform)];
}
