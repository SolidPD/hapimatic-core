// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.extension-marketplace` — server half (issue #1292, PR-2).
 *
 * Declares ONLY the `server` entry point. The web counterpart lives at
 * `web/src/extensions/extension-marketplace/manifest.ts` and declares only `web`. Codegen filters
 * by `manifest.entryPoints[runtime]`, so this directory is emitted solely into
 * `server/src/extensions.generated.ts` — the web bundle never pulls server code through it, and
 * the shared id is not a duplicate registration (both halves resolve to one `extension_prefs` row).
 *
 * `id` / `version` / `defaultEnabled` / `requiredAtBuild` MUST match the web half.
 * `requiredAtBuild: true` mirrors `builtin.analytics` / `builtin.error-log-viewer`: the web
 * `/extensions` route is static-imported by `router.tsx` (always present), so the marketplace must
 * stay enabled or the browse UI would show with its backing `/api/ext/*` routes 404'd.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.extension-marketplace",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Extension Marketplace",
  description:
    "Browse and install third-party extensions from the community catalog. Server half: the " +
    "/api/ext/catalog proxy + /api/ext/install route (approach A — re-invokes `hapi ext install`).",
  defaultEnabled: true,
  requiredAtBuild: true,
  // #3752: declares catalog.contribute — this builtin contributes capability-catalog
  // entries (its routes are cataloged()). Inert for trusted build-composed extensions
  // (the gate bypasses them); the explicit marker AC2/V2 require.
  capabilities: ["catalog.contribute"],
  entryPoints: {
    server: async () => import("./server"),
  },
};
