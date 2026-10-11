// SPDX-License-Identifier: MIT
/**
 * Converter from SDK message types to log format (RawJSONLines)
 * Transforms Claude SDK messages into the format expected by session logs
 */

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
} from "@/claude/sdk";
import type { RawJSONLines } from "@/claude/types";
import type { ClaudePermissionMode } from "@hapi/protocol/types";

/**
 * Extended log message type that includes extra fields added during SDK→log conversion.
 * RawJSONLines uses Zod's .passthrough(), so these extra fields are valid at runtime
 * but not represented in the inferred TypeScript type.
 */
interface ExtendedLogFields {
  mode?: ClaudePermissionMode;
  requestId?: unknown;
  subtype?: string;
  model?: string;
  tools?: string[];
  toolUseResult?: unknown;
  isTaskNotification?: boolean;
  [key: string]: unknown;
}

export type ExtendedRawJSONLines = RawJSONLines & ExtendedLogFields;

/** Shape of a tool_result SDK message (not part of the standard SDKMessage union) */
interface SDKToolResultMessage extends SDKMessage {
  type: "tool_result";
  tool_use_id?: string;
  content?: unknown;
}

/**
 * Context for converting SDK messages to log format
 */
export interface ConversionContext {
  sessionId: string;
  cwd: string;
  version?: string;
  gitBranch?: string;
  parentUuid?: string | null;
}

type PermissionResponse = {
  approved: boolean;
  mode?: ClaudePermissionMode;
  reason?: string;
};

/**
 * Get current git branch for the working directory
 */
