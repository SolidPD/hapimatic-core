// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.notifications-telegram` (issue #1271).
 *
 * Registers `HappyBot` as a `NotificationChannel` and moves its polling
 * lifecycle out of `server/src/index.ts` and onto the host's lifecycle hooks:
 * the loader drains `onStartup` after core services are constructed (post-boot)
 * and `onShutdown` during graceful shutdown — the same ordering the inline
 * `happyBot.start()` / `happyBot.stop()` calls used to provide.
 *
 * Two independent gates must both pass for the bot to run, preserving
 * pre-migration semantics exactly:
 *   1. The loader's enable check (`extension_prefs`, seeded by Sub-Issue E when
 *      a token is configured) — the extension is not even imported when off.
 *   2. The token/enabled check below, mirroring the old
 *      `if (config.telegramEnabled && config.telegramBotToken)` guard.
 */
import type { ServerRegister } from "@hapi/protocol/ext";

import type { ErrorLogger } from "../../logging/errorLogger";
import type { Store } from "../../store";
import type { SyncEngine } from "../../sync/syncEngine";
import { HappyBot } from "./bot";

/**
 * The slice of core `Configuration` this extension reads. Declared structurally
 * rather than importing the (non-exported) `Configuration` class, so the
 * extension states exactly what it depends on and is unaffected by unrelated
 * core-config changes.
 */
interface TelegramCoreConfig {
  telegramEnabled: boolean;
  telegramBotToken: string | null;
  miniAppUrl: string;
}

export const register: ServerRegister = async host => {
  // Core config via the #1271 `getCoreConfig()` amendment — `host.config.get()`
  // reads this extension's own extension_prefs row, not core settings.
  const coreConfig = host.getCoreConfig() as TelegramCoreConfig | null;
  const botToken = coreConfig?.telegramBotToken ?? null;

  if (!coreConfig?.telegramEnabled || !botToken) {
    // Parity with the pre-migration inline guard: no channel, no bot, no error.
    return;
  }

  const syncEngine = host.getSyncEngine() as SyncEngine | null;
  if (!syncEngine) {
    throw new Error(
      "[builtin.notifications-telegram] syncEngine is unavailable at register()"
    );
  }

  const bot = new HappyBot({
    syncEngine,
    botToken,
    miniAppUrl: coreConfig.miniAppUrl,
    store: host.getStore() as Store,
    errorLogger: host.getErrorLogger() as ErrorLogger | null,
  });

  host.notifications.addChannel(bot);

  // Long-running work never starts in register() — the host contract requires
  // it to start in onStartup, once core services exist.
  host.lifecycle.onStartup(async () => {
    await bot.start();
  });
  host.lifecycle.onShutdown(async () => {
    await bot.stop();
  });
};
