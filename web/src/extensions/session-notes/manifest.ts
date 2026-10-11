// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.session-notes` — web half (issue #1284, Sub-Issue T of epic #1264).
 *
 * Declares ONLY the `web` entry point. The server counterpart lives at
 * `server/src/extensions/session-notes/manifest.ts` and declares only `server`.
 * F's codegen filters by `manifest.entryPoints[runtime]`, so this directory is
 * emitted solely into `web/src/extensions.generated.ts` and the web bundle never
 * pulls server code through this manifest.
 *
 * Static metadata is spread from the shared constant so the two halves cannot
 * drift on `id`/`version`/`defaultEnabled`. Both resolve to the same
 * `extension_prefs` row, so the tab/badge and the REST routes enable and disable
 * together.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { SESSION_NOTES_EXT_META } from "@hapi/protocol/extensions/session-notes/manifestShared";

export const manifest: HapiExtensionManifest = {
  ...SESSION_NOTES_EXT_META,
  entryPoints: {
    web: async () => import("./web"),
  },
};
