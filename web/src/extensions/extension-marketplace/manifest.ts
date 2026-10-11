// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.extension-marketplace` — web half (issue #1292, PR-2).
 *
 * Declares ONLY the `web` entry point; the server counterpart at
 * `server/src/extensions/extension-marketplace/manifest.ts` declares only `server`. Codegen filters
 * by runtime, so this directory lands solely in `web/src/extensions.generated.ts`.
 *
 * `requiredAtBuild: true` (mirrors `builtin.analytics` / `builtin.error-log-viewer`): the
 * `/extensions` browse route is statically imported by `router.tsx` — the v0.1 `navigation.addRoute`
 * API is declared but UNCONSUMED (TanStack Router infers valid paths from its static route tree at
 * module-eval, so a dynamically-registered route would leave the typed tree). Keeping the extension
 * always-enabled ensures its backing `/api/ext/*` server routes are always mounted for the route.
 *
 * `id` / `version` / `defaultEnabled` / `requiredAtBuild` MUST match the server half.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.extension-marketplace",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Extension Marketplace",
  description:
    "Browse and install third-party extensions from the community catalog. Web half: the " +
    "/extensions browse + install UX.",
  defaultEnabled: true,
  requiredAtBuild: true,
  entryPoints: {
    web: async () => import("./web"),
  },
};
