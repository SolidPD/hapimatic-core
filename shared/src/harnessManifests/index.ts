// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Harness manifest registry (issue #3118, epic #3117 Sub-Issue C keystone).
 *
 * Resolves a HARNESS capability manifest by canonical stock-4 agent id
 * (`AgentFlavor`). Two entry points (R4): {@link resolveHarnessManifest} throws
 * a typed error on an unknown id (strict callers — never a silent
 * empty/undefined result), and {@link tryResolveHarnessManifest} returns
 * `undefined` for fallback-preserving callers (#3126 spawn-path gates,
 * #3120 catalog probes).
 *
 * TWO-TIER HARNESS IDENTITY (expert ruling D8b / KD5). This registry is CLOSED
 * over the stock-4 `AgentFlavor`: the `Record<AgentFlavor, HarnessManifest>`
 * totality is exactly what keeps the stock-4 spawn paths throw-free
 * (compile-time exhaustiveness), which #3126's gate logic relies on. Do NOT
 * widen `AgentFlavor` or this record. CATALOG CLIs (#3120's installable set)
 * supply manifests through the extension contribution surface instead
 * (`AgentBackend.id: string`, `shared/src/ext/contributions.ts`) and resolve via
 * a SEPARATE `resolveCatalogManifest(id: string): HarnessManifest | undefined`
 * that #3120 builds — NOT here. Keeping the two resolution paths separate is
 * what stops the closed stock-4 identity and the open catalog identity from
 * drifting into one another.
 *
 * Lives in `shared/` (expert ruling D1a / epic CG-1) because the consumers span
 * every package — cli (`agentCapabilities.ts`, #3126/#3132 gates), server
 * (`capabilityDetector.ts`, #3121 route, #3128 scorecard), and web via the
 * #3121 API — and the server package's ONLY workspace dependency is
 * `@hapi/protocol`; a cli-placed registry would have no server import path
 * (`server/src/services/accountService.ts` documents that constraint verbatim).
 */
import type { AgentFlavor } from "../modes";
import type { HarnessManifest } from "../harnessManifest";
import { resolveHostJailAxis } from "../harnessManifest";
import { claudeManifest } from "./claude-code";
import { codexManifest } from "./codex";
import { geminiManifest } from "./gemini";
import { opencodeManifest } from "./opencode";

/**
 * The stock-4 registry. Key ORDER is load-bearing: `Object.keys` follows
 * insertion order, and the capability emitters (`cli/src/utils/agentCapabilities.ts`
 * / `server/src/federation/capabilityDetector.ts`) preserve the emitted
 * `agent:<name>` ORDER for federation cross-validation — keep claude, codex,
 * gemini, opencode in the historical `KNOWN_AGENTS` order (OR2).
 */
export const HARNESS_MANIFESTS: Record<AgentFlavor, HarnessManifest> = {
  claude: claudeManifest,
  codex: codexManifest,
  gemini: geminiManifest,
  opencode: opencodeManifest,
};

/**
 * Ordered stock-4 agent ids (registry insertion order). The single source of
 * truth the capability emitters key on — replaces the duplicated `KNOWN_AGENTS`
 * literals that used to live independently in both mirror files (R6, "no
 * orphaned hardcoded capability facts").
 */
export const KNOWN_AGENT_IDS = Object.keys(HARNESS_MANIFESTS) as AgentFlavor[];

/**
 * Thrown by {@link resolveHarnessManifest} when asked for an id that is not one
 * of the stock-4 `AgentFlavor`s. Carries the offending `agentId` so callers can
 * message precisely. Modeled on `RegistryError` (`shared/src/ext/registry.ts`).
 */
export class UnknownHarnessError extends Error {
  readonly agentId: string;

  constructor(agentId: string) {
    super(
      `no harness manifest registered for agent id "${agentId}" ` +
        `(known stock-4 ids: ${KNOWN_AGENT_IDS.join(", ")})`
    );
    this.name = "UnknownHarnessError";
    this.agentId = agentId;
  }
}

/**
 * Resolve a stock-4 manifest by id, THROWING {@link UnknownHarnessError} on a
 * miss (never returns `undefined`). Use for strict callers that require a
 * manifest to exist. Because {@link HARNESS_MANIFESTS} is total over
 * `AgentFlavor`, a well-typed caller never hits the throw — it guards the
 * `id: string` boundary where a value was cast from an untyped source.
 */
export function resolveHarnessManifest(id: AgentFlavor): HarnessManifest {
  const manifest = HARNESS_MANIFESTS[id];
  if (!manifest) {
    throw new UnknownHarnessError(id);
  }
  return manifest;
}

/**
 * Non-throwing resolver for fallback-preserving callers — #3126's spawn-path
 * gates use `tryResolveHarnessManifest(id) ?? fallback`, and #3120's catalog
 * path probes an arbitrary `string` id. Accepts a bare `string` precisely
 * because the whole point is to safely probe an id that may NOT be a stock-4
 * `AgentFlavor`.
 */
export function tryResolveHarnessManifest(
  id: string
): HarnessManifest | undefined {
  return (HARNESS_MANIFESTS as Record<string, HarnessManifest>)[id];
}

/**
 * Issue #3813: the deduped, node-wide set of egress hosts the OmniBox broker must
 * ADDITIONALLY allow, aggregated from the `hostJail.egressHosts` of every STOCK
 * manifest that is BOTH `hostJail.mode === "native"` AND
 * `sessionPersistence.tmuxSafe === true` — i.e. the only flavors the bwrap jail
 * actually wraps today (`cli/src/daemon/harnessGates.ts`; claude + codex). Claude
 * adds none (its Anthropic hosts are already in `DEFAULT_EGRESS_ALLOWLIST`), so at
 * the pin this is EXACTLY codex's three hosts.
 *
 * The `tmuxSafe` gate keeps gemini's declared hosts (and any future
 * direct-spawn-only flavor's) OUT of the node-wide list until the direct-spawn
 * path is itself sandboxed — DROP the gate then. Order is registry-insertion then
 * per-manifest declaration order; deduped first-occurrence-wins.
 *
 * Consumed at the single broker-start call site (`cli/src/daemon/run.ts`), merged
 * into `resolveEgressAllowlist` exactly like the `HAPI_EGRESS_ALLOW` override
 * (extends, never replaces; `egressPolicy.ts` stays pure with no manifest import).
 */
export function harnessEgressHosts(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of KNOWN_AGENT_IDS) {
    const manifest = HARNESS_MANIFESTS[id];
    const axis = resolveHostJailAxis(manifest);
    if (axis.mode !== "native" || !manifest.sessionPersistence.tmuxSafe) {
      continue;
    }
    for (const host of axis.egressHosts) {
      if (!seen.has(host)) {
        seen.add(host);
        out.push(host);
      }
    }
  }
  return out;
}

/**
 * Node hardware-toolchain capability tags (issue #3458).
 *
 * A node advertises `tool:<bin>` for each allowlisted CLI on its PATH, so PCB /
 * hardware work — the rp1-home MS PCB Design Doctrine platform (epic #1441:
 * kicad-cli, FreeCAD, ngspice, simavr/Renode, …) — can be routed to a node that
 * actually has the toolchain. The allowlist lives HERE, beside {@link KNOWN_AGENT_IDS},
 * so the server detector (`server/src/federation/capabilityDetector.ts`) and its
 * CLI twin (`cli/src/utils/agentCapabilities.ts`) read ONE source and cannot
 * desync (R1). An ABSENT tag means *unknown*, never "toolchain absent" — older
 * nodes in a mixed-version fleet advertise no tool tags at all (R4).
 *
 * Order is load-bearing: like the `agent:<name>` set, `tool:<name>` tags are an
 * ORDERED federation cross-validation input. {@link resolveToolCapabilities}
 * always emits an allowlist-ordered sublist, and both twins APPEND it (never
 * interleave) after the `agent:*` / `gateway:*` tags (R2/R6).
 */
export const TOOL_CAPABILITY_ALLOWLIST = [
  "kicad-cli",
  "freecad",
  "kipy",
  "ngspice",
  "simavr",
  "renode",
] as const;

/** The `tool:` capability-tag prefix. Kept here so no usage site hard-codes a
 * bare `"tool:` literal (V1) — build tags with {@link toolTag}. */
export const TOOL_CAPABILITY_PREFIX = "tool:";

/** Build a `tool:<name>` capability tag. Both twins + the web machine-picker
 * marker call this so a bare `"tool:` literal never appears at a usage site. */
export function toolTag(name: string): string {
  return `${TOOL_CAPABILITY_PREFIX}${name}`;
}

/** The tag a node advertises when `kicad-cli` is present — the marker the web
 * machine picker keys on for the MS PCB Design Doctrine toolchain (R5). */
export const PCB_TOOLCHAIN_TAG = toolTag("kicad-cli");

/**
 * Resolve the ordered `tool:<name>` capability sublist for a node.
 *
 * A tool is present iff
 * `(isOnPath(tool) || add.includes(tool)) && !suppress.includes(tool)`.
 * Iterates {@link TOOL_CAPABILITY_ALLOWLIST} in order, so the output is always an
 * allowlist-ordered sublist (R2/R6). Names in `add`/`suppress` that are NOT
 * allowlisted are IGNORED (allowlist-only vocabulary — expert ruling A-D11: a
 * typo cannot mint a phantom tag the rp1-home `/spawn-peer-sessions` filter would
 * never match, and the federation order stays canonical). An empty input yields
 * `[]` (R4: nothing appended for a node with no toolchain).
 *
 * PURE by design: the PATH probe is an injected predicate, because this package
 * ships to the browser and has no runtime `Bun.*`. Both twins pass
 * `bin => typeof Bun !== "undefined" && Boolean(Bun.which(bin))`; the server test
 * suite injects a stub so its assertions are host-independent (the suite runs on
 * RP1, which HAS kicad-cli/freecad on PATH).
 */
export function resolveToolCapabilities(input: {
  isOnPath: (bin: string) => boolean;
  add?: readonly string[];
  suppress?: readonly string[];
}): string[] {
  const add = input.add ?? [];
  const suppress = input.suppress ?? [];
  const tags: string[] = [];
  for (const tool of TOOL_CAPABILITY_ALLOWLIST) {
    const present =
      (input.isOnPath(tool) || add.includes(tool)) && !suppress.includes(tool);
    if (present) {
      tags.push(toolTag(tool));
    }
  }
  return tags;
}
