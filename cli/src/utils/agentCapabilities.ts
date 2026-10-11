// SPDX-License-Identifier: MIT
/**
 * Local-machine agent capability detection (issue #1081).
 *
 * Detects which agent CLIs are installed on this host via Bun.which() — a PATH
 * lookup with no subprocess spawn. The daemon stamps the result onto
 * MachineMetadata.capabilities so the web UI can disable agent options whose
 * binary is absent (avoiding webhook-timeout spawn failures).
 *
 * The stock-4 agent LIST is sourced from the shared harness-manifest registry
 * (`KNOWN_AGENT_IDS`, issue #3118) rather than a local literal, so this file
 * carries no orphaned hardcoded capability facts — it stays in lockstep with
 * server/src/federation/capabilityDetector.ts by construction (both read the
 * same registry). The emitted `agent:<name>` order matches the registry's
 * insertion order (claude, codex, gemini, opencode) — federation cross-validation
 * depends on that order.
 *
 * Mirrors the semantics of server/src/federation/capabilityDetector.ts so
 * agent-availability strings cross-validate (federation `agent:<name>` capability
 * has the same meaning whether it came from the server's announcement payload
 * or a local machine's metadata record). Beyond agents, it also emits
 * `tool:<name>` hardware-toolchain tags (issue #3458) for the allowlisted CLIs on
 * this node's PATH (via the shared `resolveToolCapabilities` resolver) so PCB /
 * hardware work can be routed to a capable node. It does NOT emit the base
 * capabilities (`read-sessions` / `spawn-session`) the federation-side helper adds
 * — those don't apply to per-machine records.
 *
 * Cached on first call: agent + tool availability does not change at daemon runtime.
 */

import { KNOWN_AGENT_IDS, resolveToolCapabilities } from "@hapi/protocol";
import { readSettingsSync } from "@/persistence";

let cachedCapabilities: string[] | null = null;

/**
 * Issue #1733/#1975: augment agent capabilities with `gateway:openrouter` when
 * a gateway-capable agent (codex OR opencode) is available AND an OpenRouter key
 * is configured on this node. Pure (no I/O) so the contract is unit-testable
 * without Bun.which/settings I/O. Kept in lockstep with
 * server/src/federation/capabilityDetector.ts.
 */
export function withGatewayCapabilities(
  agentCapabilities: string[],
  openRouterKeyConfigured: boolean
): string[] {
  const hasGatewayAgent =
    agentCapabilities.includes("agent:codex") ||
    agentCapabilities.includes("agent:opencode");
  if (hasGatewayAgent && openRouterKeyConfigured) {
    return [...agentCapabilities, "gateway:openrouter"];
  }
  return agentCapabilities;
}

export function detectAgentCapabilities(): string[] {
  if (cachedCapabilities) return cachedCapabilities;

  const capabilities: string[] = [];
  for (const agent of KNOWN_AGENT_IDS) {
    if (typeof Bun !== "undefined" && Bun.which(agent)) {
      capabilities.push(`agent:${agent}`);
    }
  }

  // Issue #1733: gateway:openrouter iff codex + key (cached with the agent set).
  const settings = readSettingsSync();
  const keyConfigured = Boolean(settings.openRouterApiKey?.trim());
  // Issue #3458: append node hardware-toolchain tags (tool:<name>) after the
  // agent:* / gateway:* tags. The resolver is defined ONCE in @hapi/protocol
  // (beside KNOWN_AGENT_IDS) and imported by both twins, so this file cannot
  // desync from server/src/federation/capabilityDetector.ts (R1). Probing happens
  // in this same single cached pass (R2). A settings.json `toolCapabilities`
  // override adds off-PATH tools (e.g. the kipy venv client) or suppresses one.
  cachedCapabilities = [
    ...withGatewayCapabilities(capabilities, keyConfigured),
    ...resolveToolCapabilities({
      isOnPath: bin => typeof Bun !== "undefined" && Boolean(Bun.which(bin)),
      ...(settings.toolCapabilities ?? {}),
    }),
  ];
  return cachedCapabilities;
}

/**
 * Reset the cache. Exported for tests only — daemon-runtime callers should
 * not need this (agent availability is stable across the daemon's lifetime).
 */
export function _resetAgentCapabilitiesCache(): void {
  cachedCapabilities = null;
}
