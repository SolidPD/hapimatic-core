// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.agent-gemini` — Google Gemini as a Hapimatic agent backend, over
 * the ACP protocol (issue #1273, Sub-Issue I of epic #1264).
 *
 * `defaultEnabled: true`: Gemini is treated as a first-class agent across the
 * codebase (web UI agent selector, federation capability detection, slash-command
 * metadata, RPC type unions, `TerminalManager` env passthrough, and the daemon
 * spawn path). Users without the `gemini` binary on PATH are already gated out
 * by capability detection (`cli/src/utils/agentCapabilities.ts`, which uses
 * `Bun.which("gemini")`), so enabling by default cannot surface a broken option.
 *
 * `requiredAtBuild: false`: unlike the notification-channel floor, no core
 * service calls into Gemini, so the extension is safely removable.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.agent-gemini",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Gemini Agent",
  description:
    "Run Google Gemini as a Hapimatic agent backend via the ACP protocol (requires the gemini CLI on PATH).",
  defaultEnabled: true,
  requiredAtBuild: false,
  entryPoints: {
    cli: async () => import("./cli"),
  },
};
