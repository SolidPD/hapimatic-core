// SPDX-License-Identifier: AGPL-3.0-only
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

/**
 * `builtin.token-usage` — the compact session token indicator (issue #1285,
 * Sub-Issue U of epic #1264).
 *
 * The canonical reference extension for the **info-field slot**
 * (`host.sessionDetail.addInfoField`): a brand-new extension, not a migration.
 * It is a pure read of data core already has — no new tables, no new routes, no
 * new server endpoints, and no server entry point at all (web-only).
 *
 * `defaultEnabled: true` so the info-field slot has a visible built-in
 * demonstration out of the box. Unlike `builtin.error-log-viewer` /
 * `builtin.git-rpc`, this extension is NOT `requiredAtBuild` — nothing in core
 * static-imports it and no route depends on it, so it has a real runtime
 * disable path. Toggling it off removes the field, and (when it is the only
 * registered info-field) the whole info bar stops rendering — the R10
 * zero-contribution behavior the slot renderer guarantees.
 *
 * Coexists with the collapsible `<TokenUsageSection>` widget below the
 * composer, which stays in core: the widget is the ANALYTICAL surface (stacked
 * bar, sparkline, cost, legend); this field is the AT-A-GLANCE surface. Both
 * read the same `#1671` server aggregate, so their numbers agree.
 */
export const manifest: HapiExtensionManifest = {
  id: "builtin.token-usage",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Token Usage",
  description:
    "Compact token-usage indicator in the session-detail info-field slot. " +
    "Reads the existing server token aggregate (falling back to the client " +
    "message-metadata estimate); no server-side state of its own.",
  defaultEnabled: true,
  entryPoints: {
    web: async () => import("./web"),
  },
};
