// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Pins block (#6458, Pins PM ruling PM-1): the one text that tells a
 * session about Pins, rendered only where the session's Pins gate is open and
 * appended after the docs pointer by each harness's prompt builder (Claude:
 * `buildSystemPrompt`; the daemon's tmux render; Codex; Gemini and OpenCode).
 *
 * It is separate from Tier-0 on purpose. Tier-0 renders from the static index
 * at every prompt build, including the daemon's spawn path before the session
 * exists, so it cannot know an instance's gate, and a per-session render may
 * only drop entries from it (`renderTier0.ts`). This block costs nothing where
 * Pins is off, carries its own bound, and turns off with the gate.
 *
 * The file sentence agrees with `pin_folder`'s own description
 * (`cli/src/claude/utils/hapiPinTools.ts`): pin files go in the folders that
 * tool returns, which is the GeneratedFiles rule's case for pin files; the rule
 * itself (`GENERATED_FILES_RULE`) does not change (PM-2). Re-run the #6223
 * headless placement cases before rewording that sentence.
 */
import type { CatalogEntry } from "./types";

/**
 * Upper bound on the block, in characters. The block is added to every session
 * whose gate is open, outside the Tier-0 budget the way the docs pointer is, so
 * it carries its own bound (PM-10). Raising it is a reviewed decision.
 */
export const PINS_PRIMER_BUDGET_CHARS = 1100;

/**
 * The tool names the block lists: every catalog entry behind the Pins gate that
 * is invoked as an MCP tool (A11), so `pin_folder` and later pin tools cannot
 * drift out of the block, and a later gated REST or UI entry cannot reach it.
 */
export function pinsPrimerToolNames(
  entries: readonly CatalogEntry[]
): string[] {
  const names = new Set<string>();
  for (const e of entries) {
    if (e.availability?.gate !== "pins") continue;
    if (e.invocation.kind !== "mcp") continue;
    names.add(e.invocation.tool);
  }
  return [...names].sort();
}

/** The Pins block for a session whose Pins gate is open. */
export function renderPinsPrimer(entries: readonly CatalogEntry[]): string {
  const tools = pinsPrimerToolNames(entries)
    .map(name => `\`${name}\``)
    .join(", ");
  return [
    `Pins (this session has the Pins tab; pin tools: ${tools}):`,
    "- Always pin a decision, review or step list that needs the operator, " +
      "because the chat scrolls away and the Pins tab does not. Use a " +
      "`hapi_pin` fenced block only when the pin tools are absent.",
    '- "Pin" means a Pins-tab pin unless the context clearly means another ' +
      "kind (a Pinterest board, a GPIO pin, a version pin).",
    "- Every pin has an ID (`pin-` and ten characters) that `pin_get({id})` " +
      "reads from any session; name pins by ID when you report to a project " +
      "manager, because an ID finds a pin on any node.",
    "- Put a pin's files in the folders `pin_folder` returns (the saved one " +
      "under `GeneratedFiles/pins/` for a file you keep building on), never " +
      "loose in `GeneratedFiles/`.",
    "- End a loop tick or status report that has open pins with one count " +
      "line, `📌 N open (M new: <titles>)`, because each pin carries its own " +
      "detail.",
    "- If a pin tool answers `pins_unavailable`, Pins was turned off here: " +
      "ask in the chat, because a `hapi_pin` block is dropped then too.",
  ].join("\n");
}
