// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentEvent,
  NormalizedAgentContent,
  NormalizedMessage,
  ToolResultPermission,
} from "@/chat/types";
import { asNumber, asString, isObject } from "@/chat/normalizeUtils";
import { preserveBlankLines } from "@/chat/preserveBlankLines";
import { REASONING_HIDDEN_BY_CLAUDE } from "@/chat/reasoningPlaceholder";

function normalizeToolResultPermissions(
  value: unknown
): ToolResultPermission | undefined {
  if (!isObject(value)) return undefined;
  const date = asNumber(value.date);
  const result = value.result;
  if (date === null) return undefined;
  if (result !== "approved" && result !== "denied") return undefined;

  const mode = asString(value.mode) ?? undefined;
  const allowedTools = Array.isArray(value.allowedTools)
    ? value.allowedTools.filter(tool => typeof tool === "string")
    : undefined;
  const decision = value.decision;
  const normalizedDecision =
    decision === "approved" ||
    decision === "approved_for_session" ||
    decision === "denied" ||
    decision === "abort"
      ? decision
      : undefined;

  return {
    date,
    result,
    mode,
    allowedTools,
    decision: normalizedDecision,
  };
}

function normalizeAgentEvent(value: unknown): AgentEvent | null {
  if (!isObject(value) || typeof value.type !== "string") return null;
  return value as AgentEvent;
}

function normalizeAssistantOutput(
  messageId: string,
  localId: string | null,
  createdAt: number,
  data: Record<string, unknown>,
  meta?: unknown
): NormalizedMessage | null {
  const uuid = asString(data.uuid) ?? messageId;
  const parentUUID = asString(data.parentUuid) ?? null;
  const isSidechain = Boolean(data.isSidechain);
  const isTaskNotification = Boolean(data.isTaskNotification);

  const message = isObject(data.message) ? data.message : null;
  if (!message) return null;

  const modelContent = message.content;
  const blocks: NormalizedAgentContent[] = [];

  if (typeof modelContent === "string") {
    blocks.push({
      type: "text",
      text: preserveBlankLines(modelContent),
      uuid,
      parentUUID,
    });
  } else if (Array.isArray(modelContent)) {
    for (const block of modelContent) {
      if (!isObject(block) || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") {
        blocks.push({
          type: "text",
          text: preserveBlankLines(block.text),
          uuid,
          parentUUID,
        });
        continue;
      }
      if (block.type === "thinking" && typeof block.thinking === "string") {
        // #3147: Claude extended-thinking TEXT is withheld by the Anthropic
        // subscription/OAuth stream-json path — thinking blocks arrive as
        // signature-only stubs ({thinking:"", signature:"…"}). When the text is
        // empty but a signature IS present, the model DID reason; surface a
        // "hidden by Claude" affordance so the unified reasoning category renders
        // (D1=A) instead of an empty section. Non-empty thinking (or any future
        // path that exposes the text) renders verbatim.
        const signature = (block as Record<string, unknown>).signature;
        const hasSignature =
          typeof signature === "string" && signature.length > 0;
        const reasoningText =
          block.thinking.length === 0 && hasSignature
            ? REASONING_HIDDEN_BY_CLAUDE
            : block.thinking;
        blocks.push({
          type: "reasoning",
          text: reasoningText,
          uuid,
          parentUUID,
        });
        continue;
      }
      if (block.type === "tool_use" && typeof block.id === "string") {
        const name = asString(block.name) ?? "Tool";
        const input =
          "input" in block
            ? (block as Record<string, unknown>).input
            : undefined;
        const description =
          isObject(input) && typeof input.description === "string"
            ? input.description
            : null;
        blocks.push({
          type: "tool-call",
          id: block.id,
          name,
          input,
          description,
          uuid,
          parentUUID,
        });
      }
    }
  }

  const usage = isObject(message.usage)
    ? (message.usage as Record<string, unknown>)
    : null;
  const inputTokens = usage ? asNumber(usage.input_tokens) : null;
  const outputTokens = usage ? asNumber(usage.output_tokens) : null;

  return {
    id: messageId,
    localId,
    createdAt,
    role: "agent",
    isSidechain,
    content: blocks,
    meta,
    // #2229: the API message.id from the SAME object the usage is read from —
    // the dedup key for per-content-block duplicate rows.
    apiMessageId: asString(message.id) ?? undefined,
    usage:
      inputTokens !== null && outputTokens !== null
        ? {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_creation_input_tokens:
              asNumber(usage?.cache_creation_input_tokens) ?? undefined,
            cache_read_input_tokens:
              asNumber(usage?.cache_read_input_tokens) ?? undefined,
            service_tier: asString(usage?.service_tier) ?? undefined,
          }
        : undefined,
    ...(isTaskNotification ? { isTaskNotification: true } : {}),
  };
}

