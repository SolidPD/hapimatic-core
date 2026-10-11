// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared static metadata for the `builtin.telegram-miniapp` extension
 * (issue #1283, Sub-Issue S of epic #1264).
 *
 * Telegram Mini App support ships as TWO per-package extension directories that
 * share a single logical id:
 *
 *   - `server/src/extensions/telegram-miniapp/` — declares only `entryPoints.server`
 *     (init-data validation for Telegram-launched auth/bind requests)
 *   - `web/src/extensions/telegram-miniapp/`    — declares only `entryPoints.web`
 *     (Telegram WebApp runtime detection on the client)
 *
 * F's codegen (`scripts/generate-extension-registry.ts`) filters each entry by
 * `manifest.entryPoints[runtime]`, so the server directory lands ONLY in
 * `server/src/extensions.generated.ts` and the web directory ONLY in
 * `web/src/extensions.generated.ts`. Neither loader sees both, so the shared id
 * is not a duplicate-registration hazard — and keeping the trees separate means
 * the web bundle never imports server code.
 *
 * Both manifests spread this constant so the static fields (`id`, `version`,
 * `defaultEnabled`, …) cannot drift apart. They collide intentionally on the
 * single `extension_prefs` row keyed by `builtin.telegram-miniapp`, so enabling
 * or disabling the extension toggles BOTH halves in lockstep. Mirrors
 * `HEARTBEAT_EXT_META` (#1275) and `SCHEDULER_EXT_META` (#1274).
 */
import { PLUGIN_API_VERSION } from "../../ext/version";

export const TELEGRAM_MINIAPP_EXT_META = {
  id: "builtin.telegram-miniapp",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Telegram Mini App",
  description:
    "Telegram Mini App distribution channel: validates Telegram init data on the server for Telegram-launched sessions and detects the Telegram WebApp runtime on the client. Disable if not using the Telegram Mini App distribution channel.",
  // `false` — the Telegram Mini App is a niche distribution channel, opt-in for
  // fresh installs. The extension_prefs seed at `server/src/store/index.ts`
  // (issue #1269, locked contract §7) inserts an `enabled = 1` row on first boot
  // when `telegramBotToken` is configured, so existing Telegram deployments keep
  // Mini App auth working across the upgrade with no manual step.
  defaultEnabled: false,
  // NOT a build-time requirement: core (`auth.ts` / `bind.ts`) calls the shim at
  // `server/src/web/telegramInitData.ts`, never the extension directly, so an
  // explicit `false` in extension_prefs legitimately disables it — the shim then
  // returns the "extension is disabled" result and the routes surface it as 401.
  requiredAtBuild: false,
} as const;
