// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.watchdog` — external stall detection for Claude Code sessions
 * (issue #1276, Sub-Issue L of epic #1264).
 *
 * A server-only extension: it registers `StallWatchdogService` on the host's
 * lifecycle hooks (`onStartup`/`onShutdown`) and mounts the `/api/watchdog/*`
 * routes via `host.routes.add`.
 *
 * `defaultEnabled: true` preserves the pre-migration always-on behaviour — the
 * service was constructed unconditionally in `server/src/index.ts`, and its own
 * `config.enabled` gate (settings.json `stallWatchdog.enabled`) still controls
 * whether the poll loop actually runs.
 *
 * NOT `requiredAtBuild`: unlike `builtin.notifications-push` (the notification
 * floor that several core services hard-depend on), nothing depends on the
 * watchdog being present, so it stays disableable via `extension_prefs`.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.watchdog",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Stall Watchdog",
  description:
    "External stall detection for Claude Code sessions (dual-signal: persistent thinking + unchanged seq).",
  defaultEnabled: true,
  // #3752: declares catalog.contribute — this builtin contributes capability-catalog
  // entries (its routes are cataloged()). Inert for trusted build-composed extensions
  // (the gate bypasses them); the explicit marker AC2/V2 require.
  capabilities: ["catalog.contribute"],
  entryPoints: {
    server: async () => import("./server"),
  },
};
