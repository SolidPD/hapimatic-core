// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.scheduler` — web half (issue #1274, Sub-Issue J of epic #1264).
 *
 * Declares ONLY the `web` entry point; the server counterpart at
 * `server/src/extensions/scheduler/manifest.ts` declares only `server`. Both
 * spread the same shared metadata, so they share the id `builtin.scheduler` and
 * therefore the single `extension_prefs` row — enabling or disabling the
 * scheduler toggles both halves together.
 *
 * F's codegen filters entries by `manifest.entryPoints[runtime]`, so this
 * directory is emitted only into `web/src/extensions.generated.ts`. The two
 * halves never appear in the same loader's registry, so the shared id is not a
 * duplicate registration — and the web bundle never reaches into server code.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { SCHEDULER_EXT_META } from "@hapi/protocol/extensions/scheduler/manifestShared";

export const manifest: HapiExtensionManifest = {
  ...SCHEDULER_EXT_META,
  entryPoints: {
    web: async () => import("./web"),
  },
};
