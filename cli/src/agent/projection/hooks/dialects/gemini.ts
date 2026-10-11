// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Gemini hooks dialect emitter (issue #3123, Task 3).
 *
 * Gemini reads hooks from `~/.gemini/settings.json` and ships
 * `gemini hooks migrate --from-claude` (converts Claude hooks, remaps tool
 * names) — the parity baseline (KD2). Because the migrate path consumes the
 * Claude shape, the emitter writes the SAME nested taxonomy under the `hooks`
 * key of the per-session `.gemini/settings.json`.
 *
 * ⚠️ Gemini is NOT installed in this worker environment — the event set is the
 * epic #3117 survey's migrate-parity baseline (the full Claude taxonomy), NOT
 * verified against a binary. OR2: `gemini hooks migrate` availability is
 * version-dependent (missing in some preview builds — gemini-cli#16049); a guard
 * whose event the installed gemini rejects degrades down the ladder (R3).
 * Emitting the native settings.json shape is the version-independent fallback.
 */
import type { ClaudeHookTaxonomy, DialectFile, HookEvent } from "../transpiler";

/**
 * Gemini's migrate-parity event set (survey baseline — the full Claude
 * taxonomy). Unverified against an installed binary; recorded honestly per OR2.
 */
export const GEMINI_SUPPORTED_EVENTS: ReadonlySet<HookEvent> = new Set([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "Notification",
]);

/** Config-home-relative path of the Gemini settings file carrying `hooks`. */
export const GEMINI_SETTINGS_PATH = ".gemini/settings.json";

/**
 * Emit the Gemini `settings.json` registration wrapper (the `hooks` block) from
 * the shared Claude-taxonomy object. `command` values are carried verbatim (R4).
 */
export function emitGeminiHooks(taxonomy: ClaudeHookTaxonomy): DialectFile {
  return {
    path: GEMINI_SETTINGS_PATH,
    content: `${JSON.stringify({ hooks: taxonomy }, null, 2)}\n`,
  };
}