function normalizeUserOutput(
  messageId: string,
  localId: string | null,
  createdAt: number,
  data: Record<string, unknown>,
  meta?: unknown
): NormalizedMessage | null {
  const uuid = asString(data.uuid) ?? messageId;
  const parentUUID = asString(data.parentUuid) ?? null;
  const isSidechain = Boolean(data.isSidechain);
  // #2162: a synthetic/meta user record (isMeta — stop-hook feedback, etc.) is
  // routed to a collapsed chip rather than inline prose. Force role:"agent" for
  // BOTH string and array content so there is exactly ONE chip render site
  // (AssistantMessage.tsx); without forcing the role, a string-content meta
  // record would render in UserMessage.tsx and an array-content one in
  // AssistantMessage.tsx. The isMeta:true marker threads message→block→metadata.
  const isMeta = Boolean(data.isMeta);

  const message = isObject(data.message) ? data.message : null;
  if (!message) return null;

  const messageContent = message.content;

  // #2162: sidechain routing takes precedence over the isMeta chip below. This is
  // intentional — stop-hook feedback is a main-session record and never a sidechain
  // (sidechains are sub-agent / Task-tool prompts), so the two flags are not
  // expected to co-occur; if they ever did, the sidechain render wins (unchanged
  // pre-fix behavior).
  if (isSidechain && typeof messageContent === "string") {
    return {
      id: messageId,
      localId,
      createdAt,
      role: "agent",
      isSidechain: true,
      content: [
        { type: "sidechain", uuid, prompt: messageContent, parentUUID },
      ],
      meta,
    };
  }

  if (typeof messageContent === "string") {
    // #2162: a string-content meta record renders as a collapsed agent-column
    // chip (role:"agent" + isMeta), not a user bubble.
    if (isMeta) {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "agent",
        isSidechain: false,
        content: [
          {
            type: "text",
            text: preserveBlankLines(messageContent),
            uuid,
            parentUUID,
          },
        ],
        meta,
        isMeta: true,
      };
    }
    return {
      id: messageId,
      localId,
      createdAt,
      role: "user",
      isSidechain: false,
      content: { type: "text", text: messageContent },
      meta,
    };
  }

  const blocks: NormalizedAgentContent[] = [];

  if (Array.isArray(messageContent)) {
    for (const block of messageContent) {
      if (!isObject(block) || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") {
        blocks.push({
          type: "text",
          text: preserveBlankLines(block.text),
          uuid,
          parentUUID,
        });
        continue;
      }
      if (
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        const isError = Boolean(block.is_error);
        const rawContent =
          "content" in block
            ? (block as Record<string, unknown>).content
            : undefined;
        const embeddedToolUseResult =
          "toolUseResult" in data
            ? (data as Record<string, unknown>).toolUseResult
            : null;

        const permissions = normalizeToolResultPermissions(block.permissions);

        blocks.push({
          type: "tool-result",
          tool_use_id: block.tool_use_id,
          content: embeddedToolUseResult ?? rawContent,
          is_error: isError,
          uuid,
          parentUUID,
          permissions,
        });
      }
    }
  }

  return {
    id: messageId,
    localId,
    createdAt,
    role: "agent",
    isSidechain,
    content: blocks,
    meta,
    // #2162: array-content meta record → collapsed chip (role:"agent" is already
    // the array-branch default; the isMeta marker threads to the chip renderer).
    ...(isMeta ? { isMeta: true } : {}),
  };
}

export function isSkippableAgentContent(content: unknown): boolean {
  if (!isObject(content) || content.type !== "output") return false;
  const data = isObject(content.data) ? content.data : null;
  if (!data) return false;
  // #2162: compaction summaries are always dropped (never a chip). A `type:"user"`
  // record carrying `isMeta` (stop-hook feedback / other synthetic meta) is NOT
  // skipped here — normalizeUserOutput routes it to a collapsed chip (role:"agent"
  // + isMeta:true). Assistant-side `isMeta` records are still skipped. (Relaxing
  // this guard also lets LOCAL-mode JSONL isMeta user records — "Caveat:" /
  // command-output meta — surface as chips instead of being dropped.)
  if (data.isCompactSummary) return true;
  if (data.type === "user" && data.isMeta) return false;
  return Boolean(data.isMeta);
}

export function isCodexContent(content: unknown): boolean {
  return isObject(content) && content.type === "codex";
}

export function isOutputContent(content: unknown): boolean {
  return isObject(content) && content.type === "output";
}

