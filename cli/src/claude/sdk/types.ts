// SPDX-License-Identifier: MIT
/**
 * Type definitions for Claude Code SDK integration
 * Provides type-safe interfaces for all SDK communication
 */

import type { Readable } from "node:stream";
import type { ClaudePermissionMode } from "@hapi/protocol/types";

/**
 * SDK message types
 */
export interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

export interface SDKUserMessage extends SDKMessage {
  type: "user";
  parent_tool_use_id?: string;
  /**
   * #2162: Claude Code marks hidden-from-UI meta user messages (stop-hook
   * feedback, system-reminder / caveat injections, transcript-only notes) with
   * `isMeta` internally; on the SDK stream-json wire that flag is spelled
   * `isSynthetic` (`isSynthetic = isMeta || isVisibleInTranscriptOnly`). These
   * SDK types are hand-maintained (there is no `@anthropic-ai/claude-agent-sdk`
   * in node_modules), so an undeclared wire field is silently dropped by
   * sdkToLogConverter — declaring it here is the structural precondition for
   * propagating it to `isMeta` on the stored log record. Add the next new wire
   * field here too rather than let it be lost the same way.
   */
  isSynthetic?: boolean;
  message: {
    role: "user";
    content:
      | string
      | Array<{
          type: string;
          text?: string;
          tool_use_id?: string;
          content?: unknown;
          [key: string]: unknown;
        }>;
  };
}

export interface SDKAssistantMessage extends SDKMessage {
  type: "assistant";
  parent_tool_use_id?: string;
  message: {
    role: "assistant";
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      [key: string]: unknown;
    }>;
  };
}

export interface SDKSystemMessage extends SDKMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  slash_commands?: string[];
}

export interface SDKResultMessage extends SDKMessage {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution";
  result?: string;
  num_turns: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  session_id: string;
  /** "end_turn", "stop_sequence", or null when session is in a degenerate state */
  stop_reason?: string | null;
}

export interface SDKControlResponse extends SDKMessage {
  type: "control_response";
  response: {
    request_id: string;
    subtype: "success" | "error";
    error?: string;
    /**
     * Optional structured error code accompanying an error response.
     * Populated by Query.cleanupControllers with "claude_exited" when a
     * pending control_request is rejected because the subprocess exited;
     * also reserved for future upstream codes. Lets consumers branch on
     * a stable identifier instead of regex-matching error messages.
     */
    code?: string;
    /**
     * Nested data payload for control requests that RETURN data (e.g.
     * get_context_usage). Mirrors CanUseToolControlResponse.response.response.
     * Absent for void control requests like mcp_toggle. Issue #1469.
     */
    response?: unknown;
  };
}

export interface SDKLog extends SDKMessage {
  type: "log";
  log: {
    level: "debug" | "info" | "warn" | "error";
    message: string;
  };
}

/**
 * Control request types
 */
export interface ControlRequest {
  subtype: string;
}

export interface InterruptRequest extends ControlRequest {
  subtype: "interrupt";
}

export interface McpToggleRequest extends ControlRequest {
  subtype: "mcp_toggle";
  serverName: string;
  enabled: boolean;
}

export interface GetContextUsageRequest extends ControlRequest {
  subtype: "get_context_usage";
}

/**
 * Issue #2256: set the model for subsequent conversation turns on the running
 * Claude process. `model` is the resolved raw `--model` value (e.g. "opus",
 * "fable[1m]") — the SAME value the query was launched with — matching the
 * upstream SDK schema (`{ subtype: "set_model", model: string }`). A void
 * control request like mcp_toggle (the caller discards the response).
 */
export interface SetModelRequest extends ControlRequest {
  subtype: "set_model";
  model: string;
}

