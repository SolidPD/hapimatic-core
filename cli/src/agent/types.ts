// SPDX-License-Identifier: AGPL-3.0-only
export type McpEnvVar = {
  name: string;
  value: string;
};

export type McpServerStdio = {
  name: string;
  command: string;
  args: string[];
  env: McpEnvVar[];
};

export type AgentSessionConfig = {
  cwd: string;
  mcpServers: McpServerStdio[];
};

export type PromptContent = {
  type: "text";
  text: string;
};

export type PlanItem = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type AgentMessage =
  | { type: "text"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
      status: "pending" | "in_progress" | "completed" | "failed";
    }
  | {
      type: "tool_result";
      id: string;
      output: unknown;
      status: "completed" | "failed";
    }
  | { type: "plan"; items: PlanItem[] }
  | { type: "turn_complete"; stopReason: string }
  // Issue #3352: context-window occupancy surfaced from an ACP `usage_update`
  // session/update (gemini `{size, used}`). Feeds onContextUsage / keepAlive
  // (R6) and the per-turn context columns. A side channel past the text/tool
  // message kinds (the ACP layer has no usage vocabulary of its own).
  | {
      type: "context_usage";
      contextWindowTokens: number;
      contextUsedTokens: number;
    }
  // Issue #3352: per-turn token usage surfaced from the ACP `session/prompt`
  // response (gemini `_meta.quota`, or opencode's claude-style `usage`). Feeds
  // the per-turn stats (R5/R8). Cache fields are present only for a runner that
  // emits a split (opencode); absent otherwise (R4).
  | {
      type: "usage";
      tokIn?: number;
      tokOut?: number;
      tokCacheRead?: number;
      tokCacheWrite?: number;
      modelId?: string;
    }
  | { type: "error"; message: string };

export type PermissionOption = {
  optionId: string;
  name: string;
  kind:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always"
    | string;
};

export type PermissionRequest = {
  id: string;
  sessionId: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  options: PermissionOption[];
};

export type PermissionResponse =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface AgentBackend {
  initialize(): Promise<void>;
  newSession(config: AgentSessionConfig): Promise<string>;
  prompt(
    sessionId: string,
    content: PromptContent[],
    onUpdate: (msg: AgentMessage) => void
  ): Promise<void>;
  cancelPrompt(sessionId: string): Promise<void>;
  respondToPermission(
    sessionId: string,
    request: PermissionRequest,
    response: PermissionResponse
  ): Promise<void>;
  onPermissionRequest(handler: (request: PermissionRequest) => void): void;
  disconnect(): Promise<void>;
}

export type AgentBackendFactory = () => AgentBackend;
