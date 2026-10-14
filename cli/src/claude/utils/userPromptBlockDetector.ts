// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detects UserPromptSubmit hook block messages in the session's JSONL
 * transcript and reports them to the server's error log system via
 * logger.reportError().
 *
 * Sibling of ToolErrorDetector (#1078): tool errors arrive as
 * tool_result.is_error: true on USER messages; UserPromptSubmit hook blocks
 * arrive as SYSTEM messages with subtype "informational", level "warning",
 * and content starting with "UserPromptSubmit operation blocked by hook:".
 *
 * The message shape originates in Claude Code's
 * utils/processUserInput/processUserInput.ts:195, which wraps the formatted
 * block message (utils/hooks.ts:1939 — getUserPromptSubmitHookBlockingMessage)
 * with the original prompt and emits via createSystemMessage(...). Issue #1348.
 *
 * Single-session contract: each instance is intended to live for the lifetime
 * of one session scanner. Launchers with crash-restart loops (claudeRemote)
 * MUST call reset() between attempts to prevent stale dedup state from a
 * previous run from suppressing legitimate new blocks.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";

const MAX_BLOCKED_LENGTH = 2000;
const MAX_PROMPT_LENGTH = 500;
const DEDUP_WINDOW_MS = 3000;
const CONTENT_KEY_LENGTH = 200;

const BLOCK_PREFIX = "UserPromptSubmit operation blocked by hook:";
const ORIGINAL_PROMPT_MARKER = "Original prompt:";

export class UserPromptBlockDetector {
  /** Tracks already-reported message uuids to avoid duplicates */
  private readonly reportedUuids = new Set<string>();
  /** Maps content prefix → last-seen timestamp (ms) for content debounce */
  private readonly recentBlocks = new Map<string, number>();

  constructor() {}

  /**
   * Clear internal state. Call between session attempts in launchers with
   * crash-restart loops to prevent stale dedup entries from suppressing
   * legitimate new blocks in the next run.
   */
  reset(): void {
    this.reportedUuids.clear();
    this.recentBlocks.clear();
  }

  /**
   * Process a parsed JSONL message. Call this for every message emitted by
   * the session scanner or SDK-to-log converter.
   *
   * For system messages with subtype "informational" and content starting
   * with the UserPromptSubmit block prefix, report the block to the error
   * log system (subject to uuid + content-debounce dedup).
   *
   * For all other message types, no-op.
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;
    if (message.type !== "system") return;

    const msg = message as unknown as Record<string, unknown>;
    const subtype = msg.subtype;
    const content = msg.content;
    const uuid = msg.uuid;

    if (subtype !== "informational") return;
    if (typeof content !== "string") return;
    if (typeof uuid !== "string") return;
    if (!content.startsWith(BLOCK_PREFIX)) return;

    if (this.reportedUuids.has(uuid)) return;

    const now = Date.now();
    const contentKey = content.slice(0, CONTENT_KEY_LENGTH);
    const lastSeen = this.recentBlocks.get(contentKey);
    if (lastSeen !== undefined && now - lastSeen < DEDUP_WINDOW_MS) {
      // Identical content within debounce window — suppress, but record the
      // uuid so a re-feed of the same message won't trigger a redundant
      // dedup-check cycle later.
      this.reportedUuids.add(uuid);
      return;
    }

    this.reportedUuids.add(uuid);
    this.recentBlocks.set(contentKey, now);
    this.pruneRecentBlocks(now);

    const { blockedReason, originalPrompt } = parseBlockContent(content);

    const context: Record<string, unknown> = {
      hookEvent: "UserPromptSubmit",
      blockedReason: blockedReason.slice(0, MAX_BLOCKED_LENGTH),
      originalPrompt: originalPrompt
        ? originalPrompt.slice(0, MAX_PROMPT_LENGTH)
        : null,
    };

    logger.reportError({
      message: `UserPromptSubmit hook block: ${blockedReason.slice(0, 200)}`,
      category: "prompt-blocked",
      severity: "warn",
      sessionId,
      context: JSON.stringify(context),
    });
  }

  /**
   * Drop debounce-map entries older than 2× the dedup window so the map
   * doesn't grow unbounded across a long session. Called opportunistically
   * after each detected block (not on every message — the early-return
   * checks above mean processMessage is hot for non-block messages).
   */
  private pruneRecentBlocks(now: number): void {
    const threshold = DEDUP_WINDOW_MS * 2;
    for (const [key, ts] of this.recentBlocks) {
      if (now - ts > threshold) {
        this.recentBlocks.delete(key);
      }
    }
  }
}

interface ParsedBlock {
  blockedReason: string;
  originalPrompt: string | null;
}

/**
 * Parse the system-message content emitted by Claude Code's
 * processUserInput.ts:195:
 *
 *   UserPromptSubmit operation blocked by hook:
 *   <hook-stderr or executor-built reason — multi-line allowed>
 *
 *   Original prompt: <user input>
 *
 * Returns blockedReason (everything between the header and the Original
 * prompt marker, trimmed of leading/trailing blank lines) and originalPrompt
 * (the rest of the Original prompt line + everything after, trimmed). If
 * no Original prompt marker is present, blockedReason is all post-header
 * content and originalPrompt is null.
 */
function parseBlockContent(content: string): ParsedBlock {
  const lines = content.split("\n");
  // lines[0] is the BLOCK_PREFIX header — skip it.
  const promptIdx = lines.findIndex(line =>
    line.startsWith(ORIGINAL_PROMPT_MARKER)
  );

  if (promptIdx === -1) {
    const reasonLines = lines.slice(1);
    return {
      blockedReason: trimBlankBoundaries(reasonLines).join("\n"),
      originalPrompt: null,
    };
  }

  const reasonLines = lines.slice(1, promptIdx);
  const firstPromptLine = lines[promptIdx].slice(ORIGINAL_PROMPT_MARKER.length);
  const restPrompt = lines.slice(promptIdx + 1);
  const promptText = [firstPromptLine, ...restPrompt].join("\n").trim();

  return {
    blockedReason: trimBlankBoundaries(reasonLines).join("\n"),
    originalPrompt: promptText === "" ? null : promptText,
  };
}

function trimBlankBoundaries(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}
