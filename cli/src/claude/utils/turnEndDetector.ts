// SPDX-License-Identifier: MIT
/**
 * Clears the web "thinking" status dot on a clean turn-end under the tmux/pty
 * launchers (issue #1742).
 *
 * Why this exists: under the tmux/pty launchers the "thinking" dot is driven by
 * Claude Code lifecycle hooks (#1611) — `UserPromptSubmit` → thinking=true,
 * `Stop` → thinking=false. The clear depends ENTIRELY on the `Stop` hook, which
 * is delivered out-of-process (the `claude` TUI in tmux runs a
 * `hapi hook-forwarder` subprocess that POSTs to the wrapper's local hook
 * server) and is NOT reliably delivered on every clean turn-end. When the clear
 * is lost, `session.thinking` stays `true` and the 2s keepAlive re-sends it
 * forever, so the dot is pinned blue while the session is provably idle (the
 * ~1h39m repro in #1742). This is the same failure class #1647 documented for
 * the 429 case (`rateLimitDetector.ts`).
 *
 * The SDK launcher is immune because it derives the clear from the structured
 * message stream (`claudeRemote.ts` `result → updateThinking(false)`). The
 * tmux/pty launchers already tail the on-disk transcript via the session
 * scanner but never derive the turn-end clear from it. This detector closes
 * that asymmetry: when the scanner emits a CLEAN turn-end record, it calls back
 * to clear thinking. It AUGMENTS the `Stop` hook (Fallback Preservation Rule —
 * the hook stays the fast path; the transcript is the reliable fallback),
 * exactly as #1647's RateLimitDetector did for the 429 case.
 *
 * The clean-turn-end signal (empirically validated against 25 live transcripts):
 *   type === "assistant"
 *     && message.stop_reason ∈ { "end_turn", "stop_sequence" }
 *     && content has NO block of type "tool_use"
 *     && message.model !== "<synthetic>"
 *
 * Each gate, and why:
 *   - Claude Code splits ONE API response into per-content-block transcript
 *     entries (`[thinking]`/`[text]`/`[tool_use]`) sharing one `stop_reason`. A
 *     tool-calling response carries `stop_reason: "tool_use"` on every fragment,
 *     so the terminal-stop_reason gate excludes all mid-turn fragments (keeps
 *     "thinking" while a turn is in flight — R2 / no #1611 regression).
 *   - Hapimatic transcripts also contain SYNTHETIC tool-call records
 *     (`model: "<synthetic>"`, no `requestId`, `stop_reason: "stop_sequence"`,
 *     `content: [tool_use]`). Each is a tool call always followed by a
 *     `tool_result` — never an idle point. The no-tool_use gate excludes every
 *     one; the `model !== "<synthetic>"` gate is belt-and-suspenders.
 *   - A genuine mid-turn kill / hang (#1661) leaves the last meaningful record
 *     as a `tool_use` response or a synthetic tool call (pending tool) — NOT a
 *     clean turn-end — so the detector does not fire and the zombie still
 *     surfaces (R4 / no #1661 masking).
 *   - If a real turn-end is split into `[thinking]` + `[text]` fragments, both
 *     match and the clear fires twice — idempotent (`false → false`).
 *
 * The clear is fired clear-ONLY: turn START stays on the `UserPromptSubmit` hook
 * (#1611). This class never sets thinking=true (R3).
 *
 * Wired into the tmux/pty launchers at the existing `.processMessage()` seam,
 * alongside RateLimitDetector / RefusalDetector. The launcher provides the
 * `onTurnEnd` callback (wired to `session.onThinkingChange(false)`) so this
 * class stays launcher-agnostic.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";

/** Defensive cap on the seen-uuid dedup set (scanner re-scan protection). */
const MAX_SEEN_UUIDS = 500;

/** Terminal stop_reason values that mark a clean (non-mid-turn) turn-end. */
const TURN_END_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

/** Synthetic-record model sentinel — these are tool-call records, never idle. */
const SYNTHETIC_MODEL = "<synthetic>";

export class TurnEndDetector {
  /** Records already fired, keyed by transcript uuid (replay dedup). */
  private seen = new Set<string>();

  /**
   * @param onTurnEnd Launcher-provided handler invoked once per clean turn-end
   *   record. Launchers wire this to `() => session.onThinkingChange(false)` —
   *   clear-only, never sets thinking true (turn-start stays on the
   *   `UserPromptSubmit` hook, #1611 / R3).
   */
  constructor(private readonly onTurnEnd: (sessionId: string) => void) {}

  /**
   * Process a parsed JSONL/SDK-converted message. Call for every message emitted
   * by the session scanner (same seam as ToolErrorDetector / RateLimitDetector).
   * Reads passthrough fields defensively (RawJSONLines is `.passthrough()`;
   * these fields are untyped).
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;

    const msg = message as Record<string, unknown>;
    if (msg.type !== "assistant") return;

    const inner = msg.message as Record<string, unknown> | undefined;
    if (!inner) return;

    // Terminal stop_reason — excludes every `tool_use` mid-turn fragment.
    if (
      typeof inner.stop_reason !== "string" ||
      !TURN_END_STOP_REASONS.has(inner.stop_reason)
    ) {
      return;
    }

    // Defensive: exclude synthetic tool-call records (model "<synthetic>",
    // stop_reason "stop_sequence", tool_use content).
    if (inner.model === SYNTHETIC_MODEL) return;

    // A genuine turn-end yields to the user — no pending tool call.
    if (
      Array.isArray(inner.content) &&
      inner.content.some(
        block =>
          block != null &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_use"
      )
    ) {
      return;
    }

    const uuid = typeof msg.uuid === "string" ? msg.uuid : null;
    if (uuid) {
      if (this.seen.has(uuid)) return;
      if (this.seen.size >= MAX_SEEN_UUIDS) this.seen.clear();
      this.seen.add(uuid);
    }

    // High-frequency signal — debug, not reportError (unlike RefusalDetector,
    // which surfaces a user-facing warning).
    logger.debug(
      `[turnEndDetector]: clean turn-end for session ${sessionId} ` +
        `(stop_reason: ${inner.stop_reason}) — clearing thinking (issue #1742)`
    );
    this.onTurnEnd(sessionId);
  }

  /**
   * Clear internal state. Call between session attempts in launchers with
   * crash-restart loops (mirrors the sibling detectors' reset() contract).
   */
  reset(): void {
    this.seen.clear();
  }
}
