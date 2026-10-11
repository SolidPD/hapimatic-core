// SPDX-License-Identifier: AGPL-3.0-only
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

/**
 * `builtin.error-log-viewer` — the `/error-logs` diagnostic viewer UI (issue
 * #1279, Sub-Issue O of epic #1264).
 *
 * Migrates the error-log viewer component + its TanStack Query hooks out of core
 * (`web/src/components/ErrorLogViewer.tsx`, `web/src/hooks/queries/useErrorLogs.ts`)
 * into a web extension. The **server-side `ErrorLogger` and the `/api/error-logs*`
 * routes stay in core** — too many subsystems (sync, federation, sessions) depend on
 * the logger; only the read-only UI viewer is the extension.
 *
 * `requiredAtBuild: true` (mirrors `builtin.git-rpc` / `builtin.tool-views`): the
 * `/error-logs` route is statically imported by `router.tsx` — the v0.1
 * `navigation.addRoute` API is declared but UNCONSUMED (TanStack Router infers valid
 * paths from its static route tree at module-eval, so a dynamically-registered route
 * would leave the typed tree). #1042 locked `/error-logs` as an always-present
 * top-level route (the `/settings` drawer links to it), so the route MUST NOT depend on
 * runtime enable-state. `requiredAtBuild` short-circuits the loader's enable check, so
 * v0.1 has NO user-facing disable path — the migration's value is ownership clarity + a
 * lazy chunk boundary + catalogue registration, not a runtime toggle. Web-only (no
 * server/cli entry point) — the moved hooks call the core `ApiClient` methods, which stay
 * in core.
 */
export const manifest: HapiExtensionManifest = {
  id: "builtin.error-log-viewer",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Error Log Viewer",
  description:
    "The /error-logs diagnostic viewer UI — server, client, and CLI error logs " +
    "with severity/source/time filters, expandable rows, and delete. The " +
    "server-side ErrorLogger and /api/error-logs* routes stay in core.",
  defaultEnabled: true,
  requiredAtBuild: true,
  entryPoints: {
    web: async () => import("./web"),
  },
};
