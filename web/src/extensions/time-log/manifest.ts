// SPDX-License-Identifier: AGPL-3.0-only
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

/**
 * `builtin.time-log` — the `/settings/time-log` page UI (issue #1278, Sub-Issue N of
 * epic #1264).
 *
 * Migrates the Time Log page (`TimeLogModalBody`), its charts (`TimeLogCharts`), its
 * TanStack Query hooks (`useTimeLogs`), the time-log-specific export helpers, and the
 * `/settings/time-log` route out of core into a web extension. The **server-side
 * `/api/timelogs/*` routes, `TimeLogStore`, the `store/turns/` derivation
 * (`deriveDailyTimeLog` / `deriveDailyBreakdown` / `timelogAdjustments`), and the
 * `TimelogResetService` midnight-reset all stay in core** — the extension is the
 * UI consumer of endpoints core already owns, so this migration adds no server routes.
 *
 * `requiredAtBuild: true` (mirrors `builtin.analytics` #1282 / `builtin.error-log-viewer`
 * #1279): the `/settings/time-log` route is statically imported by `router.tsx` — the v0.1
 * `navigation.addRoute` API is declared but UNCONSUMED (TanStack Router infers valid
 * paths from its static route tree at module-eval, so a dynamically-registered route
 * would leave the typed tree and break `web/src/routes/settings/index.tsx`'s
 * `navigate({ to: "/settings/time-log" })`). #1042 links `/settings/time-log` from the `/settings` drawer
 * drawer, so the route MUST stay always-present — `requiredAtBuild` short-circuits the
 * loader's enable check, so v0.1 has NO user-facing disable path. The migration's value
 * is ownership clarity + a lazy chunk boundary + catalogue registration, not a runtime
 * toggle. Web-only (no server/cli entry point) — the moved hooks call core `ApiClient`
 * methods, which stay in core.
 */
export const manifest: HapiExtensionManifest = {
  id: "builtin.time-log",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Time Log",
  description:
    "The /settings/time-log page — daily/weekly/monthly time totals with project " +
    "breakdown, charts, CSV/JSON export, and the six-control adjustment ledger. The " +
    "server-side /api/timelogs* routes, TimeLogStore, turns-derivation, and " +
    "midnight-reset stay in core.",
  defaultEnabled: true,
  requiredAtBuild: true,
  entryPoints: {
    web: async () => import("./web"),
  },
};
