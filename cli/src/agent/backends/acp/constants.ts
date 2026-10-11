// SPDX-License-Identifier: AGPL-3.0-only
export const ACP_SESSION_UPDATE_TYPES = {
  agentMessageChunk: "agent_message_chunk",
  agentThoughtChunk: "agent_thought_chunk",
  toolCall: "tool_call",
  toolCallUpdate: "tool_call_update",
  plan: "plan",
  // Issue #3352: gemini 0.57.0 context-occupancy update (`{ size, used }`).
  // Previously an unrecognized kind, silently dropped by `handleUpdate`.
  usageUpdate: "usage_update",
} as const;