/**
 * Issue #2346: set the permission mode for subsequent turns on the running
 * Claude process via the set_permission_mode SDK control_request. Delivered
 * through the same stream-JSON stdin pipe as set_model / mcp_toggle. `mode` is a
 * PermissionMode already validated at the schema boundary (SetPermissionModeRequestSchema)
 * and/or resolvePermissionMode (claude flavor). A void control request like
 * mcp_toggle — the caller discards the response. Empirically confirmed to mutate
 * a LIVE query (issue #2346 Task 1): a mid-session flip is reflected in the
 * query's re-emitted system.init/status permissionMode and its tool-gating behavior.
 */
export interface SetPermissionModeRequest extends ControlRequest {
  subtype: "set_permission_mode";
  mode: ClaudePermissionMode;
}

/**
 * Slim first-order subset of Claude Code's get_context_usage control_response
 * payload that Hapimatic's display needs. The full upstream payload also
 * carries categories/gridRows/memoryFiles/agents/messageBreakdown (large) —
 * the cli boundary extracts only these fields before propagating. Issue #1469.
 */
export interface ContextUsagePayload {
  /** Active model id; may carry a tier suffix like "[1m]" (stripped by caller). */
  model: string;
  /** Effective context window (e.g. 1_000_000 for a [1m] session). */
  maxTokens: number;
  /** Raw context window before any reserved-headroom adjustment. */
  rawMaxTokens: number;
  /** Live total tokens currently in the context window. */
  totalTokens: number;
  /** Live usage percentage (0-100). */
  percentage: number;
}

export interface CanUseToolRequest extends ControlRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: unknown;
}

export interface CanUseToolControlRequest {
  type: "control_request";
  request_id: string;
  request: CanUseToolRequest;
}

export interface CanUseToolControlResponse {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: PermissionResult;
    error?: string;
  };
}

export interface ControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

export interface SDKControlRequest {
  request_id: string;
  type: "control_request";
  request: ControlRequest;
}

/**
 * Permission result type for tool calls
 */
export type PermissionResult =
  | {
      behavior: "allow";
      updatedInput: Record<string, unknown>;
    }
  | {
      behavior: "deny";
      message: string;
    };

/**
 * Callback function for tool permission checks
 */
export interface CanCallToolCallback {
  (
    toolName: string,
    input: unknown,
    options: { signal: AbortSignal }
  ): Promise<PermissionResult>;
}

/**
 * Query options
 */
export interface QueryOptions {
  abort?: AbortSignal;
  allowedTools?: string[];
  appendSystemPrompt?: string;
  customSystemPrompt?: string;
  cwd?: string;
  disallowedTools?: string[];
  maxTurns?: number;
  mcpServers?: Record<string, unknown>;
  pathToClaudeCodeExecutable?: string;
  permissionMode?: ClaudePermissionMode;
  continue?: boolean;
  resume?: string;
  model?: string;
  fallbackModel?: string;
  /** Issue #2456: reasoning-effort level for the claude child (`--effort
   *  <level>`). One of low|medium|high|xhigh|max. Omitted → no --effort flag
   *  (binary default), a byte-identical spawn. */
  effort?: string;
  settingsPath?: string;
  strictMcpConfig?: boolean;
  canCallTool?: CanCallToolCallback;
  /** Issue #1633: launch the claude child with --safe-mode (CLAUDE.md,
   *  skills, plugins, hooks, MCP customizations disabled). */
  safeMode?: boolean;
  /** Issue #1854: when resuming, fork into a NEW session id instead of
   *  reusing the parent's (pushes --fork-session). Branch sessions set this so
   *  they fork the parent's transcript rather than sharing it. */
  forkSession?: boolean;
  /** Issue #3731 (R1/R2): the launcher's EXPLICIT env set (`claudeEnvVars` —
   *  the `withAccountToken` / `withAccountConfigDir` result). Authoritative over the
   *  ambient `process.env` for every `BINDING_ENV_VARS` key: the child env strips all
   *  ambient binding vars, then layers this set (`buildSdkSpawnEnv`). Omitted → no
   *  binding var reaches the child. */
  bindingEnvVars?: Record<string, string>;
  /** Issue #4568 (F1): the session's credential is the `apiKeyHelper` in its
   *  `--settings` file. The child env then drops every env credential Claude Code
   *  ranks above the helper (`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`). */
  apiKeyHelperSession?: boolean;
}

