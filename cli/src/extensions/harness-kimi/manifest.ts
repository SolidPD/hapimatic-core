// SPDX-License-Identifier: AGPL-3.0-only
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

/**
 * `catalog.harness-kimi` — Kimi Code as an installable HAL catalog CLI harness (epic
 * #3117 Sub-D / issue #3120).
 *
 * `defaultEnabled: true` registers the catalog CONTRIBUTION at load so the entry is
 * browsable + installable before the Kimi Code BINARY is present on the machine — the binary
 * installs lazily via the recipe (ruling D2; "lazy" is the binary, not the metadata). The
 * loader treats a build-composed extension as trusted, so `capabilities: ["harness"]` is
 * documentation here, but it is the correct declaration for the gated contribution point.
 */
export const manifest: HapiExtensionManifest = {
  id: "catalog.harness-kimi",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Kimi Code",
  description:
    "Moonshot AI's Kimi Code CLI (TypeScript, subagents, ACP for Zed/JetBrains, MCP).",
  defaultEnabled: true,
  requiredAtBuild: false,
  capabilities: ["harness"],
  entryPoints: {
    cli: async () => import("./cli"),
  },
};
