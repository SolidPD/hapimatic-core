// SPDX-License-Identifier: AGPL-3.0-only
import type { MessageStatus } from "@/types/api";
import type { GateDenialOutcome } from "@hapi/protocol";

export type UsageData = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string;
};

/** Cumulative token usage statistics for an entire session. */
export type SessionTokenStats = {
  /** Total input tokens across all turns. */
  totalInput: number;
  /** Total output tokens across all turns. */
  totalOutput: number;
  /** Total cache-creation input tokens. */
  totalCacheCreation: number;
  /** Total cache-read input tokens. */
  totalCacheRead: number;
  /** Number of assistant turns that reported usage. */
  turnCount: number;
  /** Highest context size observed in any single turn. */
  peakContextSize: number;
  /** Per-turn usage timeline (input + output per turn, chronological). */
  timeline: Array<{
    timestamp: number;
    input: number;
    output: number;
  }>;
};

export type AgentEvent =
  | { type: "switch"; mode: "local" | "remote" }
  | { type: "message"; message: string }
  | { type: "title-changed"; title: string }
  | { type: "limit-reached"; endsAt: number }
  | { type: "ready" }
  | {
      type: "api-error";
      retryAttempt: number;
      maxRetries: number;
      error: unknown;
      retryInSeconds?: number;
      isThundering?: boolean;
      thunderingDurationSeconds?: number;
    }
  | { type: "context-compaction" }
  | { type: "conversation-branched" }
  | {
      // #3579: a durable in-thread gate-denial notice. `outcome` is the
      // server-resolved copy; `at` is an ISO instant the client formats to
      // locale (R6). Rendered by SystemMessage's GateDenialNotice branch.
      type: "gate-denied";
      hookId: string;
      reason: string;
      outcome: GateDenialOutcome;
      at: string;
    }
  | {
      // #4936: the durable in-thread STOP notice for an API spend cap / a
      // user-set spend limit. `keyLabel` is display-safe (server-resolved from
      // session metadata); `resumesAt` is the epoch ms the API reported, or
      // null. Rendered by SystemMessage's SpendLimitNotice branch.
      type: "spend-limit-reached";
      variant: "tier-cap" | "org-limit" | "workspace-limit";
      keyLabel: string | null;
      resumesAt: number | null;
      requestId?: string;
      at: string;
    }
  | {
      type: "turn-result";
      duration_ms: number;
      duration_api_ms: number;
      num_turns: number;
      total_cost_usd: number;
      is_error: boolean;
      result_subtype: string;
    }
  | {
      // #4095: claude pty/tmux turn clock from the CLI's `system/turn_duration`
      // transcript record (the SDK path carries its duration on `turn-result`).
      type: "turn-duration";
      duration_ms: number;
    }
  | {
      type: "task-started";
      task_id: string;
      description: string;
      task_type?: string;
    }
  | {
      type: "task-completed";
      task_id: string;
      status: "completed" | "failed" | "stopped";
    }
  | ({ type: string } & Record<string, unknown>);

export type ToolResultPermission = {
  date: number;
  result: "approved" | "denied";
  mode?: string;
  allowedTools?: string[];
  decision?: "approved" | "approved_for_session" | "denied" | "abort";
};

export type ToolUse = {
  type: "tool-call";
  id: string;
  name: string;
  input: unknown;
  description: string | null;
  uuid: string;
  parentUUID: string | null;
};

export type ToolResult = {
  type: "tool-result";
  tool_use_id: string;
  content: unknown;
  is_error: boolean;
  uuid: string;
  parentUUID: string | null;
  permissions?: ToolResultPermission;
};

export type NormalizedAgentContent =
  | {
      type: "text";
      text: string;
      uuid: string;
      parentUUID: string | null;
    }
  | {
      type: "reasoning";
      text: string;
      uuid: string;
      parentUUID: string | null;
    }
  | ToolUse
  | ToolResult
  | { type: "summary"; summary: string }
  | {
      type: "sidechain";
      uuid: string;
      prompt: string;
      parentUUID: string | null;
    };

