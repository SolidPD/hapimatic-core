// SPDX-License-Identifier: AGPL-3.0-only
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

/**
 * `builtin.analytics` — the `/settings/analytics` telemetry dashboard UI (issue #1282,
 * Sub-Issue R of epic #1264).
 *
 * Migrates the analytics page, its eleven panel components, and its TanStack Query
 * hooks out of core (`web/src/routes/analytics.tsx`, `web/src/components/analytics/`,
 * `web/src/hooks/queries/useTelemetry.ts`) into a web extension. The **server-side
 * `/api/telemetry/*` routes, `TelemetryStore`, and `TurnAnalyticsCounts` stay in
 * core** — the extension is the read-only UI consumer of endpoints core already owns,
 * so this migration adds no server routes.
 *
 * `requiredAtBuild: true` (mirrors `builtin.error-log-viewer` / `builtin.git-rpc` /
 * `builtin.tool-views`): the analytics route is statically imported by `router.tsx` —
 * the v0.1 `navigation.addRoute` API is declared but UNCONSUMED (TanStack Router infers
 * valid paths from its static route tree at module-eval, so a dynamically-registered
 * route would leave the typed tree and break `web/src/routes/settings/index.tsx`'s
 * `navigate({ to: "/settings/analytics" })`). #1042 locked the analytics page as an
 * always-present route (the `/settings` drawer links to it; moved from top-level
 * `/analytics` to `/settings/analytics` in the #2745 feedback round, with the old
 * path redirecting), so the route MUST NOT depend on
 * runtime enable-state. `requiredAtBuild` short-circuits the loader's enable check, so
 * v0.1 has NO user-facing disable path — the migration's value is ownership clarity + a
 * lazy chunk boundary + catalogue registration, not a runtime toggle. Web-only (no
 * server/cli entry point) — the moved hooks call core `ApiClient` methods, which stay
 * in core.
 */
export const manifest: HapiExtensionManifest = {
  id: "builtin.analytics",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Analytics",
  description:
    "The /settings/analytics telemetry dashboard — usage overview, time series, type " +
    "distribution, file table, duration histogram, outcome rates, anomaly " +
    "detection, token budget, session profiles, and period comparison, with " +
    "time-range/file-type/interval filters. The server-side /api/telemetry* " +
    "routes and telemetry stores stay in core.",
  defaultEnabled: true,
  requiredAtBuild: true,
  entryPoints: {
    web: async () => import("./web"),
  },
};
