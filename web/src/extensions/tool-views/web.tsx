// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Web entry point for `builtin.tool-views` (issue #1277, Sub-Issue M of epic
 * #1264). Resolved lazily by the loader via `manifest.entryPoints.web()` and
 * invoked once during `loadWebExtensions` (`web/src/ext/loader.ts`), BEFORE
 * `bootstrap()` — so the host is fully populated before the first `<ToolCard />`
 * renders.
 *
 * `register(host)` maps the pre-migration static registries 1:1 onto the host
 * contribution points:
 *   - `host.toolViews.addCompact`  ← the old `toolViewRegistry`      (10 entries)
 *   - `host.toolViews.addFullInput` ← the old `toolFullViewRegistry` (9 entries)
 *   - `host.toolViews.addResult`    ← the old `toolResultViewRegistry` (24 entries)
 *
 * The lowercase aliases (`ask_user_question`, `exit_plan_mode`) are intentional
 * duplicates — the Codex agent emits snake_case tool names, so both spellings
 * resolve to the same view (behaviour preserved verbatim from `_all.tsx`).
 *
 * `CodexPatch` registers a FULL-INPUT view only (no compact view) — matching the
 * pre-migration registry shape exactly.
 */
import type { WebExtensionHost } from "@hapi/protocol/ext";

import { AskUserQuestionView } from "./views/AskUserQuestionView";
import { CodexDiffCompactView, CodexDiffFullView } from "./views/CodexDiffView";
import { CodexPatchView } from "./views/CodexPatchView";
import { EditView } from "./views/EditView";
import { ExitPlanModeView } from "./views/ExitPlanModeView";
import { MultiEditFullView, MultiEditView } from "./views/MultiEditView";
import { ScheduleWakeupView } from "./views/ScheduleWakeupView";
import { TodoWriteView } from "./views/TodoWriteView";
import { WriteView } from "./views/WriteView";
import {
  AskUserQuestionResultView,
  BashResultView,
  CodexDiffResultView,
  CodexPatchResultView,
  CodexReasoningResultView,
  LineListResultView,
  MarkdownResultView,
  MutationResultView,
  ReadResultView,
  SkillResultView,
  TodoWriteResultView,
} from "./views/_resultViews";

export async function register(host: WebExtensionHost): Promise<void> {
  // Compact (inline) input views — mirrors the old `toolViewRegistry` (10).
  host.toolViews.addCompact("Edit", EditView);
  host.toolViews.addCompact("MultiEdit", MultiEditView);
  host.toolViews.addCompact("Write", WriteView);
  host.toolViews.addCompact("TodoWrite", TodoWriteView);
  host.toolViews.addCompact("ScheduleWakeup", ScheduleWakeupView);
  host.toolViews.addCompact("CodexDiff", CodexDiffCompactView);
  host.toolViews.addCompact("AskUserQuestion", AskUserQuestionView);
  host.toolViews.addCompact("ExitPlanMode", ExitPlanModeView);
  host.toolViews.addCompact("ask_user_question", AskUserQuestionView);
  host.toolViews.addCompact("exit_plan_mode", ExitPlanModeView);

  // Full input (dialog) views — mirrors the old `toolFullViewRegistry` (9).
  host.toolViews.addFullInput("Edit", EditView);
  host.toolViews.addFullInput("MultiEdit", MultiEditFullView);
  host.toolViews.addFullInput("Write", WriteView);
  host.toolViews.addFullInput("CodexDiff", CodexDiffFullView);
  host.toolViews.addFullInput("CodexPatch", CodexPatchView);
  host.toolViews.addFullInput("AskUserQuestion", AskUserQuestionView);
  host.toolViews.addFullInput("ExitPlanMode", ExitPlanModeView);
  host.toolViews.addFullInput("ask_user_question", AskUserQuestionView);
  host.toolViews.addFullInput("exit_plan_mode", ExitPlanModeView);

  // Result views — mirrors the old `toolResultViewRegistry` (24).
  host.toolViews.addResult("Task", MarkdownResultView);
  host.toolViews.addResult("Bash", BashResultView);
  host.toolViews.addResult("CodexBash", BashResultView);
  host.toolViews.addResult("Glob", LineListResultView);
  host.toolViews.addResult("Grep", LineListResultView);
  host.toolViews.addResult("LS", LineListResultView);
  host.toolViews.addResult("Read", ReadResultView);
  host.toolViews.addResult("Edit", MutationResultView);
  host.toolViews.addResult("MultiEdit", MutationResultView);
  host.toolViews.addResult("Write", MutationResultView);
  host.toolViews.addResult("WebFetch", MarkdownResultView);
  host.toolViews.addResult("WebSearch", MarkdownResultView);
  host.toolViews.addResult("NotebookRead", ReadResultView);
  host.toolViews.addResult("NotebookEdit", MutationResultView);
  host.toolViews.addResult("TodoWrite", TodoWriteResultView);
  host.toolViews.addResult("ScheduleWakeup", ScheduleWakeupView);
  host.toolViews.addResult("CodexReasoning", CodexReasoningResultView);
  host.toolViews.addResult("CodexPatch", CodexPatchResultView);
  host.toolViews.addResult("CodexDiff", CodexDiffResultView);
  host.toolViews.addResult("AskUserQuestion", AskUserQuestionResultView);
  host.toolViews.addResult("ExitPlanMode", MarkdownResultView);
  host.toolViews.addResult("ask_user_question", AskUserQuestionResultView);
  host.toolViews.addResult("exit_plan_mode", MarkdownResultView);
  host.toolViews.addResult("Skill", SkillResultView);
}