function getGitBranch(cwd: string): string | undefined {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

/**
 * SDK to Log converter class
 * Maintains state for parent-child relationships between messages
 */
export class SDKToLogConverter {
  private lastUuid: string | null = null;
  private context: ConversionContext;
  private responses?: Map<string, PermissionResponse>;
  private sidechainLastUUID = new Map<string, string>();

  constructor(
    context: Omit<ConversionContext, "parentUuid">,
    responses?: Map<string, PermissionResponse>
  ) {
    this.context = {
      ...context,
      gitBranch: context.gitBranch ?? getGitBranch(context.cwd),
      version: context.version ?? process.env.npm_package_version ?? "0.0.0",
      parentUuid: null,
    };
    this.responses = responses;
  }

  /**
   * Update session ID (for when session changes during resume)
   */
  updateSessionId(sessionId: string): void {
    this.context.sessionId = sessionId;
  }

  /**
   * Reset parent chain (useful when starting new conversation)
   */
  resetParentChain(): void {
    this.lastUuid = null;
    this.context.parentUuid = null;
  }

  /**
   * Convert SDK message to log format
   */
  convert(sdkMessage: SDKMessage): RawJSONLines | null {
    const uuid = randomUUID();
    const timestamp = new Date().toISOString();
    let parentUuid = this.lastUuid;
    let isSidechain = false;
    const parentToolUseId = sdkMessage.parent_tool_use_id as string | undefined;
    if (parentToolUseId) {
      isSidechain = true;
      parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? this.lastUuid;
      this.sidechainLastUUID.set(parentToolUseId, uuid);
    }
    const baseFields = {
      parentUuid: parentUuid,
      isSidechain: isSidechain,
      userType: "external" as const,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      version: this.context.version,
      gitBranch: this.context.gitBranch,
      uuid,
      timestamp,
    };

    let logMessage: ExtendedRawJSONLines | null = null;

    switch (sdkMessage.type) {
      case "user": {
        const userMsg = sdkMessage as SDKUserMessage;
        logMessage = {
          ...baseFields,
          type: "user",
          message: userMsg.message,
          // #2162: Claude Code flags hidden-from-UI meta user messages (stop-hook
          // feedback, system-reminder/caveat, transcript-only notes) on the SDK
          // wire as `isSynthetic`. Persist it as `isMeta` — the field Hapimatic's
          // downstream render/storage guards already understand — so the web
          // client can collapse it into a dimmed chip instead of leaking it into
          // the assistant column. Filter on the flag, not the "Stop hook feedback:"
          // text (that prefix is cosmetic — it only picks a nicer chip label).
          ...(userMsg.isSynthetic ? { isMeta: true } : {}),
        };

        // Check if this is a tool result and add mode if available
        if (Array.isArray(userMsg.message.content)) {
          for (const content of userMsg.message.content) {
            if (
              content.type === "tool_result" &&
              content.tool_use_id &&
              this.responses?.has(content.tool_use_id)
            ) {
              const response = this.responses.get(content.tool_use_id);
              if (response?.mode) {
                logMessage.mode = response.mode;
              }
            }
          }
        } else if (typeof userMsg.message.content === "string") {
          // Simple string content, no tool result
        }
        break;
      }

      case "assistant": {
        const assistantMsg = sdkMessage as SDKAssistantMessage;
        const rawAssistant = sdkMessage as Record<string, unknown>;
        logMessage = {
          ...baseFields,
          type: "assistant",
          message: assistantMsg.message,
          // Assistant messages often have additional fields
          requestId: assistantMsg.requestId,
          // #4936: Claude Code copies the API's `error.details.error_code` onto
          // the terminal API-error frame as `api_error_code` (documented in its
          // SDK schema so a host can key on a new server gate). Carry it, and
          // the HTTP status when present, so the spend-cap classifier can see
          // it. Deliberately NOT `is_api_error_message`: forwarding that flag
          // would switch on the auto-recovery ladder and the auth / surrogate /
          // rate-limit detectors for every API error on this launcher — a
          // fleet-wide change outside #4936. The older detectors (auth /
          // surrogate / rate-limit) read `apiErrorStatus` only behind
          // `isApiErrorMessage`, so they still ignore these fields here;
          // `extractApiLimitSignal` reads both on purpose.
          ...(typeof rawAssistant.api_error_code === "string"
            ? { apiErrorCode: rawAssistant.api_error_code }
            : {}),
          ...(typeof rawAssistant.api_error_status === "number" &&
          Number.isFinite(rawAssistant.api_error_status)
            ? { apiErrorStatus: rawAssistant.api_error_status }
            : {}),
        };
        // if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
        //     for (const content of assistantMsg.message.content) {
        //         if (content.type === 'tool_use' && content.id) {
        //             this.sidechainLastUUID.set(content.id, uuid);
        //         }
        //     }
        // }
        break;
      }

      case "system": {
        const systemMsg = sdkMessage as SDKSystemMessage;

        // System messages with subtype 'init' might update session ID
        if (systemMsg.subtype === "init" && systemMsg.session_id) {
          this.updateSessionId(systemMsg.session_id);
        }

        // System messages are typically not sent to logs
        // but we can convert them if needed
        logMessage = {
          ...baseFields,
          type: "system",
          subtype: systemMsg.subtype,
          model: systemMsg.model,
          tools: systemMsg.tools,
          // Include all other fields from the SDK message
          ...(systemMsg as Record<string, unknown>),
        };
        break;
      }

      case "result": {
        const resultMsg = sdkMessage as SDKResultMessage;
        // #2229 (R3): modelUsage is untyped on SDKResultMessage (upstream shape
        // may evolve) — read it as unknown passthrough, never type it further.
        const resultModelUsage = (sdkMessage as Record<string, unknown>)
          .modelUsage;
        logMessage = {
          ...baseFields,
          type: "system",
          subtype: "result",
          duration_ms: resultMsg.duration_ms,
          duration_api_ms: resultMsg.duration_api_ms,
          num_turns: resultMsg.num_turns,
          total_cost_usd: resultMsg.total_cost_usd,
          is_error: resultMsg.is_error,
          result_subtype: resultMsg.subtype,
          // #2229 (R3): forward the final turn-level usage — the SDK stream's
          // per-message assistant events carry message_start placeholder
          // output_tokens (prod p50=2), so this result usage is the ONLY real
          // output-token source on the client side. `modelUsage` (per-model
          // map, camelCase keys) is sub-agent-INCLUSIVE — probe-verified equal
          // to main+subagent transcript deduped sums — while `usage` covers the
          // main chain only. Omit each key when absent.
          ...(resultMsg.usage !== undefined ? { usage: resultMsg.usage } : {}),
          ...(resultModelUsage !== undefined
            ? { modelUsage: resultModelUsage }
            : {}),
        };
        break;
      }

      // Handle tool use results (often comes as user messages)
      case "tool_result": {
        const toolMsg = sdkMessage as SDKToolResultMessage;
        const toolLogMessage: ExtendedRawJSONLines = {
          ...baseFields,
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolMsg.tool_use_id,
                content: toolMsg.content,
              },
            ],
          },
          toolUseResult: toolMsg.content,
        };

        // Add mode if available from responses
        if (toolMsg.tool_use_id && this.responses?.has(toolMsg.tool_use_id)) {
          const response = this.responses.get(toolMsg.tool_use_id);
          if (response?.mode) {
            toolLogMessage.mode = response.mode;
          }
        }

        logMessage = toolLogMessage;
        break;
      }

      default:
        // Unknown message type - pass through with all fields
        logMessage = {
          ...baseFields,
          ...(sdkMessage as Record<string, unknown>),
          type: sdkMessage.type, // Override type last to ensure it's set
        } as ExtendedRawJSONLines;
    }

    // Update last UUID for parent tracking
    if (logMessage && logMessage.type !== "summary") {
      this.lastUuid = uuid;
    }

    return logMessage;
  }

  /**
   * Convert multiple SDK messages to log format
   */
  convertMany(sdkMessages: SDKMessage[]): RawJSONLines[] {
    return sdkMessages
      .map(msg => this.convert(msg))
      .filter((msg): msg is RawJSONLines => msg !== null);
  }

  /**
   * Convert a simple string content to a sidechain user message
   * Used for Task tool sub-agent prompts
   */
  convertSidechainUserMessage(
    toolUseId: string,
    content: string
  ): RawJSONLines {
    const uuid = randomUUID();
    const timestamp = new Date().toISOString();
    this.sidechainLastUUID.set(toolUseId, uuid);
    return {
      parentUuid: this.lastUuid,
      isSidechain: true,
      userType: "external" as const,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      version: this.context.version,
      gitBranch: this.context.gitBranch,
      type: "user",
      message: {
        role: "user",
        content: content,
      },
      uuid,
      timestamp,
    };
  }

  /**
   * Generate an interrupted tool result message
   * Used when a tool call is interrupted by the user
   * @param toolUseId - The ID of the tool that was interrupted
   * @param parentToolUseId - Optional parent tool ID if this is a sidechain tool
   */
  generateInterruptedToolResult(
    toolUseId: string,
    parentToolUseId?: string | null
  ): RawJSONLines {
    const uuid = randomUUID();
    const timestamp = new Date().toISOString();
    const errorMessage = "[Request interrupted by user for tool use]";

    // Determine if this is a sidechain and get parent UUID
    let isSidechain = false;
    let parentUuid: string | null = this.lastUuid;

    if (parentToolUseId) {
      isSidechain = true;
      // Look up the parent tool's UUID
      parentUuid = this.sidechainLastUUID.get(parentToolUseId) ?? this.lastUuid;
      // Track this tool in the sidechain map
      this.sidechainLastUUID.set(parentToolUseId, uuid);
    }

    const logMessage: ExtendedRawJSONLines = {
      type: "user",
      isSidechain: isSidechain,
      uuid,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUseId,
          },
        ],
      },
      parentUuid: parentUuid,
      userType: "external" as const,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      version: this.context.version,
      gitBranch: this.context.gitBranch,
      timestamp,
      toolUseResult: `Error: ${errorMessage}`,
    };

    // Update last UUID for tracking
    this.lastUuid = uuid;

    return logMessage;
  }
}

/**
 * Convenience function for one-off conversions
 */
export function convertSDKToLog(
  sdkMessage: SDKMessage,
  context: Omit<ConversionContext, "parentUuid">,
  responses?: Map<string, PermissionResponse>
): RawJSONLines | null {
  const converter = new SDKToLogConverter(context, responses);
  return converter.convert(sdkMessage);
}
