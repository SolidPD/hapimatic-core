// SPDX-License-Identifier: AGPL-3.0-only
import type { FederationConfig } from "@hapi/protocol";

/**
 * Turn-ledger mirror pull-loop config (issue #4614).
 *
 * The mirror is a background replication backstop, not a latency-critical path,
 * so the default cadence (60s) is deliberately slower than the 15s session poll.
 * The per-node opt-out has TWO sources (env wins, mirroring federationConfig's
 * own env-override precedence): the `FEDERATION_TURN_MIRROR_DISABLED` env var and
 * the `settings.federation.turnMirrorDisabled` flag (carried on FederationConfig).
 * `enabled:false` does NOT skip constructing the loop — index.ts still builds the
 * SupervisedLoop so it registers as "stopped" and the opt-out stays visible in
 * the System Jobs portal (the KD-9 pattern).
 */
export interface TurnMirrorConfig {
  /** When false, the pull loop registers as "stopped" and stores no mirror rows. */
  enabled: boolean;
  /** Cadence between pull ticks, in ms. Default 60s. */
  pollIntervalMs: number;
}

const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Floor so a hand-edited/env value can't hammer peers. */
const MIN_POLL_INTERVAL_MS = 10_000;

function isTruthyEnv(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Compute the mirror config from the already-loaded FederationConfig + env.
 * Sync (federationConfig is loaded once at boot); loaded fresh wherever called.
 */
export function loadTurnMirrorConfig(
  federationConfig: FederationConfig | null
): TurnMirrorConfig {
  const envDisabled = isTruthyEnv(process.env.FEDERATION_TURN_MIRROR_DISABLED);
  const settingsDisabled = federationConfig?.turnMirrorDisabled === true;

  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  const rawEnvMs = process.env.FEDERATION_TURN_MIRROR_POLL_MS;
  if (rawEnvMs) {
    const parsed = parseInt(rawEnvMs, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      pollIntervalMs = Math.max(MIN_POLL_INTERVAL_MS, parsed);
    }
  }

  return {
    enabled: !(envDisabled || settingsDisabled),
    pollIntervalMs,
  };
}
