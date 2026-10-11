// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.heartbeat` — server half (issue #1275, Sub-Issue K of epic #1264).
 *
 * Declares ONLY the `server` entry point. The web counterpart lives at
 * `web/src/extensions/heartbeat/manifest.ts` and declares only `web`. F's
 * codegen filters by `manifest.entryPoints[runtime]`, so this directory is
 * emitted solely into `server/src/extensions.generated.ts` — the web bundle
 * never pulls server code through this manifest.
 *
 * Static metadata is spread from the shared constant so the two halves cannot
 * drift on `id`/`version`/`defaultEnabled`.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { HEARTBEAT_EXT_META } from "@hapi/protocol/extensions/heartbeat/manifestShared";

export const manifest: HapiExtensionManifest = {
  ...HEARTBEAT_EXT_META,
  // #3752: declares catalog.contribute — this builtin contributes capability-catalog
  // entries (its routes are cataloged()). Inert for trusted build-composed extensions
  // (the gate bypasses them); the explicit marker AC2/V2 require.
  capabilities: ["catalog.contribute"],
  entryPoints: {
    server: async () => import("./server"),
  },
};
