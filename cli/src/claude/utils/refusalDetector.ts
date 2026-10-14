// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detects model content-policy refusals so they surface visibly in the chat
 * thread instead of leaving a dead-looking session (issue #1633).
 *
 * Anthropic's Fable model has aggressive content-sensitivity triggers: when a
 * prompt (or its preamble — CLAUDE.md, skills, hooks, MCP descriptions) trips
 * one, the API ends the turn with `stop_reason: "refusal"`. The transcript
 * record for such a turn (captured live from a real Fable block on
 * 2026-06-10) is an ASSISTANT record whose `message.stop_reason` is
 * `"refusal"` and whose content carries only a thinking block — NO text
 * block. The session scanner forwards it to the web, but nothing
 * user-visible renders, and nothing else turn-related is written to the
 * transcript afterward — so the session simply looks hung.
 *
 * NOTE this is NOT the empty-result-bounce class (claudeRemote.ts): a refusal
 * has real API duration and usage, so the bounce path never sees it. Detection
 * keys on the assistant record itself, which is shared by ALL launchers:
 *   - Transcript launchers (pty/tmux/local) — the scanner forwards the raw
 *     JSONL assistant record (Zod `.passthrough()` preserves `stop_reason`).
 *   - SDK launcher — the SDK-to-log converter emits the same assistant shape
 *     with the API message (and its `stop_reason`) embedded.
 *
 * Wired into all launchers at the existing `.processMessage()` seam, alongside
 * ToolErrorDetector / CronUsageDetector / SurrogateErrorDetector. The launcher
 * provides the `onRefusal` callback (notify-only — a refusal is per-turn and
 * recoverable, unlike the surrogate loop's persisted poison, so the session
 * must NOT be terminated) so this class stays launcher-agnostic.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";

/** Defensive cap on the seen-uuid dedup set (scanner re-scan protection). */
const MAX_SEEN_UUIDS = 500;

/**
 * The user-facing session-chat message shown when a refusal is detected.
 * Shared across all launchers so the wording stays in sync.
 */
export function buildRefusalUserMessage(model: string | null): string {
  const who = model ? `\`${model}\`` : "The model";
  return (
    `⛔ ${who} refused this prompt (content-sensitivity block, ` +
    `stop_reason: refusal). The turn produced no response — this is a ` +
    `model-side safety trigger, not a session failure. Rephrase the prompt, ` +
    `or switch models for this request. (issue #1633)`
  );
}

export class RefusalDetector {
  /** Records already notified, keyed by transcript uuid (replay dedup). */
  private seen = new Set<string>();

  /**
   * @param onRefusal Launcher-provided handler invoked once per refusal
   *   record. The launcher wires this to surface a visible chat event
   *   (sendSessionEvent) — notify-only, never terminate. `model` is the
   *   refusing model id from the record (e.g. "claude-fable-5"), or null
   *   when absent.
   */
  constructor(
    private readonly onRefusal: (
      sessionId: string,
      model: string | null
    ) => void
  ) {}

  /**
   * Process a parsed JSONL/SDK-converted message. Call for every message
   * emitted by the session scanner or SDK-to-log converter (same seam as
   * ToolErrorDetector).
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;

    const msg = message as Record<string, unknown>;
    if (msg.type !== "assistant") return;

    const inner = msg.message as Record<string, unknown> | undefined;
    if (!inner || inner.stop_reason !== "refusal") return;

    const uuid = typeof msg.uuid === "string" ? msg.uuid : null;
    if (uuid) {
      if (this.seen.has(uuid)) return;
      if (this.seen.size >= MAX_SEEN_UUIDS) this.seen.clear();
      this.seen.add(uuid);
    }

    const model = typeof inner.model === "string" ? inner.model : null;
    logger.reportError({
      message: `Model refusal detected (stop_reason: refusal) — surfacing to chat (issue #1633)`,
      category: "model-refusal",
      severity: "warn",
      sessionId,
      context: JSON.stringify({ model, uuid }),
    });
    this.onRefusal(sessionId, model);
  }

  /**
   * Clear internal state. Call between session attempts in launchers with
   * crash-restart loops (mirrors the sibling detectors' reset() contract).
   */
  reset(): void {
    this.seen.clear();
  }
}