/**
 * Query prompt types
 */
export type QueryPrompt = string | AsyncIterable<SDKMessage>;

/**
 * Control response handlers
 */
export type ControlResponseHandler = (
  response: SDKControlResponse["response"]
) => void;

/**
 * Error types
 */
export class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

/**
 * Error thrown by Query.request() when Claude returns a control_response
 * with subtype "error", or when the subprocess exits before responding.
 * Carries an optional structured `code` so consumers (e.g. the mcp-toggle
 * launcher handler) can map to a stable error code without parsing the
 * message text.
 *
 * Currently produced codes:
 * - "claude_exited" — synthesized by Query.cleanupControllers when a
 *   pending control_request is rejected because the subprocess exited.
 *
 * The `code` field is optional and additive: legacy upstream errors that
 * don't carry a code surface as SdkRequestError with code === undefined,
 * preserving existing message-based handling for those paths.
 */
export class SdkRequestError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "SdkRequestError";
    this.code = code;
  }
}

/**
 * Error thrown when the Claude Code child process is killed by a signal.
 * Exit codes >= 128 indicate signal termination (code = 128 + signal number).
 * Enables the retry loop to differentiate recoverable signal kills (e.g. SIGTERM)
 * from crash exits, applying a higher retry budget and cooldown delay.
 */
export class SignalExitError extends Error {
  readonly exitCode: number;
  readonly signalNumber: number;
  readonly signalName: string;
  // Diagnostic data captured at exit time (Issue #795)
  procStatus: Record<string, string> | null = null;
  childPid: number | undefined = undefined;
  // Issue #1239 PR D: last ~8 KB of the child's stderr stream. Empty
  // unmatched-line content (everything parseStderrApiError discarded) is
  // captured pre-exit by the ring buffer in query.ts so the launcher can
  // include it in diagnostic emissions. `undefined` when stderr was silent.
  stderrTail: string | undefined = undefined;

  constructor(exitCode: number) {
    const signalNumber = exitCode - 128;
    const knownSignals: Record<number, string> = {
      1: "SIGHUP",
      2: "SIGINT",
      6: "SIGABRT",
      9: "SIGKILL",
      11: "SIGSEGV",
      15: "SIGTERM",
    };
    const signalName = knownSignals[signalNumber] ?? `signal ${signalNumber}`;
    super(
      `Claude Code process killed by ${signalName} (exit code ${exitCode})`
    );
    this.name = "SignalExitError";
    this.exitCode = exitCode;
    this.signalNumber = signalNumber;
    this.signalName = signalName;
  }
}

/**
 * Error thrown when the Claude Code child process exits with a non-zero,
 * non-signal exit code (1-127). Carries the structured exit code so the
 * launcher's diagnostic emitter can report it instead of null. Parallel
 * to SignalExitError — separate classes preserve the launcher's retry-budget
 * branching logic (signal vs crash retry counters).
 *
 * Issue #1239 — before this class existed, the close handler wrapped the
 * structured `code` value in a generic Error whose only payload was the
 * message string, leaving exit-diagnostics with `exitCode: null`.
 */
export class ChildExitError extends Error {
  readonly exitCode: number;
  // Diagnostic data captured at exit time (mirrors SignalExitError)
  procStatus: Record<string, string> | null = null;
  childPid: number | undefined = undefined;
  // Issue #1239 PR D: last ~8 KB of the child's stderr stream. Captures the
  // content parseStderrApiError discarded so the launcher can include it
  // in diagnostic emissions. `undefined` when stderr was silent.
  stderrTail: string | undefined = undefined;

  constructor(exitCode: number) {
    super(`Claude Code process exited with code ${exitCode}`);
    this.name = "ChildExitError";
    this.exitCode = exitCode;
  }
}
