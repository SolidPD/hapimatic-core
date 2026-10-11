// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared static metadata for the `builtin.git-rpc` extension (issue #1281,
 * Sub-Issue Q of epic #1264).
 *
 * `builtin.git-rpc` ships as TWO per-package extension directories that share a
 * single logical id:
 *
 *   - `server/src/extensions/git-rpc/` — declares only `entryPoints.server`
 *     (the 6 Git RPC + file-browser routes, mounted via `host.routes.add`)
 *   - `web/src/extensions/git-rpc/`    — declares only `entryPoints.web`
 *     (the file-browser route components + hooks)
 *
 * F's codegen (`scripts/generate-extension-registry.ts`) filters each entry by
 * `manifest.entryPoints[runtime]`, so the server directory lands ONLY in
 * `server/src/extensions.generated.ts` and the web directory ONLY in
 * `web/src/extensions.generated.ts`. Neither loader ever sees both, so the
 * shared id is not a duplicate-registration hazard — and keeping the trees
 * separate means the web bundle never imports server code.
 *
 * Both manifests spread this constant so the static fields (`id`, `version`,
 * `defaultEnabled`, `requiredAtBuild`, …) cannot drift apart. They collide
 * intentionally on the single `extension_prefs` row keyed by `builtin.git-rpc`,
 * so enabling or disabling the extension toggles BOTH halves in lockstep.
 *
 * `requiredAtBuild: true` (modeled on `builtin.notifications-push`): the web
 * file-browser routes are statically imported by `router.tsx` regardless of
 * enable-state (the v0.1 `navigation.addRoute` API is unwired), so disabling the
 * extension would leave the file-browser UI present but its server endpoints
 * returning 404 — an inconsistent state. `requiredAtBuild` short-circuits the
 * loader's enable check, guaranteeing both halves always load.
 */
import { PLUGIN_API_VERSION } from "../../ext/version";

export const GIT_RPC_EXT_META = {
  id: "builtin.git-rpc",
  version: "1.0.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Git RPC & File Browser",
  description:
    "Git status/diff RPC endpoints and the session file browser (server routes + web routes).",
  // `true` preserves pre-migration behavior — the file browser + git status
  // keep working for users who never opted into the extension system.
  defaultEnabled: true,
  // Foundational: the web routes are static-imported regardless of enable-state,
  // so the server endpoints must never be absent. See the file docstring.
  requiredAtBuild: true,
} as const;
