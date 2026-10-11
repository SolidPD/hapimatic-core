// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.git-rpc` — web half (issue #1281, Sub-Issue Q of epic #1264).
 *
 * Declares ONLY the `web` entry point; the server counterpart at
 * `server/src/extensions/git-rpc/manifest.ts` declares only `server`. Both
 * spread the same shared metadata, so they share the id `builtin.git-rpc` and
 * therefore the single `extension_prefs` row — enabling or disabling git-rpc
 * toggles both halves together.
 *
 * F's codegen filters entries by `manifest.entryPoints[runtime]`, so this
 * directory is emitted only into `web/src/extensions.generated.ts`. The web
 * bundle never reaches into server code.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { GIT_RPC_EXT_META } from "@hapi/protocol/extensions/git-rpc/manifestShared";

export const manifest: HapiExtensionManifest = {
  ...GIT_RPC_EXT_META,
  entryPoints: {
    web: async () => import("./web"),
  },
};
