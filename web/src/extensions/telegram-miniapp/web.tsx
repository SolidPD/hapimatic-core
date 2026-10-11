// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.telegram-miniapp` (issue #1283, Sub-Issue S of
 * epic #1264).
 *
 * ## Wire-up: Pattern A (shim with module-level setter)
 *
 * `WebExtensionHost` (C, #1267) exposes no platform-detection contribution slot
 * (its slots are `toolViews`/`sessionDetail`/`preferences`/`navigation`). So the
 * seven consumers that import Telegram detection from `@/hooks/useTelegram` keep
 * that import unchanged (R6) via a shim: `web/src/hooks/useTelegram.ts` holds a
 * module-level `_impl`, and this `register()` installs the real detection
 * functions into it.
 *
 * ## Why a STATIC import of the shim (not `await import(...)`)
 *
 * The loader reaches THIS module through `import("./web")` (a dynamic import Vite
 * uses to give every extension its own chunk). The shim is ALSO statically
 * imported by seven consumers. If this file `await import(...)`-ed the shim, Vite
 * would see the shim as both statically and dynamically imported, collapse the
 * split, and warn at build time (the same hazard documented in the heartbeat
 * `web.tsx`). A static import keeps the shim purely static everywhere.
 *
 * ## Boot order (R-S-3, closed upstream)
 *
 * `web/src/main.tsx` runs `loadWebExtensions()` BEFORE `bootstrap()`'s first call
 * to `isTelegramEnvironment()` (locked contract §5h + §5a; the shipped comment at
 * `main.tsx` names #1283 explicitly). So when the extension is enabled, `_impl`
 * is installed before any consumer reads it. When disabled, `register()` never
 * runs and the shim returns its "no Telegram" defaults.
 */
import type { WebRegister } from "@hapi/protocol/ext";

import { _setTelegramDetectionImpl } from "@/hooks/useTelegram";
import {
  isTelegramEnvironment,
  getTelegramWebApp,
  isTelegramApp,
  loadTelegramSdk,
} from "./detection";

export const register: WebRegister = async () => {
  _setTelegramDetectionImpl({
    isTelegramEnvironment,
    getTelegramWebApp,
    isTelegramApp,
    loadTelegramSdk,
  });
};
