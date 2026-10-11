// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Shared static metadata for the `builtin.session-notes` extension
 * (issue #1284, Sub-Issue T of epic #1264).
 *
 * Session notes ship as TWO per-package extension directories sharing a single
 * logical id:
 *
 *   - `server/src/extensions/session-notes/` — declares only `entryPoints.server`
 *     (the `ext_builtin_session_notes_notes` table + `/api/session-notes/*` CRUD)
 *   - `web/src/extensions/session-notes/`    — declares only `entryPoints.web`
 *     (the `NotesTab` + `NotesIndicator` session-detail slot contributions)
 *
 * F's codegen (`scripts/generate-extension-registry.ts`) filters each entry by
 * `manifest.entryPoints[runtime]`, so the server directory lands ONLY in
 * `server/src/extensions.generated.ts` and the web directory ONLY in
 * `web/src/extensions.generated.ts`. Neither loader sees both, so the shared id
 * is not a duplicate-registration hazard, and the web bundle never imports
 * server code.
 *
 * Both manifests spread this constant so the static fields cannot drift apart.
 * They collide intentionally on the single `extension_prefs` row keyed by
 * `builtin.session-notes`, so enabling or disabling toggles BOTH halves in
 * lockstep. Mirrors `SCHEDULER_EXT_META` (#1274), `HEARTBEAT_EXT_META` (#1275),
 * and `TELEGRAM_MINIAPP_EXT_META` (#1283).
 *
 * ## Not to be confused with core's single-string session notes
 *
 * Core owns an unrelated `sessions.notes` TEXT column (one free-text note per
 * session, edited by `web/src/components/SessionNotes.tsx` via
 * `PUT /api/sessions/:id/notes`). THIS extension is a separate multi-note CRUD
 * feature with its own table and its own `/api/session-notes/*` route prefix.
 * The prefix is load-bearing, not cosmetic: extension route factories mount at
 * `server/src/web/server.ts:382`, BEFORE `createSessionsRoutes` at `:405`, and
 * Hono resolves first-registered-wins — so an extension route at
 * `/sessions/:id/notes` would silently shadow core's and break the existing
 * feature.
 */
import { PLUGIN_API_VERSION } from "../../ext/version";

export const SESSION_NOTES_EXT_META = {
  id: "builtin.session-notes",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Session Notes",
  description:
    "Per-session timestamped notes: a session-detail tab for create/edit/delete " +
    "plus a count badge in the info-field slot. Server-owned table with REST CRUD.",
  // `true` — the issue's acceptance criteria require the extension to be on by
  // default for all sessions. It is additive (a new tab + a badge) and cannot
  // degrade any core surface when enabled.
  defaultEnabled: true,
  // NOT a build-time requirement: nothing in core references this extension, so
  // an explicit `false` in extension_prefs legitimately disables it. The tab and
  // the badge simply stop being contributed, and both slot hosts render nothing
  // when their slot is empty.
  requiredAtBuild: false,
} as const;
