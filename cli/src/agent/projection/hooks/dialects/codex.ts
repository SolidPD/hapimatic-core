// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Codex `hooks.json` dialect emitter (issue #3123, Task 2).
 *
 * Codex hooks are EXPERIMENTAL and version-gated: the layered-config
 * `~/.codex/hooks.json` + `.codex/hooks.json` clones the Claude hook taxonomy
 * (first shipped v0.114 / Mar 2026; the codex manifest verifies 0.147.0 > 0.114).
 * Because Codex clones the taxonomy, the emitted file is structurally the same
 * nested `{ hooks: { <event>: [{ matcher, hooks: [{ type, command, timeout }] }] } }`
 * shape as `.claude/settings.json` — a taxonomy-preserving remap (KD2), not a
 * translation.
 *
 * OR2: the survey-verified event set is `PreToolUse` / `PostToolUse` /
 * `UserPromptSubmit`. Events outside it degrade at the transpiler level (R3);
 * refining this against the installed `codex --version` is a documented
 * follow-up.
 */
import type { ClaudeHookTaxonomy, DialectFile, HookEvent } from "../transpiler";

/** The Codex hook events verified by the epic #3117 survey (v0.114+ set). */
export const CODEX_SUPPORTED_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
]);

/** Config-home-relative path of the project-level Codex hooks file. */
export const CODEX_HOOKS_PATH = ".codex/hooks.json";

/**
 * Emit the Codex `hooks.json` registration wrapper from the shared
 * Claude-taxonomy object. The `command` values are carried verbatim from the
 * canonical hooks (R4 — one script, N wrappers).
 */
export function emitCodexHooks(taxonomy: ClaudeHookTaxonomy): DialectFile {
  return {
    path: CODEX_HOOKS_PATH,
    content: `${JSON.stringify({ hooks: taxonomy }, null, 2)}\n`,
  };
}
