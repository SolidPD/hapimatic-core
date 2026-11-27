// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detect which CLI agents are available on this node.
 * Uses Bun.which() for PATH-based detection — no process spawn needed.
 * Result is cached on first call since agent availability doesn't change at runtime.
 *
 * The stock-4 agent LIST is sourced from the shared harness-manifest registry
 * (`KNOWN_AGENT_IDS`, issue #3118) rather than a local literal, keeping this
 * file in lockstep with cli/src/utils/agentCapabilities.ts by construction —
 * both read the same registry, so the emitted `agent:<name>` sets (and order)
 * cannot desync. Order preservation is load-bearing for federation
 * cross-validation.
 */

import { existsSync, readFileSync } from "node:fs";
import {
  ANTHROPIC_LOGIN_CAPABILITY,
  API_KEY_CREDIT_REPORT_CAPABILITY,
  INTERVAL_FEED_CAPABILITY,
  SESSION_API_KEY_SWITCH_CAPABILITY,
  SHARED_API_KEYS_CAPABILITY,
  MCP_SET_CAPABILITY,
  KNOWN_AGENT_IDS,
  resolveToolCapabilities,
} from "@hapi/protocol";
import { configuration } from "../configuration";
import { ACCOUNT_LEASE_COORDINATOR_CAPABILITY } from "../services/rotationLeaseService";
import {
  billableSwitchCapabilityTags,
  type BillableSwitchGateState,
} from "../config/billableSwitchConfig";
import type { BillableSwitchMode } from "@hapi/protocol";
import {
  billingCategoriesCapabilityTags,
  type BillingCategoriesOwnerState,
} from "../config/billingCategoriesConfig";

let cachedBaseCapabilities: string[] | null = null;

/** Default PATH probe for tool-capability detection (issue #3458). `Bun.which`
 * resolves against the SERVICE process PATH — a systemd unit's restricted PATH,
 * not an interactive shell's. */
const defaultToolProbe = (bin: string): boolean =>
  typeof Bun !== "undefined" && Boolean(Bun.which(bin));

/**
 * Injectable PATH probe (issue #3458). Production default = {@link defaultToolProbe}.
 * The unit suite runs on RP1, where `kicad-cli`/`freecad` ARE on PATH, so a
 * real-PATH `tool:*` assertion would be host-dependent — tests inject a stub via
 * {@link _setToolProbeForTests} instead.
 */
let toolProbe: (bin: string) => boolean = defaultToolProbe;

/** Test seam: override the tool PATH probe (null → restore the Bun.which default). */
export function _setToolProbeForTests(
  probe: ((bin: string) => boolean) | null
): void {
  toolProbe = probe ?? defaultToolProbe;
}

/** Test seam: clear the cached base set so the next detectCapabilities() re-probes. */
export function _resetCapabilitiesCacheForTests(): void {
  cachedBaseCapabilities = null;
}

/**
 * Issue #1733/#1975: augment agent capabilities with `gateway:openrouter` when
 * a gateway-capable agent (codex OR opencode) is available AND an OpenRouter key
 * is configured. Pure (no I/O) — unit-tested directly. Kept in lockstep with
 * cli/src/utils/agentCapabilities.ts.
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

/**
 * Issue #1733: synchronous read of this node's openRouterApiKey from the shared
 * $HAPI_HOME/settings.json (the same file the CLI writes). Fail-safe: any error
 * (uninitialized configuration, missing/corrupt file) → false, so a node never
 * falsely advertises the gateway capability.
 */
function isOpenRouterKeyConfigured(): boolean {
  try {
    const file = configuration.settingsFile;
    if (!file || !existsSync(file)) return false;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      openRouterApiKey?: string;
    };
    return Boolean(parsed.openRouterApiKey && parsed.openRouterApiKey.trim());
  } catch {
    return false;
  }
}

/**
 * Issue #3458: synchronous read of this node's `toolCapabilities` override from
 * the shared $HAPI_HOME/settings.json (the same file the CLI writes). Fail-safe:
 * any error (uninitialized configuration, missing/corrupt file) → an empty
 * override, so a node never falsely advertises a tool it doesn't have. Like
 * isOpenRouterKeyConfigured, its result is cached with the base set — so the
 * first detectCapabilities() call must follow configuration init (true for the
 * peerAnnouncer.ts / infrastructure.ts callers today). Allowlist-only vocabulary
 * (A-D11) is enforced by resolveToolCapabilities, not here.
 */
function readToolOverride(): { add: string[]; suppress: string[] } {
  try {
    const file = configuration.settingsFile;
    if (!file || !existsSync(file)) return { add: [], suppress: [] };
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      toolCapabilities?: { add?: string[]; suppress?: string[] };
    };
    return {
      add: parsed.toolCapabilities?.add ?? [],
      suppress: parsed.toolCapabilities?.suppress ?? [],
    };
  } catch {
    return { add: [], suppress: [] };
  }
}

/**
 * Issue #6646: this process's effective billable-sessions gate, set ONCE at boot
 * by `server/src/index.ts`. A caller that passes `billableSwitch` uses its own
 * value (tests); every other caller (`/federation/info`, the peer announcement,
 * the catalog's availability context) advertises the process's tags.
 */
let processBillableSwitchGate:
  | Pick<BillableSwitchGateState, "mode" | "storageReady">
  | undefined;

