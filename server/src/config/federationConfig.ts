// SPDX-License-Identifier: AGPL-3.0-only
import {
  FederationConfigSchema,
  normalizeNodeWebUrl,
  type FederationConfig,
} from "@hapi/protocol";
import type { Settings } from "./settings";
import { localNodeDisplayLabel } from "./nodeLabel";

/**
 * Load federation configuration from settings with env var overrides.
 * Returns null if federation is not enabled.
 */
export function loadFederationConfig(
  settings: Settings
): FederationConfig | null {
  const raw = settings.federation;
  if (!raw?.enabled) {
    return null;
  }

  // Issue #6123: this node's user-facing web address. Normalized here, before
  // the parse below, because that parse is unguarded at boot (index.ts) and a
  // typo in a display-only setting must never stop the server: an invalid
  // value is dropped with a warning. `||` so an empty env falls through.
  const rawWebUrl = process.env.FEDERATION_WEB_URL || raw.webUrl;
  const webUrl = normalizeNodeWebUrl(rawWebUrl);
  if (rawWebUrl && !webUrl) {
    console.warn(
      "[federation] ignoring invalid webUrl (FEDERATION_WEB_URL / federation.webUrl): it must be an http(s) URL without a username or password"
    );
  }

  // Issue #6483: the turn-mirror opt-out (#4614). Carried only as a real
  // boolean, for the reason given for webUrl above: a hand-edited "true" or 1
  // is dropped with a warning (the mirror keeps running, as it did before this
  // fix) instead of stopping the server. null reads as unset.
  const rawTurnMirrorDisabled: unknown = raw.turnMirrorDisabled;
  const turnMirrorDisabled =
    typeof rawTurnMirrorDisabled === "boolean"
      ? rawTurnMirrorDisabled
      : undefined;
  if (rawTurnMirrorDisabled != null && turnMirrorDisabled === undefined) {
    console.warn(
      "[federation] ignoring invalid turnMirrorDisabled (federation.turnMirrorDisabled): it must be true or false"
    );
  }

  const merged = {
    enabled: true,
    role: (process.env.FEDERATION_ROLE ?? raw.role ?? "node") as
      | "hub"
      | "node"
      | "peer",
    nodeId: process.env.FEDERATION_NODE_ID ?? raw.nodeId ?? "unknown",
    // System-wide node-label casing (epic #3285 round 11): local machines UPPER
    // CASE, cloud VMs lower case — applied HERE, where this node's own label
    // enters the system, so every emission (info route, session enrichment,
    // health, alerts, usage, Sentry) inherits it. See config/nodeLabel.ts for
    // how a cloud host is recognized.
    nodeLabel: localNodeDisplayLabel(
      process.env.FEDERATION_NODE_LABEL ?? raw.nodeLabel ?? "Unknown Node",
      process.env.FEDERATION_SELF_URL ?? raw.selfUrl
    ),
    nodes: raw.nodes ?? [],
    pollIntervalMs: raw.pollIntervalMs ?? 15000,
    selfUrl: process.env.FEDERATION_SELF_URL ?? raw.selfUrl,
    seedPeers: raw.seedPeers ?? [],
    announceIntervalMs: raw.announceIntervalMs ?? 300_000,
    // Absolute path to the vanilla Claude CLI on this node (issue #933).
    // Falls back to auto-detection if not set.
    claudePath: raw.claudePath,
    // Issue #6123: omitted when unset or invalid (see above).
    ...(webUrl ? { webUrl } : {}),
    // Issue #6483: omitted when unset or invalid (see above).
    ...(turnMirrorDisabled !== undefined ? { turnMirrorDisabled } : {}),
  };

  return FederationConfigSchema.parse(merged);
}

/**
 * Get the federation API token from settings or environment.
 * Used for authenticating inter-node requests.
 */
export function getFederationApiToken(settings: Settings): string | null {
  return (
    process.env.FEDERATION_API_TOKEN ?? settings.federation?.apiToken ?? null
  );
}
