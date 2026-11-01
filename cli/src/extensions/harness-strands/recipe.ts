// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogHarnessManifest,
  HarnessDriverBinding,
  HarnessInstallRecipe,
} from "@hapi/protocol";
import type { AcpConfigSource } from "@/agent/backends/acp";
import { npmUninstallGlobal } from "@/ext/harnessInstall";

/** OPEN catalog harness id (KD5) — distinct from the extension id `catalog.harness-strands`. */
export const harnessId = "strands";

/**
 * Strands Agents CLI install recipe (npm channel, verified against npm 2026-10-30).
 * `--ignore-scripts` is applied at install time (ruling 1B-17); the package has no
 * install/postinstall script, so `allowScripts` stays unset. Integrity is npm's own:
 * the exact spec fails an absent version (ETARGET) and npm enforces the registry
 * `dist.integrity` on install (EINTEGRITY) — for 0.2.3 that is
 * `sha512-thisqmAcTaSv2Cf4cnSl6UnEC9ZvOVoN4VyZ7MlRLjZbxOr7Vo3u0HG1+ArQB5yl+Dj5+wVPxTZKYghVqbhRgQ==`.
 * No `sha256` is needed for an npm recipe. Requires Node >= 22 (`engines.node`).
 */
export const recipe: HarnessInstallRecipe = {
  method: "npm",
  spec: "@strands-agents/cli@0.2.3",
  pinnedVersion: "0.2.3",
  license: "Apache-2.0",
  versionProbe: ctx =>
    ctx.registry.probe({
      cmd: "strands --version",
      versionRegex: "(\\d+\\.\\d+\\.\\d+)",
    }),
  uninstall: () => npmUninstallGlobal("@strands-agents/cli"),
};

/**
 * HAL capability manifest for the Strands Agents CLI (id-open `agentId`, KD5 — NOT an
 * `AgentFlavor`). Every axis is verified against the pinned 0.2.3 (issue #5927).
 */
export const capabilityManifest: CatalogHarnessManifest = {
  agentId: "strands",
  verifiedAgainst: "strands >=0.2.3",
  // The profile's skills directory defaults to `./.agent/skills` (README "Agent Skills").
  skills: { mode: "native-dir", discoveryPath: "./.agent/skills" },
  hooks: { mode: "none" },
  // Reads the same `{ "mcpServers": {…} }` container as Claude Code.
  mcp: { configFormatId: "mcpServers" },
  instructionFile: {
    name: "AGENTS.md",
    placement: "root",
    semantics: "AGENTS.md",
  },
  acp: { server: "native", client: "absent" },
  headlessExec: { modes: ["print"], outputFormats: ["text"] },
  subagents: "native",
  sessionPersistence: { tmuxSafe: true },
  sessionRoles: "absent",
  outputStyles: "absent",
  // README: "This approval layer is not an operating-system sandbox".
  sandboxing: "absent",
  // No ACP model setter; `--model` is per launch. The catalogId enum has no Strands
  // entry, so the ruling D5 honest default applies.
  modelSelection: { catalogSources: [], switchSemantics: "relaunch" },
  // The 0.2.3 ACP server never sends `session/request_permission`: shell, file and
  // MCP tools run ungated in the host process. There are no modes to map.
  permissionModes: { modes: [] },
  // Declared, not consumed: no Hapimatic session can host a catalog harness until
  // #5939 (catalog-harness session hosting) lands.
  usageReporting: {
    mode: "native",
    granularity: "per-turn",
    cacheSplit: true,
    contextWindow: true,
    note: "strands-cli 0.2.3 ACP: per-turn usage on the session/prompt response (inputTokens/outputTokens/cachedReadTokens/cachedWriteTokens, tui/acp/projection.js toAcpUsage); context via session/update usage_update {used,size}.",
  },
  // Hapimatic delivers no credential yet; #5939 adds vault delivery (ruling D2(a)).
  authBinding: { kinds: ["inherited"] },
  // #3748 Sub H: tier-2 harness — Tier-0 has no wired carrier (only the stock-4
  // get one); "none" with a waiver is the honest state until one exists.
  capabilityInjection: {
    mode: "none",
    waiver:
      "tier-2 harness — no Tier-0 carrier wired (#3748 wires only stock-4)",
  },
};

export const driverBinding: HarnessDriverBinding = "acp-generic";

/**
 * ACP config source for `strands --acp-server`. No `clientCapabilities` (Strands uses
 * its own tools, not client fs/terminal) and no `quirks` (its `initialize` response
 * carries no `authMethods`). Consumed by #5939 (catalog-harness session hosting); until
 * then only the catalog test reads it. ACP mode writes `./.agent/sessions` into the
 * working directory, so the hosting path should pass `--set 'session.dir=…'` (outside
 * the repo) or `--session off`.
 */
export const acpConfigSource: AcpConfigSource = {
  command: "strands",
  args: ["--acp-server"],
};
