// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { configuration } from "@/configuration";
import { renderTier0, capabilityCatalogIndex } from "@hapi/protocol";

/**
 * Pre-Tier-0 base system prompt, FROZEN as the byte-for-byte restore source for
 * the `HAPI_CAPABILITY_TIER0=0` kill-switch (issue #3748, Sub H, R2/R8). Captured
 * at commit 8c707fd9c. Do NOT edit — a change here silently alters what the
 * kill-switch restores AND the budget-test baseline (Task 9).
 *
 * The retired brand spelling inside it is DELIBERATE and exempt from brand
 * sweeps (issue #4544): this is a historical capture, not current prose. Its
 * content is pinned by sha256 in `tier0Budget.test.ts`, and
 * `scripts/check-brand-spelling.ts` allow-lists the two tokens by exact path +
 * literal — never put an inline allow-marker in the template, it would change
 * the frozen bytes.
 */
export const LEGACY_BASE_SYSTEM_PROMPT = (() =>
  trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__hapi__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.

    You can display images from the web inline in this chat using the "mcp__hapi__image_fetch" tool. When you want to show the user an image (e.g., from a web search, documentation, or any URL), call: mcp__hapi__image_fetch({ url: "https://example.com/image.jpg" }). The image will be fetched and displayed directly in the conversation. Supports JPEG, PNG, GIF, and WebP formats.

    Both "mcp__hapi__change_title" and "mcp__hapi__image_fetch" are guaranteed available in every spawned session. HAPImatic auto-removes "hapi" from this project's "disabledMcpServers" list in ~/.claude.json on every spawn (atomic, idempotent, non-fatal — see HAPImatic README "Auto-scrub of HAPI MCP server on spawn"). If you find these tools missing despite the guarantee, that indicates the spawn-time scrub failed silently; surface this loudly to the user rather than working around it.

    To register a provider API key conversationally (e.g. the user says "register my OpenRouter key" or "add my OpenAI key"), use the "mcp__hapi__register_service_key" tool. Always capture ONLY the provider plus an optional label / baseUrl / model and pass them as the tool arguments, and always let the secure entry card collect the secret, because a key pasted into the chat is stored in plaintext in the message transcript and transmitted to Anthropic — so you must never ask the user to paste the raw key into the conversation, and the tool deliberately has no key parameter. Always confirm the captured descriptor (provider + label) with the user before calling the tool, because calling it opens a secure card in their chat where they type the secret, which is sent straight to the server's key vault (never back through you). Always keep any secret you are ever shown masked, displaying at most the last 4 characters, because the raw secret must never appear in the conversation, your output, logs, or a tool result.

    When you receive a user message alongside a pending background task-notification (from the Agent tool's run_in_background feature), prioritize responding to the user's actual message. Do not respond to the task notification instead of the user's question. If a background task completed, you may briefly acknowledge it, but your primary response must fully address the user's message.

    Never use the AskUserQuestion tool. When you need user input on a choice, present options as a numbered list in your response text and ask the user to reply with their choice.
`))();

/**
 * (`:NN` below = line numbers of systemPrompt.ts at 8c707fd9c; the same
 * paragraphs are now LEGACY_BASE_SYSTEM_PROMPT's template above.)
 * Base system prompt with the `change_title` (:10) and `image_fetch` (:12) tool
 * paragraphs FOLDED OUT — they are now rows in the generated Tier-0 capability
 * table (issue #3748, R4). Kept OUTSIDE the Tier-0 budget, verbatim apart from
 * the #4544 brand respelling ("Hapimatic"): the
 * "guaranteed available / surface loudly" integrity paragraph (:14, which still
 * names both tools), the `register_service_key` security instruction (:16 —
 * whose plaintext-transcript warning and last-4-only masking rule appear NOWHERE
 * else in the tree), and the background-task (:18) and AskUserQuestion (:20)
 * paragraphs.
 */
const BASE_SYSTEM_PROMPT = (() =>
  trimIdent(`
    Both "mcp__hapi__change_title" and "mcp__hapi__image_fetch" are guaranteed available in every spawned session. Hapimatic auto-removes "hapi" from this project's "disabledMcpServers" list in ~/.claude.json on every spawn (atomic, idempotent, non-fatal — see Hapimatic README "Auto-scrub of HAPI MCP server on spawn"). If you find these tools missing despite the guarantee, that indicates the spawn-time scrub failed silently; surface this loudly to the user rather than working around it.

    To register a provider API key conversationally (e.g. the user says "register my OpenRouter key" or "add my OpenAI key"), use the "mcp__hapi__register_service_key" tool. Always capture ONLY the provider plus an optional label / baseUrl / model and pass them as the tool arguments, and always let the secure entry card collect the secret, because a key pasted into the chat is stored in plaintext in the message transcript and transmitted to Anthropic — so you must never ask the user to paste the raw key into the conversation, and the tool deliberately has no key parameter. Always confirm the captured descriptor (provider + label) with the user before calling the tool, because calling it opens a secure card in their chat where they type the secret, which is sent straight to the server's key vault (never back through you). Always keep any secret you are ever shown masked, displaying at most the last 4 characters, because the raw secret must never appear in the conversation, your output, logs, or a tool result.

    When you receive a user message alongside a pending background task-notification (from the Agent tool's run_in_background feature), prioritize responding to the user's actual message. Do not respond to the task notification instead of the user's question. If a background task completed, you may briefly acknowledge it, but your primary response must fully address the user's message.

    Never use the AskUserQuestion tool. When you need user input on a choice, present options as a numbered list in your response text and ask the user to reply with their choice.
`))();

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() =>
  trimIdent(`
    When making commit messages, you SHOULD also give credit to HAPI like so:

    <main commit message>

    via [HAPI](https://hapi.run)

    Co-Authored-By: HAPI <noreply@hapi.run>
`))();

/**
 * Detect the repository's default branch by checking origin/HEAD.
 * Returns null if not in a git repo or detection fails.
 */
function detectDefaultBranch(cwd: string): string | null {
  try {
    const result = execFileSync(
      "git",
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      {
        cwd,
        timeout: 5_000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    );
    // Result is like "refs/remotes/origin/dev" — extract the branch name
    const branch = result.trim().replace(/^refs\/remotes\/origin\//, "");
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Build the system prompt, optionally including repo-specific context.
 * When cwd is provided, detects the actual default branch and injects it
 * to override Claude Code's built-in heuristic (which defaults to "main").
 */
export function buildSystemPrompt(cwd?: string): string {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();

  // Issue #3748 (Sub H, R4/R8): with Tier-0 injection ON (default) the folded
  // base + the live-rendered capability catalog; with HAPI_CAPABILITY_TIER0=0
  // the frozen pre-H prompt restored byte-for-byte. renderTier0 is called live
  // (not the committed snapshot). Issue #3749 (Sub I, R4): this is the CLAUDE
  // launch path, so the Tier-0 render is varied for `agentId: "claude"` (drops
  // any Codex-only entry) at `scope: "user"` — Tier-0 is never operator-scoped
  // (R4a), and the cli cannot derive operator scope, so it fail-closes to user.
  let prompt = configuration.capabilityTier0Enabled
    ? BASE_SYSTEM_PROMPT +
      "\n\n" +
      renderTier0(capabilityCatalogIndex, { agentId: "claude", scope: "user" })
    : LEGACY_BASE_SYSTEM_PROMPT;

  if (includeCoAuthored) {
    prompt += "\n\n" + CO_AUTHORED_CREDITS;
  }

  if (cwd) {
    const defaultBranch = detectDefaultBranch(cwd);
    if (defaultBranch) {
      prompt +=
        "\n\n" +
        trimIdent(`
          gitStatus: The default branch for this repository is "${defaultBranch}".
          When creating pull requests, always target "${defaultBranch}" as the base branch unless explicitly told otherwise.
      `);
    }
  }

  return prompt;
}

// Issue #3749 (Sub I, R4 / Task 5): the eager `export const systemPrompt =
// buildSystemPrompt()` was REMOVED. It was evaluated at import with NO context,
// baking a "no context" Tier-0; once the prompt varies per session, any caller
// reading that constant would silently get a wrongly-filtered prompt. It had
// zero consumers (verified repo-wide), so removal is clean — every path calls
// `buildSystemPrompt(cwd)` live.

/**
 * Resolve the SDK `customSystemPrompt` / `appendSystemPrompt` pair so the
 * resolved base prompt (and its Tier-0 block) is injected EXACTLY ONCE (issue
 * #3748, Sub H, R4b). `claudeRemote` previously folded `resolvedSystemPrompt`
 * into BOTH fields, so with a `customSystemPrompt` set the base reached
 * `--system-prompt` AND `--append-system-prompt` (`sdk/query.ts:678-681`) —
 * doubling the prompt, and post-H doubling Tier-0 on the very path the budget
 * protects.
 *
 * When a `customSystemPrompt` is present it carries the base (→ `--system-prompt`)
 * and the caller's raw append value passes through untouched; otherwise the base
 * rides the append value (→ `--append-system-prompt`).
 */
export function resolveSdkSystemPrompts(
  mode: { customSystemPrompt?: string; appendSystemPrompt?: string },
  resolvedSystemPrompt: string | undefined
): {
  customSystemPrompt: string | undefined;
  appendSystemPrompt: string | undefined;
} {
  const join = (base: string | undefined): string | undefined => {
    if (base && resolvedSystemPrompt) {
      return base + "\n\n" + resolvedSystemPrompt;
    }
    return base ?? resolvedSystemPrompt;
  };
  const hasCustom = Boolean(mode.customSystemPrompt);
  return {
    customSystemPrompt: mode.customSystemPrompt
      ? join(mode.customSystemPrompt)
      : undefined,
    appendSystemPrompt: hasCustom
      ? mode.appendSystemPrompt
      : join(mode.appendSystemPrompt),
  };
}
