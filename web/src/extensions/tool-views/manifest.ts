// SPDX-License-Identifier: AGPL-3.0-only
import type { HapiExtensionManifest } from "@hapi/protocol/ext";
import { PLUGIN_API_VERSION } from "@hapi/protocol/ext";

/**
 * `builtin.tool-views` — per-tool input & result view components for the chat
 * thread (issue #1277, Sub-Issue M of epic #1264).
 *
 * Migrates the compact / full-input / result view registries out of the static
 * `web/src/components/ToolCard/views/_all.tsx` + `_results.tsx` seed modules into
 * a lazy-loaded web extension: `register(host)` calls `host.toolViews.add*` for
 * every tool name, and `ToolCard.tsx` reads them back via the host accessors.
 *
 * `requiredAtBuild: true` (locked contract §6): tool views are core UX — without
 * them every tool degrades to the generic Input / core `GenericResultView`
 * fallback. The flag short-circuits the loader's enable check, so v0.1 has NO
 * user-facing disable path; disabling is a build-time config toggle only. The
 * migration's v0.1 value is pattern validation + a lazy chunk boundary, not a
 * user-reachable disable toggle. `defaultEnabled: true`; web-only (no
 * server/cli entry point).
 */
export const manifest: HapiExtensionManifest = {
  id: "builtin.tool-views",
  version: "0.1.0",
  apiVersion: PLUGIN_API_VERSION,
  displayName: "Tool Views",
  description:
    "Per-tool input and result view components for the chat thread " +
    "(Edit/MultiEdit/Write/TodoWrite/ScheduleWakeup/AskUserQuestion/ExitPlanMode/" +
    "CodexDiff/CodexPatch plus result-only views for Task/Bash/Glob/Grep/LS/Read/" +
    "WebFetch/WebSearch/NotebookRead/NotebookEdit/CodexReasoning/Skill).",
  defaultEnabled: true,
  requiredAtBuild: true,
  entryPoints: {
    web: async () => import("./web"),
  },
};
