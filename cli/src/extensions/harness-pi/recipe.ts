// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogHarnessManifest,
  HarnessDriverBinding,
  HarnessInstallRecipe,
} from "@hapi/protocol";
import { npmUninstallGlobal } from "@/ext/harnessInstall";

/** OPEN catalog harness id (KD5) — distinct from the extension id `catalog.harness-pi`. */
export const harnessId = "pi";

/**
 * Pi install recipe (npm channel, verified against npm 2026).
 * `--ignore-scripts` is applied at install time (ruling 1B-17); npm's registry integrity
 * covers the artifact, so no `sha256` is needed for an npm recipe.
 */
export const recipe: HarnessInstallRecipe = {
  method: "npm",
  spec: "@earendil-works/pi-coding-agent@0.84.2",
  pinnedVersion: "0.84.2",
  license: "MIT",
  versionProbe: ctx =>
    ctx.registry.probe({
      cmd: "pi --version",
      versionRegex: "(\\d+\\.\\d+\\.\\d+)",
    }),
  uninstall: () => npmUninstallGlobal("@earendil-works/pi-coding-agent"),
};

/**
 * HAL capability manifest for Pi (id-open `agentId`, KD5 — NOT an `AgentFlavor`).
 * Best-effort capability declaration verified against the pinned version; the exact axis
 * tri-states are refined by the projection compiler (#3122).
 */
export const capabilityManifest: CatalogHarnessManifest = {
  agentId: "pi",
  verifiedAgainst: "pi >=0.84.2",
  skills: { mode: "injected" },
  hooks: { mode: "none" },
  mcp: { configFormatId: "pi-mcp" },
  instructionFile: {
    name: "AGENTS.md",
    placement: "root",
    semantics: "AGENTS.md",
  },
  acp: { server: "absent", client: "absent" },
  headlessExec: { modes: ["print"], outputFormats: ["text"] },
  subagents: "absent",
  sessionPersistence: { tmuxSafe: true },
  sessionRoles: "absent",
  outputStyles: "absent",
  sandboxing: "absent",
  // Ruling D5 honest degrade defaults — Hapimatic surfaces no model-selection,
  // permission-mode, or usage-reporting integration for a tier-2 catalog harness,
  // and delivers it no credential (it inherits host auth). No per-harness feature
  // work; the projection compiler (#3122) refines the tri-states.
  modelSelection: { catalogSources: [], switchSemantics: "relaunch" },
  permissionModes: { modes: [] },
  usageReporting: {
    mode: "absent",
    granularity: "none",
    cacheSplit: false,
    contextWindow: false,
  },
  authBinding: { kinds: ["inherited"] },
  // #3748 Sub H: tier-2 harness — Tier-0 has no wired carrier (only the stock-4
  // get one); "none" with a waiver is the honest state until one exists.
  capabilityInjection: {
    mode: "none",
    waiver:
      "tier-2 harness — no Tier-0 carrier wired (#3748 wires only stock-4)",
  },
};

export const driverBinding: HarnessDriverBinding = "headless-tmux-generic";
