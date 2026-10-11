// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.agent-codex` — the Codex agent (issue #1272, Sub-Issue H of epic
 * #1264).
 *
 * Owns the `hapi codex` subcommand and the whole Codex session tree
 * (`./codex/**` — loop, session, launchers, MCP bridge, event converters),
 * relocated here verbatim from `cli/src/codex/`.
 *
 * `defaultEnabled: true` (AC#4 — Codex stays on out of the box) and
 * deliberately NOT `requiredAtBuild`: that flag short-circuits the loader's
 * enable check, which would make the extension permanently un-disableable and
 * contradict AC#5 ("disabling the extension cleanly removes the codex
 * subcommand"). Contrast `builtin.notifications-push`, which IS
 * `requiredAtBuild` because core services call `PushService` directly.
 *
 * CLI-only: Codex contributes no server routes and no web UI, so per the
 * codegen's per-runtime filter (#1270 R8) this manifest appears only in
 * `cli/src/extensions.generated.ts`.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.agent-codex",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Codex Agent",
  description:
    "Codex AI agent backend — provides the 'hapi codex' subcommand and Codex session loop.",
  defaultEnabled: true,
  entryPoints: {
    cli: async () => import("./cli"),
  },
};
