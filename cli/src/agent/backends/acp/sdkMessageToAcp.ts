// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Claude `SDKMessage` → ACP `session/update` translator (issue #1906, Task 2).
 *
 * This is the INGRESS (agent-side) direction: Hapimatic drives a Claude turn via
 * `claudeRemote()` and must stream that turn's `SDKMessage`s to a connected ACP
 * client (an editor) as `session/update` notifications. It is the inverse of the
 * client-side {@link AcpMessageHandler} (`session/update` → `AgentMessage`), which
 * is Hapimatic's own conformance oracle for the payload shapes — the emitters here
 * produce exactly what that handler reads.
 *
 * Pure functions, no I/O — the caller ({@link AcpIngressServer}) wraps each
 * returned update in `{ sessionId, update }` before sending the notification.
 */
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
} from "@/claude/sdk";
import { asString, isObject } from "@/agent/utils";
import { ACP_SESSION_UPDATE_TYPES } from "./constants";

/**
 * The ACP `stopReason` enum returned by `session/prompt` (confirmed against
 * agentclientprotocol.com — agent-side). `cancelled` is set by the ingress
 * cancel path ({@link AcpIngressServer}), never by {@link resultToStopReason}
 * (Claude surfaces no "cancelled" result subtype).
 */
export const ACP_STOP_REASONS = {
  endTurn: "end_turn",
  maxTokens: "max_tokens",
  maxTurnRequests: "max_turn_requests",
  refusal: "refusal",
  cancelled: "cancelled",
} as const;

export type AcpStopReason =
  (typeof ACP_STOP_REASONS)[keyof typeof ACP_STOP_REASONS];

/**
 * One ACP `session/update` payload (the inner `update` object — the caller wraps
 * it in `{ sessionId, update }`). Discriminated by `sessionUpdate`; extra fields
 * per variant are typed loosely because the ACP client reads them structurally.
 */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

/** A minimal ACP content block (v1 is text-only). */
interface AcpTextBlock {
  type: "text";
  text: string;
}

function textBlock(text: string): AcpTextBlock {
  return { type: "text", text };
}

/**
 * Normalize a Claude `tool_result` block's `content` (string, block array, or
 * arbitrary value) into ACP content blocks. v1 flattens everything to text.
 */
function normalizeToolResultContent(content: unknown): AcpTextBlock[] {
  if (typeof content === "string") {
    return [textBlock(content)];
  }
  if (Array.isArray(content)) {
    return content.map(block => {
      if (isObject(block) && block.type === "text") {
        return textBlock(asString(block.text) ?? "");
      }
      return textBlock(JSON.stringify(block));
    });
  }
  if (content === undefined || content === null) {
    return [];
  }
  return [textBlock(JSON.stringify(content))];
}

function assistantUpdates(message: SDKAssistantMessage): AcpSessionUpdate[] {
  const updates: AcpSessionUpdate[] = [];
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return updates;
  }

  for (const block of content) {
    if (!isObject(block)) continue;

    if (block.type === "text") {
      const text = asString(block.text);
      if (text) {
        updates.push({
          sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentMessageChunk,
          content: textBlock(text),
        });
      }
      continue;
    }

    if (block.type === "thinking") {
      // Claude carries thinking text in `.thinking`, not `.text`.
      const thinking = asString(block.thinking);
      if (thinking) {
        updates.push({
          sessionUpdate: ACP_SESSION_UPDATE_TYPES.agentThoughtChunk,
          content: textBlock(thinking),
        });
      }
      continue;
    }

    if (block.type === "tool_use") {
      const toolCallId = asString(block.id);
      if (!toolCallId) continue;
      updates.push({
        sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCall,
        toolCallId,
        title: asString(block.name) ?? "tool",
        kind: "other",
        status: "pending",
        rawInput: block.input ?? null,
      });
    }
  }

  return updates;
}

function userUpdates(message: SDKUserMessage): AcpSessionUpdate[] {
  const updates: AcpSessionUpdate[] = [];
  const content = message.message?.content;
  // A user message with string content is an echoed prompt, not a tool result —
  // nothing for the ACP client (it already sent that prompt).
  if (!Array.isArray(content)) {
    return updates;
  }

  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type !== "tool_result") continue;

    const toolCallId = asString(block.tool_use_id);
    if (!toolCallId) continue;

    const failed = block.is_error === true;
    updates.push({
      sessionUpdate: ACP_SESSION_UPDATE_TYPES.toolCallUpdate,
      toolCallId,
      status: failed ? "failed" : "completed",
      content: normalizeToolResultContent(block.content),
    });
  }

  return updates;
}

/**
 * Translate one Claude `SDKMessage` into zero or more ACP `session/update`
 * payloads. `system` and `result` messages produce NO updates — `result`
 * resolves the turn via {@link resultToStopReason} instead.
 */
export function sdkMessageToAcpUpdates(
  message: SDKMessage
): AcpSessionUpdate[] {
  switch (message.type) {
    case "assistant":
      return assistantUpdates(message as SDKAssistantMessage);
    case "user":
      return userUpdates(message as SDKUserMessage);
    default:
      // system / result / control_response / log — no streaming update.
      return [];
  }
}

/**
 * Map a Claude `result` SDKMessage to an ACP `stopReason`. Covers the reachable
 * outcomes of a normal (non-cancelled) turn:
 * - `error_max_turns` → `max_turn_requests`
 * - an explicit `max_tokens` stop_reason → `max_tokens` (defensive)
 * - everything else (success, error_during_execution) → `end_turn`
 *
 * `cancelled` is NOT produced here — the ingress `session/cancel` path resolves
 * an interrupted turn with `cancelled` directly.
 */
export function resultToStopReason(message: SDKResultMessage): AcpStopReason {
  if (message.subtype === "error_max_turns") {
    return ACP_STOP_REASONS.maxTurnRequests;
  }
  if (message.stop_reason === "max_tokens") {
    return ACP_STOP_REASONS.maxTokens;
  }
  return ACP_STOP_REASONS.endTurn;
}
