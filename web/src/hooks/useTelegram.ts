// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shim for `builtin.telegram-miniapp` web-side Telegram detection
 * (issue #1283, Sub-Issue S of epic #1264).
 *
 * The real detection logic now lives in
 * `web/src/extensions/telegram-miniapp/detection.ts`. This file is the stable
 * consumer-facing seam: every consumer keeps importing these functions from
 * `@/hooks/useTelegram` unchanged (R6), and the extension's `register()` (in
 * `web/src/extensions/telegram-miniapp/web.tsx`) installs the real detection
 * functions into `_impl` at boot — before `main.tsx`'s `bootstrap()` runs (the
 * web loader runs first; locked contract §5h + §5a).
 *
 * When the extension is DISABLED (`register()` never runs), `_impl` stays `null`
 * and every function returns its "no Telegram" default — so the standard
 * browser/PWA path is unaffected:
 *   - `isTelegramEnvironment()` → `false`
 *   - `getTelegramWebApp()`     → `null`
 *   - `isTelegramApp()`         → `false`
 *   - `loadTelegramSdk()`       → resolves immediately
 */
import type { TelegramWebApp } from "@/extensions/telegram-miniapp/detection";

export type {
  TelegramWebApp,
  TelegramWebAppThemeParams,
  TelegramWebAppUser,
  TelegramWebAppInitDataUnsafe,
} from "@/extensions/telegram-miniapp/detection";

interface TelegramDetectionImpl {
  isTelegramEnvironment(): boolean;
  getTelegramWebApp(): TelegramWebApp | null;
  isTelegramApp(): boolean;
  loadTelegramSdk(timeoutMs?: number): Promise<void>;
}

/**
 * The real detection impl. `null` until the extension's `register()` installs it
 * — i.e. `null` whenever `builtin.telegram-miniapp` is disabled.
 */
let _impl: TelegramDetectionImpl | null = null;

/**
 * Internal: installed by the extension's `register()` at boot. NOT public API —
 * the `_` prefix marks it module-internal.
 */
export function _setTelegramDetectionImpl(impl: TelegramDetectionImpl): void {
  _impl = impl;
}

export function isTelegramEnvironment(): boolean {
  return _impl?.isTelegramEnvironment() ?? false;
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return _impl?.getTelegramWebApp() ?? null;
}

export function isTelegramApp(): boolean {
  return _impl?.isTelegramApp() ?? false;
}

export function loadTelegramSdk(timeoutMs = 3000): Promise<void> {
  return _impl?.loadTelegramSdk(timeoutMs) ?? Promise.resolve();
}
