// SPDX-License-Identifier: AGPL-3.0-only
import { getSettingsFile, readSettings } from "./settings";

/**
 * Issue #1883 (Phase 2) — session-fatal auto-abort config. Reads the
 * `"sessionFatal"` key of settings.json, falling back to a DEFAULT-OFF default.
 * Mirrors the `harnessPollConfig.ts` loader shape (settings.json > default).
 *
 * Auto-abort is gated behind BOTH this flag AND the env switch
 * `HAPI_SESSION_FATAL_ABORT_ENABLED=1` (see SyncEngine) — a dual gate whose
 * fail-safe is "no abort". Default OFF: the Phase-1 out-of-band escalation
 * notifies the user, who decides whether to pause/abort.
 */
export interface SessionFatalConfig {
  /**
   * Phase-2 auto-abort master switch. DEFAULT FALSE (R7). Even when `true`, the
   * env switch must ALSO be on for any abort to fire.
   */
  autoAbortEnabled: boolean;
}

function getDefaults(): SessionFatalConfig {
  return { autoAbortEnabled: false };
}

/** Load session-fatal config from settings.json, merged with defaults. */
export async function loadSessionFatalConfig(
  dataDir: string
): Promise<SessionFatalConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const defaults = getDefaults();

  if (!settings) return defaults;

  const raw = (settings as Record<string, unknown>).sessionFatal;
  if (!raw || typeof raw !== "object") return defaults;

  const sf = raw as Record<string, unknown>;
  return {
    autoAbortEnabled:
      typeof sf.autoAbortEnabled === "boolean"
        ? sf.autoAbortEnabled
        : defaults.autoAbortEnabled,
  };
}
