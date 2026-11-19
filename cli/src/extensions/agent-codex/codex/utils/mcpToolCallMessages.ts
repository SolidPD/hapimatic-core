// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Turns Codex's `mcp_tool_call_begin` / `mcp_tool_call_end` events into the
 * chat's `tool-call` / `tool-call-result` messages (#6724), so a Codex MCP call
 * gets a row, and a completed `pin_post` its card, as a Claude one does.
 *
 * The same event shapes come from the app-server converter
 * (`appServer/appServerEventConverter.ts`) and from `codex mcp-server`'s own
 * `codex/event` notifications (`codexMcpClient.ts`).
 */

import type { CodexEvent } from "../types";

export interface McpToolCallMessage {
  type: "tool-call";
  name: string;
  callId: string;
  input: unknown;
}

export interface McpToolCallResultMessage {
  type: "tool-call-result";
  callId: string;
  output: unknown;
  is_error: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The row name a Claude session gives the same call (`mcp__hapi__pin_post`). */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

export function mcpToolCallBeginMessage(
  event: CodexEvent
): McpToolCallMessage | null {
  const callId = asString(event.call_id);
  const invocation = asRecord(event.invocation);
  const server = asString(invocation?.server);
  const tool = asString(invocation?.tool);
  if (!callId || !invocation || !server || !tool) return null;
  return {
    type: "tool-call",
    name: mcpToolName(server, tool),
    callId,
    input: invocation.arguments ?? {},
  };
}

/**
 * The result is the MCP content (or the error message), flagged as an error
 * when the call failed or its result cannot be read, so the chat shows no pin
 * card for a pin that may not have been saved.
 */
export function mcpToolCallEndMessage(
  event: CodexEvent
): McpToolCallResultMessage | null {
  const callId = asString(event.call_id);
  if (!callId) return null;
  const result = asRecord(event.result);
  const ok = asRecord(result?.Ok);
  if (ok) {
    return {
      type: "tool-call-result",
      callId,
      output: Array.isArray(ok.content) ? ok.content : ok,
      is_error: ok.isError === true,
    };
  }
  if (typeof result?.Err === "string") {
    return {
      type: "tool-call-result",
      callId,
      output: result.Err,
      is_error: true,
    };
  }
  return {
    type: "tool-call-result",
    callId,
    output: event.result ?? null,
    is_error: true,
  };
}

/** Codex sends no end for an MCP call still running at a stop: close it. */
export class OpenMcpCalls {
  private readonly ids = new Set<string>();
  note(message: McpToolCallMessage | McpToolCallResultMessage): void {
    if (message.type === "tool-call") this.ids.add(message.callId);
    else this.ids.delete(message.callId);
  }
  closeAll(): McpToolCallResultMessage[] {
    const ids = [...this.ids];
    this.ids.clear();
    return ids.map(callId => ({
      type: "tool-call-result" as const,
      callId,
      output: "Stopped before the MCP tool call finished",
      is_error: true,
    }));
  }
}
