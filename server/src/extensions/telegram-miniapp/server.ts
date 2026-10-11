// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Server entry point for `builtin.telegram-miniapp` (issue #1283, Sub-Issue S of
 * epic #1264).
 *
 * ## Wire-up: Pattern A (shim with module-level setter)
 *
 * Neither `ServerExtensionHost` (B, #1266) nor `WebExtensionHost` (C, #1267)
 * exposes a contribution slot for registering an init-data validator or a
 * platform detector — the shipped host slots are `notifications`/`agents`/
 * `routes`/`store`/`events`/`config`/`lifecycle` (server) and `toolViews`/
 * `sessionDetail`/`preferences`/`navigation` (web). So the only mechanism to let
 * `auth.ts`/`bind.ts` reach the validator WITHOUT editing them (R6/R7) is a shim:
 * `server/src/web/telegramInitData.ts` keeps its consumer-facing exports, holds a
 * module-level `_impl`, and this `register()` installs the real validator into it.
 *
 * ## Enable/disable semantics
 *
 *   - Extension ENABLED  → the loader runs this `register()` at boot (before the
 *     HTTP server accepts requests — server init step 6, HTTP at step 9), so the
 *     shim delegates to the real crypto validator.
 *   - Extension DISABLED → `register()` never runs; the shim's `_impl` stays
 *     `null` and `validateTelegramInitData` returns
 *     `{ ok: false, error: "Telegram Mini App extension is disabled" }`, which
 *     `auth.ts`/`bind.ts` surface as HTTP 401 (amended R2). The separate
 *     token-unset gate (`configuration.telegramEnabled`) still returns 503 first.
 *
 * No host slots are used — `register()` exists purely to install the validator.
 */
import type { ServerRegister } from "@hapi/protocol/ext";

import { validateTelegramInitData } from "./initData";
import { _setTelegramInitDataValidator } from "../../web/telegramInitData";

export const register: ServerRegister = async () => {
  _setTelegramInitDataValidator(validateTelegramInitData);
};
