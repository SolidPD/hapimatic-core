// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Detects tool call errors from JSONL session messages and reports them
 * to the server's error log system via logger.reportError().
 *
 * Maintains a map of tool_use_id → {name, input} from assistant messages
 * so that when a tool_result with is_error: true is encountered, the
 * tool name and input can be included in the error report.
 *
 * Single-session contract: each instance is intended to live for the lifetime
 * of one session scanner. Launchers with crash-restart loops (claudeRemote)
 * MUST call reset() between attempts to prevent orphaned tool_use_ids from
 * a previous run from poisoning subsequent error reports.
 */

import type { RawJSONLines } from "../types";
import { logger } from "@/ui/logger";

const MAX_INPUT_LENGTH = 500;
const MAX_ERROR_LENGTH = 2000;

type ToolUseInfo = {
  name: string;
  input: unknown;
};

export class ToolErrorDetector {
  /** Maps tool_use_id → tool name and input from assistant messages */
  private readonly toolUseMap = new Map<string, ToolUseInfo>();
  /** Tracks already-reported tool_use_ids to avoid duplicates */
  private readonly reportedIds = new Set<string>();

  constructor() {}

  /**
   * Clear internal state. Call between session attempts in launchers with
   * crash-restart loops to prevent orphaned entries from poisoning the next
   * run.
   */
  reset(): void {
    this.toolUseMap.clear();
    this.reportedIds.clear();
  }

  /**
   * Process a parsed JSONL message. Call this for every message
   * emitted by the session scanner or SDK-to-log converter.
   *
   * For assistant messages: indexes tool_use blocks into the map.
   * For user messages: checks for tool_result blocks with is_error: true
   * and reports them to the error log system.
   */
  processMessage(message: RawJSONLines, sessionId: string | null): void {
    if (!sessionId) return;
    if (message.type === "assistant") {
      this.indexToolUseBlocks(message);
    } else if (message.type === "user") {
      this.checkToolResults(message, sessionId);
    }
  }

  private indexToolUseBlocks(message: RawJSONLines): void {
    const msg = message as Record<string, unknown>;
    const inner = msg.message as Record<string, unknown> | undefined;
    if (!inner) return;

    const content = inner.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        this.toolUseMap.set(block.id, {
          name: block.name,
          input: block.input,
        });
      }
    }
  }

  private checkToolResults(message: RawJSONLines, sessionId: string): void {
    const msg = message as Record<string, unknown>;
    const inner = msg.message as Record<string, unknown> | undefined;
    if (!inner) return;

    const content = inner.content;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        if (block.is_error === true) {
          this.reportToolError(block, sessionId);
        }
        // Free memory: each tool_use_id gets exactly one tool_result
        this.toolUseMap.delete(block.tool_use_id);
      }
    }
  }

  private reportToolError(
    block: Record<string, unknown>,
    sessionId: string
  ): void {
    const toolUseId = block.tool_use_id as string;

    // Dedup: only report each tool_use_id once
    if (this.reportedIds.has(toolUseId)) return;
    this.reportedIds.add(toolUseId);

    const toolInfo = this.toolUseMap.get(toolUseId);
    const toolName = toolInfo?.name ?? "unknown";

    // Extract error content as string
    const errorContent = extractErrorContent(block.content);

    // Build structured context
    const context: Record<string, unknown> = {
      toolName,
      toolUseId,
      errorContent: errorContent.slice(0, MAX_ERROR_LENGTH),
    };

    if (toolInfo?.input != null) {
      context.input = truncateInput(toolInfo.input);
    }

    logger.reportError({
      message: `Tool error: ${toolName} — ${errorContent.slice(0, 200)}`,
      category: "tool-error",
      severity: "warn",
      sessionId,
      context: JSON.stringify(context),
    });
  }
}

function extractErrorContent(content: unknown): string {
  if (!content) return "[no error content]";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const joined = content
      .map(item => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return joined === "" ? "[no error content]" : joined;
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "[unserializable content]";
    }
  }
  return "[no error content]";
}

function truncateInput(input: unknown): unknown {
  try {
    const serialized = JSON.stringify(input);
    if (serialized.length <= MAX_INPUT_LENGTH) return input;
    return serialized.slice(0, MAX_INPUT_LENGTH) + "…";
  } catch {
    return "[unserializable input]";
  }
}
