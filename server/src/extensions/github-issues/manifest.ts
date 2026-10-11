// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `builtin.github-issues` — read-only GitHub issue/repo/account proxy via the
 * host `gh` CLI (issue #1280, Sub-Issue P of epic #1264).
 *
 * Migrates `server/src/web/routes/github.ts` (the `GET /api/github/*` routes)
 * into a server-only extension. Despite the issue title "github-oauth", there is
 * NO GitHub OAuth in the codebase — the routes shell out to the host-installed
 * `gh` CLI, authenticated out-of-band via `gh auth login` (do not confuse with
 * epic #1446's multi-account ANTHROPIC OAuth in `accountService.ts`). Honest
 * naming: `builtin.github-issues`.
 *
 * The four routes it contributes are read-only: `GET /github/issues/:owner/:repo/:number`,
 * `GET /github/repo-issues`, `GET /github/accounts`, and `GET /github/repos`
 * (the latter two added by #1953 for the GitHub-account → repo → clone-on-spawn
 * backend). The loader mounts them under `/api` AFTER the JWT auth middleware —
 * the same post-auth position the inline `app.route("/api", createGitHubRoutes())`
 * mount occupied, so `/api/github/*` URLs and their auth gating are preserved.
 *
 * `defaultEnabled: true` — the Hapimatic dev workflow depends on the
 * `IssueInputModal` / issue-linking UI (and the GitHub-account selector on the
 * create page), all of which call these routes.
 *
 * `requiredAtBuild: false` — unlike `builtin.notifications-push` (the notification
 * floor several core services hard-depend on), nothing depends on these routes
 * being present, so the extension stays disableable via `extension_prefs`. When
 * disabled the routes 404 and the UI degrades gracefully (the modal shows an
 * empty "no issues" state; it does not crash).
 */
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

export const manifest: HapiExtensionManifest = {
  id: "builtin.github-issues",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "GitHub Issues",
  description:
    "Read-only GitHub issue/repo/account lookup via the host `gh` CLI (NOT OAuth).",
  defaultEnabled: true,
  requiredAtBuild: false,
  // #3752: declares catalog.contribute — this builtin contributes capability-catalog
  // entries (its routes are cataloged()). Inert for trusted build-composed extensions
  // (the gate bypasses them); the explicit marker AC2/V2 require.
  capabilities: ["catalog.contribute"],
  entryPoints: {
    server: async () => import("./server"),
  },
};
