// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.notifications-telegram` — Telegram bot notification channel
 * (issue #1271, Sub-Issue G of epic #1264).
 *
 * `defaultEnabled: false` matches the pre-migration opt-in behaviour: Telegram
 * only ran when `telegramBotToken` was configured. Feature parity across the
 * migration is preserved by Sub-Issue E's seed
 * (`server/src/store/index.ts` — `INSERT OR IGNORE` an `enabled = 1` row for
 * this id when a token is configured), so a token-configured install keeps
 * working without any user action, while an explicit `enabled = 0` row is never
 * overwritten.
 *
 * No `configSchema`: the bot token comes from CORE config, not extension prefs.
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.notifications-telegram",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Telegram Notifications",
  description: "Telegram bot for permission and ready notifications.",
  defaultEnabled: false,
  entryPoints: {
    server: async () => import("./server"),
  },
};