export function setProcessBillableSwitchGate(
  state: Pick<BillableSwitchGateState, "mode" | "storageReady"> | undefined
): void {
  processBillableSwitchGate = state;
}

/**
 * Issue #6779: this process's billing-category owner state, set ONCE at boot by
 * `server/src/index.ts` right after the federation config is loaded, before the
 * announcer starts. The owner tag is appended per call beside the billable
 * ones; `buildWebApp.ts` reads the same state to build the category service.
 */
export type ProcessBillingCategoriesState = {
  ownerState: BillingCategoriesOwnerState;
  owner: boolean;
  storageReady: boolean;
  mode: BillableSwitchMode;
};

let processBillingCategoriesState: ProcessBillingCategoriesState | undefined;

export function setProcessBillingCategoriesState(
  state: ProcessBillingCategoriesState | undefined
): void {
  processBillingCategoriesState = state;
}

export function getProcessBillingCategoriesState():
  | ProcessBillingCategoriesState
  | undefined {
  return processBillingCategoriesState;
}

/**
 * Detect available capabilities for this node.
 * Includes base capabilities plus agent-specific ones.
 * Agent capabilities use the `agent:` prefix (e.g., `agent:claude`).
 *
 * Role-specific capabilities (issue #1644: the hub advertises
 * `account-lease-coordinator` so peers can discover the authoritative
 * rotation-lease ledger) are appended per-call and NOT cached — only the
 * expensive agent-detection (`Bun.which`) result is cached, so the role variant
 * never gets cached over the base set.
 */
export function detectCapabilities(opts?: {
  role?: "hub" | "node" | "peer";
  /**
   * Issue #6646: this node's effective billable-sessions gate. Its tags are
   * appended per call after the role tag, never cached with the base set.
   */
  billableSwitch?: Pick<BillableSwitchGateState, "mode" | "storageReady">;
  /** Issue #6779: the owner state; its tag is appended beside the billable ones. */
  billingCategories?: ProcessBillingCategoriesState;
}): string[] {
  if (!cachedBaseCapabilities) {
    // #4462: ANTHROPIC_LOGIN_CAPABILITY is static (every binary since #4462 ships
    // the receivers), so it is cached with the base set and precedes agent:*.
    // #5127: SHARED_API_KEYS_CAPABILITY is static too — every binary since
    // #5127 ships the shared-key receivers and /federation/spawn-api-key.
    const capabilities = [
      "read-sessions",
      "spawn-session",
      ANTHROPIC_LOGIN_CAPABILITY,
      SHARED_API_KEYS_CAPABILITY,
      // Issue #6740: static too — this binary's session-account receiver takes a
      // key by qualified reference. An older owner answers it with a 400.
      SESSION_API_KEY_SWITCH_CAPABILITY,
      // Issue #6978: static too — this binary serves the out-of-credit report
      // receiver. A requester skips a home without it, so the key stays unstamped.
      API_KEY_CREDIT_REPORT_CAPABILITY,
      // Issue #6171: static too — this binary honors `mcpSet` on a spawn and serves
      // the MCP catalog. An older peer would strip the field and start every server.
      MCP_SET_CAPABILITY,
      // Issue #6586: static in every billable mode — this binary serves the
      // interval feed, and a node in `off` still serves its closed rows.
      INTERVAL_FEED_CAPABILITY,
    ];

    for (const agent of KNOWN_AGENT_IDS) {
      // Bun.which returns the full path if found, null if not
      if (typeof Bun !== "undefined" && Bun.which(agent)) {
        capabilities.push(`agent:${agent}`);
      }
    }

    // Issue #1733: gateway:openrouter iff codex + key (cached with the base set
    // — a key added after server start won't advertise until restart).
    const withGateway = withGatewayCapabilities(
      capabilities,
      isOpenRouterKeyConfigured()
    );

    // Issue #3458: append node hardware-toolchain tags (tool:<name>) AFTER the
    // agent:* / gateway:* tags and BEFORE the per-call role tag, so the cached
    // order is: read-sessions, spawn-session, agent:*, gateway:openrouter, tool:*.
    // Cached with the base set — a tool that appears after server start won't
    // advertise until restart. Absent-means-unknown (R4) is automatic: an empty
    // resolved set appends nothing. Order is allowlist-ordered (R2/R6).
    cachedBaseCapabilities = [
      ...withGateway,
      ...resolveToolCapabilities({
        isOnPath: toolProbe,
        ...readToolOverride(),
      }),
    ];
  }

  const result = [...cachedBaseCapabilities];
  if (opts?.role === "hub") {
    result.push(ACCOUNT_LEASE_COORDINATOR_CAPABILITY);
  }
  result.push(
    ...billableSwitchCapabilityTags(
      opts?.billableSwitch ?? processBillableSwitchGate
    )
  );
  result.push(
    ...billingCategoriesCapabilityTags(
      opts?.billingCategories ?? processBillingCategoriesState
    )
  );
  return result;
}

/**
 * Extract supported agent names from a capabilities array.
 * Filters for `agent:*` prefixed entries and returns the agent names.
 */
export function extractAgentCapabilities(capabilities: string[]): string[] {
  return capabilities
    .filter(c => c.startsWith("agent:"))
    .map(c => c.slice("agent:".length));
}
