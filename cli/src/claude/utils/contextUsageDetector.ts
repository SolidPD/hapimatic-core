// SPDX-License-Identifier: MIT
/**
 * Issue #1488 (Gap 2): surfaces a first-order model-name + context-window indicator
 * for the PTY/tmux launchers, which cannot use the SDK `get_context_usage`
 * control_request (it requires `--input-format stream-json`, a FORBIDDEN_CLAUDE_ARG
 * that would flip the session to Agent-SDK billing).
 *
 * Source: the JSONL session transcript the scanner already reads. Each assistant
 * message carries `message.model` (the bare resolved id, e.g. "claude-opus-4-8") and
 * `message.usage` (input + cache token counts). From these we derive:
 *   - resolvedModel       = message.model
 *   - contextUsedTokens   = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 *   - contextWindowTokens = the spawn-resolved window (passed in at construction —
 *     `[1m]` → 1M, else 200k; see `resolveContextWindowForModel`)
 *   - contextPercentage   = round(used / window * 100)
 *
 * The derived values feed `session.onContextUsage`, which propagates them via keepAlive
 * to the web UI (model display + context tier) AND to the #1509 model-downgrade detector
 * (`isModelDowngraded` keys on resolvedModel/contextWindowTokens) — the launcher-agnostic
 * backstop that, without this detector, is blind on the non-SDK launchers.
 *
 * Sibling of ToolErrorDetector / CronUsageDetector: wired into the same scanner
 * `onMessage` callback. No reset() needed — latest-assistant-message wins.
 */

import type { RawJSONLines } from "../types";

export interface ContextUsage {
  resolvedModel: string;
  contextWindowTokens: number;
  contextUsedTokens: number;
  contextPercentage: number;
}

export class ContextUsageDetector {
  private readonly contextWindowTokens: number | undefined;
  private readonly onContextUsage: (usage: ContextUsage) => void;

  constructor(opts: {
    /**
     * Effective context window resolved from the spawn `--model` string, or
     * `undefined` when no model was pinned (the host-credential path). When
     * `undefined`, the detector is a no-op — it never asserts a context window
     * it cannot know.
     */
    contextWindowTokens: number | undefined;
    onContextUsage: (usage: ContextUsage) => void;
  }) {
    this.contextWindowTokens = opts.contextWindowTokens;
    this.onContextUsage = opts.onContextUsage;
  }

  /**
   * Process a parsed JSONL message. On an assistant message that carries both a
   * model id and a usage block (and only when a context window is known), derive
   * the context-usage snapshot and emit it. All other messages no-op.
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;
    if (this.contextWindowTokens === undefined) return;
    if (message.type !== "assistant") return;

    const inner = (message as Record<string, unknown>).message as
      | Record<string, unknown>
      | undefined;
    if (!inner) return;

    const model = inner.model;
    if (typeof model !== "string" || model === "") return;

    const usage = inner.usage as Record<string, unknown> | undefined;
    if (!usage) return;

    const input = numField(usage.input_tokens);
    const cacheCreate = numField(usage.cache_creation_input_tokens);
    const cacheRead = numField(usage.cache_read_input_tokens);
    // input + cache = the prompt size entering the turn, i.e. the context window
    // occupied. This is the same quantity Claude Code's get_context_usage reports
    // as totalTokens.
    const used = input + cacheCreate + cacheRead;
    if (used <= 0) return;

    const window = this.contextWindowTokens;
    const pct = Math.min(100, Math.round((used / window) * 100));

    this.onContextUsage({
      resolvedModel: model,
      contextWindowTokens: window,
      contextUsedTokens: used,
      contextPercentage: pct,
    });
  }
}

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
