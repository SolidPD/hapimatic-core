// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.telegram-miniapp` — web half (issue #1283, Sub-Issue S of epic #1264).
 *
 * Declares ONLY the `web` entry point; the server counterpart at
 * `server/src/extensions/telegram-miniapp/manifest.ts` declares only `server`.
 * Both spread the same shared metadata, so they share the id
 * `builtin.telegram-miniapp` and therefore the single `extension_prefs` row —
 * enabling or disabling the extension toggles both halves together.
 *
 * F's codegen filters entries by `manifest.entryPoints[runtime]`, so this
 * directory is emitted only into `web/src/extensions.generated.ts`. The two
 * halves never appear in the same loader's registry, so the shared id is not a
 * duplicate registration — and the web bundle never reaches into server code.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { TELEGRAM_MINIAPP_EXT_META } from "@hapi/protocol/extensions/telegram-miniapp/manifestShared";

export const manifest: HapiExtensionManifest = {
  ...TELEGRAM_MINIAPP_EXT_META,
  entryPoints: {
    web: async () => import("./web"),
  },
};
