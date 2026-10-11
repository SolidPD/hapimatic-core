// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CatalogHarnessManifest,
  HarnessDriverBinding,
  HarnessInstallRecipe,
} from "@hapi/protocol";
import { removeLocalBin } from "@/ext/harnessInstall";

/** OPEN catalog harness id (KD5) — distinct from the extension id `catalog.harness-cursor`. */
export const harnessId = "cursor";

/**
 * Cursor CLI install recipe (curl channel). Cursor CLI's official installer is `curl … | bash`,
 * which ruling 1B-17 forbids — so this recipe pins the DIRECT release artifact with a REAL
 * verified sha256 (linux/arm64, the deploy target; downloaded + hashed 2026-08-24). NOTE
 * (OR2 follow-up): the artifact is a multi-file, arch-specific package tarball, so automated
 * unpacking/placement is deferred (see `executeRecipeInstall`); the integrity gate (V7) is
 * genuine regardless. The pinned URL is arch-locked — an x64/macOS host needs a per-arch recipe.
 */
export const recipe: HarnessInstallRecipe = {
  method: "curl",
  spec: "https://downloads.cursor.com/lab/2026.08.11-e8db854/linux/arm64/agent-cli-package.tar.gz",
  pinnedVersion: "2026.08.11-e8db854",
  sha256: "ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed",
  license: "proprietary",
  versionProbe: ctx =>
    ctx.registry.probe({
      cmd: "cursor-agent --version",
      versionRegex: "([0-9]{4}\\.[0-9]{2}\\.[0-9]{2}[^\\s]*)",
    }),
  uninstall: async () => {
    removeLocalBin("cursor-agent");
  },
};

/**
 * HAL capability manifest for Cursor CLI (id-open `agentId`, KD5). Best-effort; refined by #3122.
 */
export const capabilityManifest: CatalogHarnessManifest = {
  agentId: "cursor",
  verifiedAgainst: "cursor 2026.08.11-e8db854",
  skills: { mode: "none" },
  hooks: { mode: "plugin-shim" },
  mcp: { configFormatId: "cursor-mcp-json" },
  instructionFile: {
    name: "AGENTS.md",
    placement: "root",
    semantics: "AGENTS.md",
  },
  acp: { server: "native", client: "absent" },
  headlessExec: { modes: ["print"], outputFormats: ["json", "text"] },
  subagents: "native",
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

export const driverBinding: HarnessDriverBinding = "acp-generic";
