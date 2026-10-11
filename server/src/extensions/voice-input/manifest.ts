// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.voice-input` — dictation into the composer with a free on-node
 * speech engine (NVIDIA Parakeet via sherpa-onnx), issue #4707 / epic #4706.
 *
 * Server-only: the mic button and the Settings section are core web UI that
 * hide themselves when `/api/voice/status` is absent (this extension disabled).
 * Default-enabled but inert until the user installs the engine from Settings;
 * not requiredAtBuild, so it stays disableable via extension_prefs.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.voice-input",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Voice Input",
  description:
    "Dictate into the prompt box with a free on-node speech engine (NVIDIA Parakeet via sherpa-onnx).",
  defaultEnabled: true,
  capabilities: ["catalog.contribute"],
  entryPoints: {
    server: async () => import("./server"),
  },
};