export function normalizeAgentRecord(
  messageId: string,
  localId: string | null,
  createdAt: number,
  content: unknown,
  meta?: unknown
): NormalizedMessage | null {
  if (!isObject(content) || typeof content.type !== "string") return null;

  if (content.type === "output") {
    const data = isObject(content.data) ? content.data : null;
    if (!data || typeof data.type !== "string") return null;

    // Skip meta/compact-summary messages (parity with hapi-app).
    // #2162: a `type:"user"` isMeta record is NOT dropped here — it flows to
    // normalizeUserOutput below, which returns a role:"agent" collapsed chip
    // (isMeta:true). Only non-user isMeta records (assistant-side meta) drop.
    if (data.isMeta && data.type !== "user") return null;
    if (data.isCompactSummary) return null;

    if (data.type === "assistant") {
      return normalizeAssistantOutput(
        messageId,
        localId,
        createdAt,
        data,
        meta
      );
    }
    if (data.type === "user") {
      return normalizeUserOutput(messageId, localId, createdAt, data, meta);
    }
    if (data.type === "summary" && typeof data.summary === "string") {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "agent",
        isSidechain: false,
        content: [{ type: "summary", summary: data.summary }],
        meta,
      };
    }
    if (data.type === "system" && data.subtype === "api_error") {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "event",
        content: {
          type: "api-error",
          retryAttempt: asNumber(data.retryAttempt) ?? 0,
          maxRetries: asNumber(data.maxRetries) ?? 0,
          error: data.error,
          retryInSeconds: asNumber(data.retryInSeconds) ?? undefined,
          isThundering: data.isThundering === true,
          thunderingDurationSeconds:
            asNumber(data.thunderingDurationSeconds) ?? undefined,
        },
        isSidechain: false,
        meta,
      };
    }
    if (data.type === "system" && data.subtype === "result") {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "event",
        content: {
          type: "turn-result",
          duration_ms: asNumber(data.duration_ms) ?? 0,
          duration_api_ms: asNumber(data.duration_api_ms) ?? 0,
          num_turns: asNumber(data.num_turns) ?? 0,
          total_cost_usd: asNumber(data.total_cost_usd) ?? 0,
          is_error: Boolean(data.is_error),
          result_subtype: asString(data.result_subtype) ?? "success",
        },
        isSidechain: false,
        meta,
        // #2229: raw passthrough of the turn-final usage the CLI forwards —
        // the reducer's per-run fold closes a run on these (modelUsage is
        // sub-agent-inclusive and preferred; absent on pre-#2229 rows).
        ...(isObject(data.usage) ? { resultUsage: data.usage } : {}),
        ...(isObject(data.modelUsage)
          ? { resultModelUsage: data.modelUsage }
          : {}),
      };
    }
    // #4095: the claude pty/tmux launchers never emit `system/result`; the CLI
    // writes its own turn clock as `system/turn_duration` after the turn's last
    // assistant text (and after stop_hook_summary). Duration only — no usage.
    if (data.type === "system" && data.subtype === "turn_duration") {
      const durationMs = asNumber(data.durationMs);
      if (durationMs == null || durationMs < 0) return null;
      return {
        id: messageId,
        localId,
        createdAt,
        role: "event",
        content: { type: "turn-duration", duration_ms: durationMs },
        isSidechain: false,
        meta,
      };
    }
    if (data.type === "system" && data.subtype === "task_started") {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "event",
        content: {
          type: "task-started",
          task_id: asString(data.task_id) ?? messageId,
          description: asString(data.description) ?? "",
          task_type: asString(data.task_type) ?? undefined,
        },
        isSidechain: false,
        meta,
      };
    }
    if (data.type === "system" && data.subtype === "task_notification") {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "event",
        content: {
          type: "task-completed",
          task_id: asString(data.task_id) ?? messageId,
          status:
            data.status === "completed" ||
            data.status === "failed" ||
            data.status === "stopped"
              ? data.status
              : "completed",
        },
        isSidechain: false,
        meta,
      };
    }
    return null;
  }

  if (content.type === "event") {
    const event = normalizeAgentEvent(content.data);
    if (!event) return null;
    return {
      id: messageId,
      localId,
      createdAt,
      role: "event",
      content: event,
      isSidechain: false,
      meta,
    };
  }

  if (content.type === "codex") {
    const data = isObject(content.data) ? content.data : null;
    if (!data || typeof data.type !== "string") return null;

    if (data.type === "message" && typeof data.message === "string") {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "agent",
        isSidechain: false,
        content: [
          {
            type: "text",
            text: preserveBlankLines(data.message),
            uuid: messageId,
            parentUUID: null,
          },
        ],
        meta,
      };
    }

    if (data.type === "reasoning" && typeof data.message === "string") {
      return {
        id: messageId,
        localId,
        createdAt,
        role: "agent",
        isSidechain: false,
        content: [
          {
            type: "reasoning",
            text: data.message,
            uuid: messageId,
            parentUUID: null,
          },
        ],
        meta,
      };
    }

    if (data.type === "tool-call" && typeof data.callId === "string") {
      const uuid = asString(data.id) ?? messageId;
      return {
        id: messageId,
        localId,
        createdAt,
        role: "agent",
        isSidechain: false,
        content: [
          {
            type: "tool-call",
            id: data.callId,
            name: asString(data.name) ?? "unknown",
            input: data.input,
            description: null,
            uuid,
            parentUUID: null,
          },
        ],
        meta,
      };
    }

    if (data.type === "tool-call-result" && typeof data.callId === "string") {
      const uuid = asString(data.id) ?? messageId;
      return {
        id: messageId,
        localId,
        createdAt,
        role: "agent",
        isSidechain: false,
        content: [
          {
            type: "tool-result",
            tool_use_id: data.callId,
            content: data.output,
            is_error: false,
            uuid,
            parentUUID: null,
          },
        ],
        meta,
      };
    }
  }

  return null;
}
