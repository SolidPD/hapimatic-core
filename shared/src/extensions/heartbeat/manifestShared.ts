// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared static metadata for the `builtin.heartbeat` extension (issue #1275,
 * Sub-Issue K of epic #1264).
 *
 * Heartbeat ships as TWO per-package extension directories that share a single
 * logical id:
 *
 *   - `server/src/extensions/heartbeat/` — declares only `entryPoints.server`
 *   - `web/src/extensions/heartbeat/`    — declares only `entryPoints.web`
 *
 * F's codegen (`scripts/generate-extension-registry.ts`) filters each entry by
 * `manifest.entryPoints[runtime]`, so the server directory lands ONLY in
 * `server/src/extensions.generated.ts` and the web directory ONLY in
 * `web/src/extensions.generated.ts`. Neither loader ever sees both, so the
 * shared id is not a duplicate-registration hazard — and keeping the trees
 * separate means the web bundle never imports server code.
 *
 * Both manifests spread this constant so the static fields (`id`, `version`,
 * `defaultEnabled`, …) cannot drift apart. They collide intentionally on the
 * single `extension_prefs` row keyed by `builtin.heartbeat`, so enabling or
 * disabling the extension toggles BOTH halves in lockstep. Mirrors
 * `SCHEDULER_EXT_META` (#1274).
 */
import { PLUGIN_API_VERSION } from "../../ext/version";

export const HEARTBEAT_EXT_META = {
  id: "builtin.heartbeat",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Heartbeat",
  description:
    "Periodic autonomous check-in loop: drains system events into a heartbeat prompt, manages the heartbeat session, and runs on a configurable cadence within active hours.",
  // `true` preserves pre-migration behavior — heartbeat keeps working for users
  // who never opted into the extension system.
  defaultEnabled: true,
  // Heartbeat is NOT a build-time requirement: no core module calls
  // HeartbeatService (core resolves it lazily via the services registry), so an
  // explicit `false` in extension_prefs may legitimately disable it.
  requiredAtBuild: false,
} as const;
