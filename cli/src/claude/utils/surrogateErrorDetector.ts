// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detects the unrecoverable UTF-16 surrogate-truncation death-loop (issue #1604).
 *
 * Claude Code's compaction truncates injected skill content via a raw UTF-16
 * `content.slice(0, charBudget)` (services/compact/compact.ts → truncateToTokens),
 * with no surrogate-pair guard. When the cut lands between the two halves of an
 * emoji surrogate pair, a lone high surrogate is left at the tail. A lone
 * surrogate is invalid in a JSON string (RFC 8259), so the Anthropic API server
 * rejects the next request body with `400 ... no low surrogate in string`. The
 * poisoned content is persisted in the conversation history, so EVERY subsequent
 * request re-sends the same invalid body — the session is stuck in a silent
 * infinite-retry loop burning tokens until killed.
 *
 * As of Claude Code 2.1.170 (the latest release) the truncation slice is still
 * surrogate-unaware, so this is a live, unfixed upstream defect. Hapimatic cannot
 * fix the truncation — this detector recognizes the repeating surrogate-400 in the
 * message stream Hapimatic already processes and lets the launcher break the loop
 * (terminate cleanly + notify loudly) instead of burning tokens.
 *
 * The surrogate-400 surfaces in TWO shapes depending on launcher:
 *   1. SDK launcher — a synthetic `{ type: "system", subtype: "api_error",
 *      error: { statusCode: 400, message/body: "...no low surrogate..." } }`
 *      injected by parseStderrApiError() (cli/src/claude/sdk/query.ts).
 *   2. Transcript launchers (pty/tmux/local) — an `{ type: "assistant",
 *      isApiErrorMessage: true, apiErrorStatus: 400, message: { content: [{ type:
 *      "text", text: "API Error: 400 ... no low surrogate ..." }] } }` entry read
 *      by the session scanner.
 *
 * Wired into all launchers at the existing `.processMessage()` seam, alongside
 * ToolErrorDetector / UserPromptBlockDetector / cronUsageDetector. The launcher
 * provides the `onUnrecoverableLoop` callback (terminate + loud notify) so this
 * class stays launcher-agnostic.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";

/**
 * The precise server-side error substrings that identify a surrogate-pair JSON
 * validation failure. Matching ONLY these (gated by HTTP status 400) is what
 * keeps the detector from firing on unrelated 400s / 429 / 500 / 529 errors.
 *
 * If Anthropic ever rewords these, detection silently stops — this is the single
 * point to update, and surrogateErrorDetector.test.ts pins the expected strings.
 */
export const SURROGATE_400_SUBSTRINGS = [
  "no low surrogate in string",
  "no high surrogate in string",
];

/**
 * Number of consecutive surrogate-400s (with no intervening successful result)
 * required before the loop is declared unrecoverable. The real #1604 failure
 * showed exactly 2 occurrences before manual kill; the issue specifies
 * "≥ 2 consecutive identical occurrences". This bounds token burn to ~2 retries.
 */
export const MAX_CONSECUTIVE_SURROGATE_400 = 2;

const MAX_ERROR_LENGTH = 2000;

/**
 * The loud, user-facing session-chat message shown when the loop is broken.
 * Shared across all launchers so the wording stays in sync.
 */
export const SURROGATE_LOOP_USER_MESSAGE =
  "Session terminated: a Claude Code compaction bug corrupted the conversation history " +
  "(a UTF-16 surrogate pair was split during skill-content truncation, producing an " +
  "invalid-JSON `400 no low surrogate in string` error). Hapimatic stopped the session " +
  "to prevent an unbounded token-burning retry loop. To recover, use --resume from before " +
  "the corrupting compaction, or branch the session. (issue #1604)";

export class SurrogateErrorDetector {
  /** Count of consecutive surrogate-400s since the last successful result. */
  private consecutive = 0;
  /** Latch so onUnrecoverableLoop + reportError fire exactly once per loop. */
  private fired = false;

