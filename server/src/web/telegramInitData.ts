// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shim for `builtin.telegram-miniapp` server-side init-data validation
 * (issue #1283, Sub-Issue S of epic #1264).
 *
 * The real implementation now lives in
 * `server/src/extensions/telegram-miniapp/initData.ts`. This file is the stable
 * consumer-facing seam: `auth.ts` and `bind.ts` keep importing
 * `validateTelegramInitData` from here unchanged (R6/R7), and the extension's
 * `register()` installs the real validator into `_impl` at boot.
 *
 * When the extension is DISABLED (its `register()` never runs), `_impl` stays
 * `null` and `validateTelegramInitData` returns
 * `{ ok: false, error: "Telegram Mini App extension is disabled" }` — which the
 * route handlers surface as HTTP 401 (amended R2, locked contract §7). The
 * separate token-unset gate (`configuration.telegramEnabled`) in those routes
 * still returns 503 first when no bot token is configured.
 */
import type { TelegramInitDataValidation } from "../extensions/telegram-miniapp/initData";

export type {
  TelegramUser,
  TelegramInitDataValidation,
} from "../extensions/telegram-miniapp/initData";

type TelegramInitDataValidator = (
  initData: string,
  botToken: string,
  maxAgeSeconds?: number
) => TelegramInitDataValidation;

/**
 * The real validator. `null` until the extension's `register()` installs it —
 * i.e. `null` whenever `builtin.telegram-miniapp` is disabled.
 */
let _impl: TelegramInitDataValidator | null = null;

/**
 * Internal: installed by the extension's `register()` at boot. NOT public API —
 * the `_` prefix marks it module-internal (it is not part of any published
 * import surface consumers should depend on).
 */
export function _setTelegramInitDataValidator(
  impl: TelegramInitDataValidator
): void {
  _impl = impl;
}

export function validateTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number = 60 * 60 * 24
): TelegramInitDataValidation {
  if (_impl === null) {
    return { ok: false, error: "Telegram Mini App extension is disabled" };
  }
  return _impl(initData, botToken, maxAgeSeconds);
}