export type NormalizedMessage = (
  | {
      role: "user";
      content: { type: "text"; text: string };
    }
  | {
      role: "agent";
      content: NormalizedAgentContent[];
    }
  | {
      role: "event";
      content: AgentEvent;
    }
) & {
  id: string;
  localId: string | null;
  createdAt: number;
  isSidechain: boolean;
  meta?: unknown;
  usage?: UsageData;
  /**
   * Anthropic API `message.id` (`msg_…`) — the #2229 usage-dedup key. One API
   * message is stored as ~1.5 rows (one per content block) each repeating the
   * same usage; `id` above is the DB row id and CANNOT detect that.
   */
  apiMessageId?: string;
  /** Turn-final result event's `usage` (snake_case, raw passthrough — #2229). */
  resultUsage?: Record<string, unknown>;
  /**
   * Turn-final result event's per-model `modelUsage` map (camelCase fields,
   * sub-agent-inclusive — #2229). Preferred output-token source when present.
   */
  resultModelUsage?: Record<string, unknown>;
  status?: MessageStatus;
  originalText?: string;
  /** #3579: gate-denial outcome carried on a "blocked" user bubble. */
  denial?: GateDenialOutcome;
  isInherited?: boolean;
  isTaskNotification?: boolean;
  /**
   * #2162: a synthetic/meta user record (stop-hook feedback, system-reminder /
   * caveat injections) — rendered as a collapsed, dimmed chip rather than inline
   * prose. Threads message → block → assistant-ui metadata exactly like
   * isTaskNotification (#733).
   */
  isMeta?: boolean;
};

export type ToolPermission = {
  id: string;
  status: "pending" | "approved" | "denied" | "canceled";
  reason?: string;
  mode?: string;
  allowedTools?: string[];
  decision?: "approved" | "approved_for_session" | "denied" | "abort";
  answers?: Record<string, string[]>;
  date?: number;
  createdAt?: number | null;
  completedAt?: number | null;
};

export type ChatToolCall = {
  id: string;
  name: string;
  state: "pending" | "running" | "completed" | "error";
  input: unknown;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  description: string | null;
  result?: unknown;
  permission?: ToolPermission;
  // Populated by the reducer for the `Skill` tool: the SKILL.md body that
  // Claude Code injects as a sibling user-turn text block (linked via
  // parentUuid → tool_result uuid). Renders inside the Skill ToolCard dialog
  // instead of as a separate agent-text block. See issue #1020.
  skillBody?: string;
};

export type UserTextBlock = {
  kind: "user-text";
  id: string;
  localId: string | null;
  createdAt: number;
  text: string;
  status?: MessageStatus;
  originalText?: string;
  /** #3579: gate-denial outcome carried on a "blocked" bubble (R2). */
  denial?: GateDenialOutcome;
  meta?: unknown;
  isInherited?: boolean;
  isTaskNotification?: boolean;
};

export type AgentTextBlock = {
  kind: "agent-text";
  id: string;
  localId: string | null;
  createdAt: number;
  text: string;
  meta?: unknown;
  isInherited?: boolean;
  isTaskNotification?: boolean;
  /** #2162: synthetic/meta record → collapsed chip (mirrors isTaskNotification). */
  isMeta?: boolean;
  // #3154 (KD1): content-type category. `"narration"` marks interstitial
  // assistant text (a text block whose turn continues into one or more tool
  // calls before the next user turn); absent/undefined ⇒ the task-final
  // uncategorized RESPONSE. A mutable flag on the same block — NOT a new block
  // kind — so the streaming retroactive reclassify (R7) can flip
  // response→narration in place with a stable block id (`${msg.id}:${idx}`).
  category?: "narration";
  // #3778 (Task 5): marks the FIRST response text of the segment that immediately
  // FOLLOWS a Stop-hook feedback boundary (set by the reducer reverse-scan when it
  // hits an `isStopHookFeedbackBlock` record). The render layer reads it to draw a
  // small inline "after a Stop hook fired" attribution badge on that response part.
  // Threaded through reconcile equality (like `category`) so a set/clear busts block
  // identity and reaches the live-streaming DOM.
  afterHookBoundary?: true;
};

export type AgentReasoningBlock = {
  kind: "agent-reasoning";
  id: string;
  localId: string | null;
  createdAt: number;
  text: string;
  meta?: unknown;
  isInherited?: boolean;
  isTaskNotification?: boolean;
};

export type CliOutputBlock = {
  kind: "cli-output";
  id: string;
  localId: string | null;
  createdAt: number;
  text: string;
  source: "user" | "assistant";
  meta?: unknown;
  isInherited?: boolean;
};

export type AgentEventBlock = {
  kind: "agent-event";
  id: string;
  createdAt: number;
  event: AgentEvent;
  meta?: unknown;
  isInherited?: boolean;
};

export type ToolCallBlock = {
  kind: "tool-call";
  id: string;
  localId: string | null;
  createdAt: number;
  tool: ChatToolCall;
  children: ChatBlock[];
  meta?: unknown;
  isInherited?: boolean;
};

export type ChatBlock =
  | UserTextBlock
  | AgentTextBlock
  | AgentReasoningBlock
  | CliOutputBlock
  | ToolCallBlock
  | AgentEventBlock;