  /**
   * @param onUnrecoverableLoop Launcher-provided handler invoked once when the
   *   recurrence threshold is reached. The launcher wires this to terminate the
   *   session cleanly (NOT restart — the poison is persisted) and surface the
   *   event loudly (session chat message). `errorText` is the matched API error
   *   text for inclusion in the user-facing notification.
   */
  constructor(
    private readonly onUnrecoverableLoop: (
      sessionId: string,
      errorText: string
    ) => void
  ) {}

  /**
   * Process a parsed JSONL/SDK-converted message. Call for every message emitted
   * by the session scanner or SDK-to-log converter (same seam as ToolErrorDetector).
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;

    const hit = matchSurrogate400(message);
    if (hit !== null) {
      this.consecutive++;
      if (this.consecutive >= MAX_CONSECUTIVE_SURROGATE_400 && !this.fired) {
        this.fired = true;
        const errorText = hit.slice(0, MAX_ERROR_LENGTH);
        logger.reportError({
          message: `Surrogate-400 compaction death-loop detected (${this.consecutive}× consecutive) — terminating session (issue #1604)`,
          category: "surrogate-loop",
          severity: "error",
          sessionId,
          context: JSON.stringify({
            consecutive: this.consecutive,
            errorText,
          }),
        });
        this.onUnrecoverableLoop(sessionId, errorText);
      }
      return;
    }

    // Reset the streak on any genuine forward-progress signal so a single,
    // transient 400 never accumulates across unrelated turns (R5). A successful
    // result or a normal (non-api-error) assistant message both indicate the
    // session is producing real output — i.e. the poison loop is NOT active.
    if (isSuccessSignal(message)) {
      this.consecutive = 0;
    }
    // Intermediate messages (user, tool_use, progress, etc.) leave the counter
    // unchanged — they are neither a surrogate-400 nor a success boundary.
  }

  /**
   * Clear internal state. Call between session attempts in launchers with
   * crash-restart loops (mirrors the sibling detectors' reset() contract).
   */
  reset(): void {
    this.consecutive = 0;
    this.fired = false;
  }
}

/**
 * Returns the matching error text if `message` is a surrogate-400 in either
 * surfacing shape, else null. Reads passthrough/optional fields defensively.
 */
function matchSurrogate400(message: RawJSONLines): string | null {
  const msg = message as Record<string, unknown>;

  // Shape A — transcript assistant synthetic error (pty/tmux/local via scanner)
  if (
    msg.type === "assistant" &&
    msg.isApiErrorMessage === true &&
    msg.apiErrorStatus === 400
  ) {
    const text = extractAssistantText(msg.message);
    if (containsSurrogateSubstring(text)) return text;
  }

  // Shape B — SDK synthetic system/api_error (injected by parseStderrApiError)
  if (msg.type === "system" && msg.subtype === "api_error") {
    const error = msg.error as Record<string, unknown> | undefined;
    if (error && error.statusCode === 400) {
      const text = String(error.message ?? error.body ?? "");
      if (containsSurrogateSubstring(text)) return text;
    }
  }

  return null;
}

/**
 * A turn-terminating success signal that resets the consecutive counter:
 *  - a result message (SDK converts to system/subtype:"result") with is_error falsy
 *  - a normal assistant message (NOT an API error) — real model output
 */
function isSuccessSignal(message: RawJSONLines): boolean {
  const msg = message as Record<string, unknown>;
  if (
    msg.type === "system" &&
    msg.subtype === "result" &&
    msg.is_error !== true
  ) {
    return true;
  }
  if (msg.type === "assistant" && msg.isApiErrorMessage !== true) {
    return true;
  }
  return false;
}

function containsSurrogateSubstring(text: string): boolean {
  if (!text) return false;
  return SURROGATE_400_SUBSTRINGS.some(sub => text.includes(sub));
}

/** Concatenate the text of an assistant message's content blocks. */
function extractAssistantText(inner: unknown): string {
  if (!inner || typeof inner !== "object") return "";
  const content = (inner as Record<string, unknown>).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(block => {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
