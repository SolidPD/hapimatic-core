// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Time Log Configuration Loader (Issue #1119)
 *
 * Loads timezone preference from the "timeLogPreferences" key in settings.json.
 * Falls back to the server's local IANA timezone (NOT hardcoded America/New_York)
 * when the preference is absent.
 *
 * Used by SyncEngine to compute per-namespace midnight boundaries
 * (replaces the hardcoded America/New_York date helper from before #1119).
 *
 * Config is loaded fresh on each call (not cached) to support runtime updates.
 */

import { FederationSettingsBlockSchema } from "@hapi/protocol/schemas";
import { getSettingsFile, readSettings } from "./settings";
import { resolveEffective } from "../services/settingsSyncService";

export type TimeLogConfig = {
  /** IANA timezone identifier, e.g. "America/New_York", "Europe/London". */
  timezone: string;
  /**
   * #4613: true when `timezone` came from the federation-global `timeLogTimezone`
   * value (every node resolves the SAME zone), false when it fell back to this
   * node's local `timeLogPreferences.timezone` → host-zone chain. Callers that
   * must make the federation value WIN over a per-namespace stored row (the
   * derived read path) pass `timezone` as `resolveNamespaceTimezone`'s
   * `federationOverride` only when this is true.
   */
  isFederation: boolean;
};

function getServerDefaultTimezone(): string {
  // Intl.DateTimeFormat returns the runtime's resolved IANA timezone.
  // On Linux this typically reads /etc/localtime → /usr/share/zoneinfo/<TZ>.
  // Falls back to "UTC" if Intl is unavailable (defensive — should not happen on Bun).
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function isValidTimezone(tz: string): boolean {
  // The cheapest cross-runtime IANA validation: ask Intl to construct a formatter.
  // Invalid identifiers throw RangeError. Valid ones (including unusual zones like
  // "Etc/GMT-12") are accepted.
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The node-LOCAL time-log zone chain (pre-#4613 behavior, unchanged): the
 * `timeLogPreferences.timezone` key if present + valid, else the server host zone.
 * This is the fallback used both when NO federation value is set (R2) and as the
 * A-local value `buildView` shows in the Preferences UI.
 */
function resolveLocalTimeLogTimezone(
  settings: unknown,
  serverDefault: string
): string {
  if (!settings) return serverDefault;
  const raw = (settings as Record<string, unknown>).timeLogPreferences;
  if (!raw || typeof raw !== "object") return serverDefault;
  const candidate = (raw as Record<string, unknown>).timezone;
  if (typeof candidate !== "string" || candidate.length === 0) {
    return serverDefault;
  }
  if (!isValidTimezone(candidate)) {
    // Defense-in-depth: a malformed IANA string (typo, deprecated zone, etc.)
    // would otherwise throw inside SyncEngine's per-tick date computation.
    // Falling back here keeps midnight resets running on the server default.
    return serverDefault;
  }
  return candidate;
}

/**
 * Read the federation-global `timeLogTimezone` effective value from a parsed
 * settings object, or `null` when none is in effect. Goes through #2624's
 * `resolveEffective` — THE single effective-value read path (R1) — so the
 * inherit flag / node-local override semantics are honored identically to the
 * rest of the federation-settings layer. The value is re-validated with
 * `isValidTimezone` as defense-in-depth (a malformed peer value is ignored).
 */
function resolveFederationTimeLogTimezone(settings: unknown): string | null {
  if (!settings) return null;
  // #4613: safeParse, never .parse — a structurally-malformed `federationSettings`
  // block (disk corruption, manual tampering, a cross-version downgrade) must fall
  // back to the local chain, NOT throw. `loadTimeLogConfig` is on always-on paths
  // (the derived endpoint + the 60s midnight-reset tick), so a throw here is a 500 /
  // a stalled reset — a direct violation of this feature's own R2 "never crash,
  // never silently wrong" invariant. A valid block with a malformed VALUE is already
  // handled below (resolveEffective safeParses + isValidTimezone re-check → local).
  const parsed = FederationSettingsBlockSchema.safeParse(
    (settings as Record<string, unknown>).federationSettings ?? {}
  );
  if (!parsed.success) return null;
  const eff = resolveEffective(parsed.data, "timeLogTimezone");
  if (typeof eff === "string" && eff.length > 0 && isValidTimezone(eff)) {
    return eff;
  }
  return null;
}

/**
 * Load the effective time-log config. #4613: the federation-global
 * `timeLogTimezone` WINS when set (every node resolves the SAME zone); otherwise
 * the node-local `timeLogPreferences.timezone` → host-zone chain is used exactly
 * as before (R2 — a non-federated node or a federation with no value set is
 * byte-identical to pre-#4613). Config is loaded fresh on each call (not cached)
 * to support runtime updates.
 */
export async function loadTimeLogConfig(
  dataDir: string
): Promise<TimeLogConfig> {
  const settingsFile = getSettingsFile(dataDir);
  const settings = await readSettings(settingsFile);
  const serverDefault = getServerDefaultTimezone();

  const federationTz = resolveFederationTimeLogTimezone(settings);
  if (federationTz) {
    return { timezone: federationTz, isFederation: true };
  }

  return {
    timezone: resolveLocalTimeLogTimezone(settings, serverDefault),
    isFederation: false,
  };
}

/**
 * The node-LOCAL time-log zone (NO federation resolution), for the Preferences
 * `buildView` fallback — it shows A's per-node value when no federation-global
 * has been written, so it MUST NOT itself consult the federation layer (that
 * would make the view report the federation value as the "default"). #4613.
 */
export async function readLocalTimeLogTimezone(
  settingsFile: string
): Promise<string> {
  const settings = await readSettings(settingsFile);
  return resolveLocalTimeLogTimezone(settings, getServerDefaultTimezone());
}
