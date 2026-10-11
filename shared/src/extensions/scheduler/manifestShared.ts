// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared static metadata for the `builtin.scheduler` extension (issue #1274,
 * Sub-Issue J of epic #1264).
 *
 * The scheduler ships as TWO per-package extension directories that share a
 * single logical id:
 *
 *   - `server/src/extensions/scheduler/` — declares only `entryPoints.server`
 *   - `web/src/extensions/scheduler/`    — declares only `entryPoints.web`
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
 * single `extension_prefs` row keyed by `builtin.scheduler`, so enabling or
 * disabling the extension toggles BOTH halves in lockstep.
 */
import { PLUGIN_API_VERSION } from "../../ext/version";

export const SCHEDULER_EXT_META = {
  id: "builtin.scheduler",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Scheduler",
  description:
    "Scheduled task execution engine: 5-layer temporal scheduling, cron/at/every kinds, session spawning, execution history.",
  // `true` preserves pre-migration behavior — scheduling keeps working for
  // users who never opted into the extension system.
  defaultEnabled: true,
  // The scheduler is NOT a build-time requirement: unlike `notifications-push`
  // (the notification floor that core services call directly), no core module
  // calls SchedulerService, so an explicit `false` in extension_prefs may
  // legitimately disable it.
  requiredAtBuild: false,
} as const;
