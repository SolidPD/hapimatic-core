// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import {
  compactAtSessionEnv,
  resolveCompactAt,
  type CompactAtSessionEnv,
} from "@hapi/protocol";
import { configuration } from "@/configuration";
import { logger } from "@/ui/logger";

/**
 * Issue #6570: the per-session compact-at `env` block the session wrapper writes
 * into its `--settings` file (`generateHookSettingsFile`'s `env` option).
 *
 * The wrapper reads the node's `settings.json` itself at start (the
 * `readSettingsLauncherSync` / `codexTransport` precedent), through the same shared
 * accessor the server's GET and boot seed use (`resolveCompactAt`), so a session
 * gets the value Settings shows. It deliberately does NOT use `readSettingsSync`,
 * which turns a parse error into `{}`: here an unreadable file must resolve to
 * `unreadable` (off — today's behavior), never to "default, on".
 *
 * The CLI never writes `compactAt` (the server is the sole writer). The value is
 * fixed for the wrapper's life: a changed preference reaches new and restarted
 * sessions only.
 */
export interface SessionCompactionDeps {
  settingsFile: string;
}

function readSettingsForCompaction(settingsFile: string): unknown {
  if (!existsSync(settingsFile)) return {};
  try {
    return JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {
    return null; // unreadable → off
  }
}

/**
 * The three env strings for this session, or `null` when the node's compact-at
 * value is off, invalid or unreadable. Never throws: a session start must not fail
 * on this.
 */
export function resolveSessionCompactionEnv(
  deps: SessionCompactionDeps = { settingsFile: configuration.settingsFile }
): CompactAtSessionEnv | null {
  try {
    const resolved = resolveCompactAt(
      readSettingsForCompaction(deps.settingsFile)
    );
    const env = compactAtSessionEnv(resolved);
    logger.debug(
      `[compact-at] source=${resolved.source} ${
        env ? `percent=${resolved.percent}` : "off"
      }`
    );
    return env;
  } catch (error) {
    logger.debug(
      `[compact-at] could not resolve the session value: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}
