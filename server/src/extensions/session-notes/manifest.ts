// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.session-notes` — server half (issue #1284, Sub-Issue T of epic #1264).
 *
 * Declares ONLY the `server` entry point. The web counterpart lives at
 * `web/src/extensions/session-notes/manifest.ts` and declares only `web`. F's
 * codegen filters by `manifest.entryPoints[runtime]`, so this directory is
 * emitted solely into `server/src/extensions.generated.ts` — the web bundle
 * never pulls server code through this manifest.
 *
 * Static metadata is spread from the shared constant so the two halves cannot
 * drift on `id`/`version`/`defaultEnabled`.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { SESSION_NOTES_EXT_META } from "@hapi/protocol/extensions/session-notes/manifestShared";

export const manifest: HapiExtensionManifest = {
  ...SESSION_NOTES_EXT_META,
  entryPoints: {
    server: async () => import("./server"),
  },
};
