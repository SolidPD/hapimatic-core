// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Main query implementation for Claude Code SDK
 * Handles spawning Claude process and managing message streams
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { Stream } from "./stream";
import {
  type AppliedSettings,
  type QueryOptions,
  type QueryPrompt,
  type SDKMessage,
  type ControlResponseHandler,
  type SDKControlRequest,
  type ControlRequest,
  type ContextUsageDetailPayload,
  type ContextUsagePayload,
  type GetContextUsageRequest,
  type SideQuestionAnswer,
  type SideQuestionRequest,
  type SDKControlResponse,
  type CanCallToolCallback,
  type CanUseToolControlRequest,
  type CanUseToolControlResponse,
  type ControlCancelRequest,
  type PermissionResult,
  AbortError,
  ChildExitError,
  SdkRequestError,
  SignalExitError,
} from "./types";
import { getDefaultClaudeCodePath, logDebug, streamToStdin } from "./utils";
import { withBunRuntimeEnv } from "@/utils/bunRuntime";
import { buildHarnessChildEnv } from "@/sandbox/secretEnvVars";
import { buildSdkSpawnEnv } from "@/claude/launcherShared";
import { killProcessByChildProcess } from "@/utils/process";
import { readProcStatus } from "@/claude/utils/exitDiagnostics";
import type { Writable } from "node:stream";
import { isEffortLevel } from "@hapi/protocol/effort";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import { logger } from "@/ui/logger";
import { appendMcpConfigArg } from "../utils/mcpConfig";
import {
  groupMcpServers,
  type McpServerStatus,
  type McpServerUsage,
} from "@hapi/protocol";
import { readMcpStatusReply } from "./mcpStatusReply";

/**
 * Parse a stderr line from Claude Code for API error/retry patterns.
 * Returns a synthetic SDKMessage if the line matches, null otherwise.
 *
 * Known patterns:
 * - "Retrying in 21 seconds... (attempt 7/10)"
 * - "API Error: 500 {...}"
 * - "529 {...}" (overloaded)
 * - "Thundering... (50s)"
 */
export function parseStderrApiError(line: string): SDKMessage | null {
  // Retry countdown: "Retrying in 21 seconds... (attempt 7/10)"
  const retryMatch = line.match(
    /^Retrying in (\d+) seconds?\.{3}\s*\(attempt (\d+)\/(\d+)\)$/
  );
  if (retryMatch) {
    return {
      type: "system",
      subtype: "api_error",
      retryAttempt: parseInt(retryMatch[2], 10),
      maxRetries: parseInt(retryMatch[3], 10),
      retryInSeconds: parseInt(retryMatch[1], 10),
      isThundering: false,
      error: { type: "retry", message: line },
    };
  }

  // Thundering state: "Thundering... (50s)"
  const thunderMatch = line.match(/^Thundering\.{3}\s*\((\d+)s\)$/);
  if (thunderMatch) {
    return {
      type: "system",
      subtype: "api_error",
      retryAttempt: 0,
      maxRetries: 0,
      retryInSeconds: 0,
      isThundering: true,
      thunderingDurationSeconds: parseInt(thunderMatch[1], 10),
      error: { type: "thundering", message: line },
    };
  }

  // API Error with status: "API Error: 500 {...}"
  const apiErrorMatch = line.match(/^API Error: (\d+) (.+)$/);
  if (apiErrorMatch) {
    let errorBody: unknown = apiErrorMatch[2];
    try {
      errorBody = JSON.parse(apiErrorMatch[2]);
    } catch {
      // Keep as string if not valid JSON
    }
    return {
      type: "system",
      subtype: "api_error",
      retryAttempt: 0,
      maxRetries: 0,
      retryInSeconds: 0,
      isThundering: false,
      error: {
        type: "api_error",
        statusCode: parseInt(apiErrorMatch[1], 10),
        body: errorBody,
        message: line,
      },
    };
  }

  // Overloaded: "529 {...}"
  const overloadMatch = line.match(/^529 (.+)$/);
  if (overloadMatch) {
    let errorBody: unknown = overloadMatch[1];
    try {
      errorBody = JSON.parse(overloadMatch[1]);
    } catch {
      // Keep as string if not valid JSON
    }
    return {
      type: "system",
      subtype: "api_error",
      retryAttempt: 0,
      maxRetries: 0,
      retryInSeconds: 0,
      isThundering: false,
      error: {
        type: "overloaded_error",
        statusCode: 529,
        body: errorBody,
        message: line,
      },
    };
  }

  return null;
}

/**
 * Issue #6169: how long a cancelled side question's progress lines are still
 * dropped. Claude Code keeps a side-question fork retrying for up to 660 s.
 */
const SIDE_QUESTION_CANCEL_GRACE_MS = 11 * 60_000;

/**
 * Conventional UNIX signal numbers we map to exit codes when Node delivers a
 * `null` exit code with a named signal. Used by classifyChildExit. Matches
 * the legacy inline table that lived in the close handler before #1239 PR C.
 */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGABRT: 6,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGTERM: 15,
};

/**
 * Issue #1239 PR D: maximum bytes of child stderr to retain in the
 * post-mortem diagnostic ring buffer. Sized so the captured tail fits
 * comfortably in the SQLite `error_logs.context` field (TEXT column) and
 * the `~/.claude/logs/session-exits.jsonl` per-line entries stay well under
 * 16 KB even with full diagnostic enrichment. 8 KB is enough for a typical
 * Node/Bun stack trace (≤200 frames at ≤40 chars/frame).
 */
export const STDERR_TAIL_MAX_BYTES = 8192;

/**
 * Issue #1239 PR D: append `chunk` to a stderr ring-buffer string capped at
 * `maxLen` characters; older content is sliced off the front when the cap
 * is exceeded. Returns the new ring value (callers reassign).
 *
 * Pure function — extracted from the `child.stderr.on("data", ...)` handler
 * so the truncation invariant is testable without spawning a subprocess.
 * The cap counts characters, not bytes; stderr is decoded as UTF-8 strings
 * before reaching the ring so multi-byte sequences are preserved intact.
 */
export function appendToStderrRing(
  ring: string,
  chunk: string,
  maxLen: number = STDERR_TAIL_MAX_BYTES
): string {
  const combined = ring + chunk;
  return combined.length > maxLen
    ? combined.slice(combined.length - maxLen)
    : combined;
}

/**
 * Issue #1239: classify a Node.js `child_process` 'close' event into the
 * appropriate typed exit error (or null for a clean exit).
 *
 * Pure function — no I/O, no side effects, no /proc reads. The caller is
 * responsible for attaching `procStatus`/`childPid` diagnostic fields after
 * construction (kept outside this helper because they are environment-specific
 * and require process-tree introspection at the close-event time).
 *
 * Branches:
 * - `code === null` → external signal kill (OOM killer, `kill -9`, system
 *   reboot). Returns `SignalExitError(128 + signum)` using the supplied
 *   signal name; defaults to SIGKILL (9) when the signal is unknown or null.
 * - `code === 0` → clean exit. Returns `null`.
 * - `code >= 128` → exit code already encodes a signal as `128 + signum`.
 *   Returns `SignalExitError(code)` (e.g. 143 = SIGTERM).
 * - `1 <= code < 128` → non-signal crash. Returns `ChildExitError(code)`.
 *   This is the path PR A of #1239 added; previously the structured code was
 *   wrapped in a generic `Error` and the launcher's diagnostic emitter could
 *   not extract it, leaving `exitCode: null` in `~/.claude/logs/session-exits.jsonl`
 *   and the SQLite `error_logs` table.
 */
export function classifyChildExit(
  code: number | null,
  signal: NodeJS.Signals | null
): SignalExitError | ChildExitError | null {
  if (code === null) {
    const sigNum = signal ? (SIGNAL_NUMBERS[signal] ?? 9) : 9;
    return new SignalExitError(128 + sigNum);
  }
  if (code === 0) return null;
  if (code >= 128) return new SignalExitError(code);
  return new ChildExitError(code);
}

/**
 * Issue #6170: how long a `detail: "full"` get_context_usage may wait for
 * Claude Code. Below the server's 30 s RPC timeout (`rpcGateway.ts`), so a
 * request the caller has already given up on never stays pending here.
 */
export const CONTEXT_USAGE_DETAIL_TIMEOUT_MS = 25_000;

/** Issue #6171: a live `mcp_status` read is short; the poll fallback is slower. */
export const MCP_STATUS_TIMEOUT_MS = 10_000;

/**
 * Read the get_context_usage payload, which sits at
 * control_response.response.response (the same double-nest the can_use_tool
 * response uses). Throws on a malformed shape so a per-turn caller's catch
 * keeps the last-known value. Issue #1469.
 */
function readContextUsageReply(
  res: SDKControlResponse["response"]
): Record<string, unknown> & { model: string; maxTokens: number } {
  const data = (res as { response?: unknown }).response as
    | Record<string, unknown>
    | undefined;
  if (
    !data ||
    typeof data.maxTokens !== "number" ||
    typeof data.model !== "string"
  ) {
    throw new Error("get_context_usage returned an unexpected payload shape");
  }
  return data as Record<string, unknown> & {
    model: string;
    maxTokens: number;
  };
}

/**
 * Issue #6171: the reply's MCP tool and instruction rows, keeping only rows of
 * the shape `groupMcpServers` reads (a malformed row is dropped, never thrown).
 */
function readMcpUsage(data: Record<string, unknown>): {
  mcpTools: Array<{
    name: string;
    serverName: string;
    tokens: number;
    isLoaded?: boolean;
  }>;
  mcpInstructions: Array<{ serverName: string; tokens: number }>;
} {
  const rows = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value)
      ? value.filter(
          (row): row is Record<string, unknown> =>
            !!row &&
            typeof row === "object" &&
            typeof (row as { serverName?: unknown }).serverName === "string" &&
            typeof (row as { tokens?: unknown }).tokens === "number"
        )
      : [];
  return {
    mcpTools: rows(data.mcpTools).map(row => ({
      name: typeof row.name === "string" ? row.name : "",
      serverName: row.serverName as string,
      tokens: row.tokens as number,
      ...(typeof row.isLoaded === "boolean" ? { isLoaded: row.isLoaded } : {}),
    })),
    mcpInstructions: rows(data.mcpInstructions).map(row => ({
      serverName: row.serverName as string,
      tokens: row.tokens as number,
    })),
  };
}

/** The five fields every caller relies on, with #1469's fallbacks. */
function normalizeContextUsage(
  data: Record<string, unknown> & { model: string; maxTokens: number }
): ContextUsagePayload {
  return {
    model: data.model,
    maxTokens: data.maxTokens,
    rawMaxTokens:
      typeof data.rawMaxTokens === "number"
        ? data.rawMaxTokens
        : data.maxTokens,
    totalTokens: typeof data.totalTokens === "number" ? data.totalTokens : 0,
    percentage: typeof data.percentage === "number" ? data.percentage : 0,
  };
}

/**
 * Query class manages Claude Code process interaction
 */
export class Query implements AsyncIterableIterator<SDKMessage> {
  private pendingControlResponses = new Map<string, ControlResponseHandler>();
  private cancelControllers = new Map<string, AbortController>();
  /**
   * Issue #6169: side questions in flight, or cancelled within the last 11
   * minutes, whose progress lines are dropped.
   */
  private sideQuestionRequestIds = new Set<string>();
  private sdkMessages: AsyncIterableIterator<SDKMessage>;
  private inputStream = new Stream<SDKMessage>();
  private canCallTool?: CanCallToolCallback;

  constructor(
    private childStdin: Writable | null,
    private childStdout: NodeJS.ReadableStream,
    private processExitPromise: Promise<void>,
    canCallTool?: CanCallToolCallback
  ) {
    this.canCallTool = canCallTool;
    this.readMessages();
    this.sdkMessages = this.readSdkMessages();
  }

  /**
   * Set an error on the stream
   */
  setError(error: Error): void {
    this.inputStream.error(error);
  }

  /**
   * Inject a synthetic message into the stream.
   * Used by the stderr parser to emit API error/retry events.
   */
  injectMessage(message: SDKMessage): void {
    this.inputStream.enqueue(message);
  }

  /**
   * AsyncIterableIterator implementation
   */
  next(...args: [] | [undefined]): Promise<IteratorResult<SDKMessage>> {
    return this.sdkMessages.next(...args);
  }

  return(value?: unknown): Promise<IteratorResult<SDKMessage>> {
    if (this.sdkMessages.return) {
      return this.sdkMessages.return(value);
    }
    return Promise.resolve({ done: true, value: undefined });
  }

  throw(e: unknown): Promise<IteratorResult<SDKMessage>> {
    if (this.sdkMessages.throw) {
      return this.sdkMessages.throw(e);
    }
    return Promise.reject(e);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage> {
    return this.sdkMessages;
  }

  /**
   * Read messages from Claude process stdout
   */
  private async readMessages(): Promise<void> {
    const rl = createInterface({ input: this.childStdout });

    try {
      for await (const line of rl) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line) as SDKMessage | SDKControlResponse;

            if (message.type === "control_response") {
              const controlResponse = message as SDKControlResponse;
              const requestId = controlResponse.response.request_id;
              const handler = this.pendingControlResponses.get(requestId);
              if (handler) {
                // Issue #6166 (in-path): a request gets one answer, so drop
                // its handler now instead of holding it until the child exits.
                this.pendingControlResponses.delete(requestId);
                handler(controlResponse.response);
              }
              continue;
            } else if (message.type === "control_request") {
              await this.handleControlRequest(
                message as unknown as CanUseToolControlRequest
              );
              continue;
            } else if (message.type === "control_cancel_request") {
              this.handleControlCancelRequest(
                message as unknown as ControlCancelRequest
              );
              continue;
            } else if (this.isSideQuestionProgress(message)) {
              // Issue #6169: a keep-alive's progress line is control-plane noise;
              // keep it out of the conversation stream entirely.
              continue;
            }

            this.inputStream.enqueue(message);
          } catch (e) {
            // Issue #6166: a control_response can carry a get_settings answer —
            // the merged settings, env blocks included, which can hold secrets —
            // so neither its raw line nor the error (a JSON parse error quotes
            // the offending token) reaches the log; the error class does.
            if (line.includes('"control_response"')) {
              logger.debug(
                `[Query] Failed to handle a control_response line (${
                  e instanceof Error ? e.name : typeof e
                }; ${line.length} chars, content redacted)`
              );
            } else {
              logger.debug(
                `[Query] Failed to parse stdout line: ${e instanceof Error ? e.message : e}`
              );
              logger.debug(`[Query] Raw line: ${line}`);
            }
          }
        }
      }
      await this.processExitPromise;
    } catch (error) {
      this.inputStream.error(error as Error);
    } finally {
      this.inputStream.done();
      this.cleanupControllers();
      rl.close();
    }
  }

  /**
   * Issue #6169: a `system/control_request_progress` line belonging to a side
   * question this Query sent. Every other progress line passes through.
   */
  private isSideQuestionProgress(message: unknown): boolean {
    if (this.sideQuestionRequestIds.size === 0) return false;
    if (!message || typeof message !== "object") return false;
    const m = message as {
      type?: unknown;
      subtype?: unknown;
      request_id?: unknown;
    };
    return (
      m.type === "system" &&
      m.subtype === "control_request_progress" &&
      typeof m.request_id === "string" &&
      this.sideQuestionRequestIds.has(m.request_id)
    );
  }

  /**
   * Async generator for SDK messages
   */
  private async *readSdkMessages(): AsyncIterableIterator<SDKMessage> {
    for await (const message of this.inputStream) {
      yield message;
    }
  }

  /**
   * Send interrupt request to Claude
   */
  async interrupt(): Promise<void> {
    if (!this.childStdin) {
      throw new Error("Interrupt requires --input-format stream-json");
    }

    await this.request(
      {
        subtype: "interrupt",
      },
      this.childStdin
    );
  }

  /**
   * Enable or disable an MCP server on the running Claude process.
   * Delivers the mcp_toggle SDK control_request defined by Claude Code's
   * headless handler (cli/print.ts mcp_toggle subtype) via the existing
   * stream-JSON stdin pipe. Resolves on control_response success, rejects on
   * control_response error (e.g., server not found).
   */
  async mcpToggle(serverName: string, enabled: boolean): Promise<void> {
    if (!this.childStdin) {
      throw new Error("mcpToggle requires --input-format stream-json");
    }

    await this.request(
      {
        subtype: "mcp_toggle",
        serverName,
        enabled,
      } as ControlRequest,
      this.childStdin
    );
  }

  /**
   * Issue #6171: this Claude process's own MCP server state, via the `mcp_status`
   * control_request (measured on Claude Code 2.1.312; see `readMcpStatusReply`).
   * A server the session's MCP set denies is absent, so this is the session's
   * truth where `claude mcp list` shows the project's. An older binary answers
   * the unknown subtype with an error control_response, which rejects here.
   */
  async getMcpServerStatus(): Promise<McpServerStatus[]> {
    if (!this.childStdin) {
      throw new Error("getMcpServerStatus requires --input-format stream-json");
    }
    const res = await this.request(
      { subtype: "mcp_status" } as ControlRequest,
      this.childStdin,
      { timeoutMs: MCP_STATUS_TIMEOUT_MS }
    );
    return readMcpStatusReply(res);
  }

  /**
   * Fetch Claude Code's authoritative context-usage snapshot via the
   * get_context_usage SDK control_request. Unlike mcpToggle (which discards
   * the response), this RETURNS the slim first-order payload — the effective
   * context window (maxTokens) and live usage. Claude Code answers whenever
   * its stdin reader runs, between turns too; there is no idle refusal (the
   * `no_active_query` code is Hapimatic's own, for "no Claude process
   * attached"). Sends no `detail`, exactly as before #6170. Issue #1469.
   */
  async getContextUsage(): Promise<ContextUsagePayload> {
    return (await this.getTurnContextUsage()).usage;
  }

  /**
   * Issue #6171: the same request as {@link getContextUsage}, whose reply also
   * lists each MCP tool and server instruction (F21), so one call gives both the
   * header figures (unchanged) and each server's context cost. No new request.
   *
   * #6409 item 1: this per-turn call keeps the full detail (no `detail` key) on
   * purpose. Measured on Claude Code 2.1.321
   * (https://github.com/MattStarfield/hapimatic-private/issues/6409#issuecomment-6788014732):
   * - `detail: "summary"` gave the same header (`totalTokens`, `percentage`,
   *   `maxTokens`, `model`) in 17 of 17 pairs at the first assistant message;
   * - Claude Code memoizes full counts in each process (an in-memory cache keyed
   *   by content), so a later read with nothing changed makes no count call
   *   (median 36.7 ms, against 43.3 ms for summary);
   * - every new process, a restart and a `--resume` included, makes 26 free
   *   `count_tokens` calls on its first full read; an MCP toggle costs 2 and
   *   `/compact` 3;
   * - summary would turn the per-server costs below into local estimates about
   *   20 % low.
   */
  async getTurnContextUsage(): Promise<{
    usage: ContextUsagePayload;
    mcpServers: McpServerUsage[];
  }> {
    if (!this.childStdin) {
      throw new Error("getContextUsage requires --input-format stream-json");
    }

    const request: GetContextUsageRequest = { subtype: "get_context_usage" };
    const res = await this.request(request, this.childStdin);
    const data = readContextUsageReply(res);
    return {
      usage: normalizeContextUsage(data),
      mcpServers: groupMcpServers(readMcpUsage(data)),
    };
  }

  /**
   * Issue #6170: the full get_context_usage reply (`detail: "full"`) — every
   * category, memory file, MCP tool and server instruction, agent, skill and
   * message part Claude Code reports, passed through unchanged with the five
   * {@link getContextUsage} fields normalized on top. Bounded by
   * CONTEXT_USAGE_DETAIL_TIMEOUT_MS so a reply that never comes cannot outlive
   * the server's 30 s RPC timeout.
   */
  async getContextUsageDetail(): Promise<ContextUsageDetailPayload> {
    if (!this.childStdin) {
      throw new Error(
        "getContextUsageDetail requires --input-format stream-json"
      );
    }

    const request: GetContextUsageRequest = {
      subtype: "get_context_usage",
      detail: "full",
    };
    const res = await this.request(request, this.childStdin, {
      timeoutMs: CONTEXT_USAGE_DETAIL_TIMEOUT_MS,
    });
    const data = readContextUsageReply(res);
    return { ...data, ...normalizeContextUsage(data) };
  }

  /**
   * Read the effort and model the Claude process actually applies, via the
   * get_settings control request (issue #6166) — after a CLAUDE_CODE_EFFORT_LEVEL
   * override (process env or a settings.json env block) and after a model remaps
   * a level it lacks. It needs no `initialize` request. Returns ONLY
   * `{ effort, model }`: the answer's `effective` and `sources` carry the merged
   * settings, `env` blocks included, which can hold secrets, so the raw answer is
   * never logged or stored. An older binary answers the unknown subtype with an
   * error control_response, which rejects here. No timeout: the answer can queue
   * behind a permission prompt. A clean exit rejects a pending request
   * (cleanupControllers); an aborted or crashed child leaves it unsettled, which
   * is harmless only because the caller never awaits it (readBackAppliedEffort).
   */
  async getAppliedSettings(): Promise<AppliedSettings> {
    if (!this.childStdin) {
      throw new Error("getAppliedSettings requires --input-format stream-json");
    }

    const res = await this.request(
      { subtype: "get_settings" } as ControlRequest,
      this.childStdin
    );
    // The settings payload is nested at control_response.response.response, the
    // same double-nest get_context_usage uses.
    const payload = (res as { response?: unknown }).response;
    const applied =
      payload && typeof payload === "object"
        ? (payload as { applied?: unknown }).applied
        : undefined;
    if (!applied || typeof applied !== "object") {
      return { effort: undefined, model: undefined };
    }
    const { effort, model } = applied as { effort?: unknown; model?: unknown };
    return {
      effort:
        effort === null ? null : isEffortLevel(effort) ? effort : undefined,
      model: typeof model === "string" && model.length > 0 ? model : undefined,
    };
  }

  /**
   * Issue #6169: ask Claude Code a side question — the prompt-cache keep-alive.
   * Claude Code runs it as a one-shot fork on the main conversation's cache
   * prefix (no tools, no transcript line, no hooks), so the fork's request reads
   * the cache and renews its lifetime; the main agent never sees it. Bounded by
   * `timeoutMs` because `request()` has no closed-state guard: an untimed request
   * written after the child's stdin ended would never settle. The answer text is
   * returned but never logged. `sentAt` is when the request line was written —
   * the cache touch the caller records.
   */
  async askSideQuestion(
    question: string,
    opts: { timeoutMs: number }
  ): Promise<SideQuestionAnswer> {
    if (!this.childStdin) {
      throw new Error("askSideQuestion requires --input-format stream-json");
    }

    let sentAt = 0;
    let requestId: string | null = null;
    let timedOut = false;
    const request: SideQuestionRequest = { subtype: "side_question", question };
    try {
      const res = await this.request(request, this.childStdin, {
        timeoutMs: opts.timeoutMs,
        onSent: id => {
          sentAt = Date.now();
          requestId = id;
          this.sideQuestionRequestIds.add(id);
        },
      });
      // Nested at control_response.response.response, like get_context_usage.
      const payload = (res as { response?: unknown }).response;
      const answer =
        payload && typeof payload === "object"
          ? (payload as { response?: unknown; synthetic?: unknown })
          : {};
      return {
        response: typeof answer.response === "string" ? answer.response : null,
        synthetic: answer.synthetic === true,
        sentAt,
      };
    } catch (err) {
      if (
        requestId !== null &&
        err instanceof SdkRequestError &&
        err.code === "timeout"
      ) {
        timedOut = true;
        this.cancelSideQuestion(requestId);
      }
      throw err;
    } finally {
      if (requestId !== null && !timedOut) {
        this.sideQuestionRequestIds.delete(requestId);
      }
    }
  }

  /**
   * A timed-out side question keeps running in Claude Code (it retries on its
   * own for minutes), so cancel it, and keep dropping its progress lines for the
   * longest it could still emit them.
   */
  private cancelSideQuestion(requestId: string): void {
    try {
      this.childStdin?.write(
        JSON.stringify({
          type: "control_cancel_request",
          request_id: requestId,
        }) + "\n"
      );
    } catch (err) {
      logger.debug(`[cache-keepalive] cancel write failed: ${String(err)}`);
    }
    const forget = setTimeout(
      () => this.sideQuestionRequestIds.delete(requestId),
      SIDE_QUESTION_CANCEL_GRACE_MS
    );
    forget.unref?.();
  }

  /**
   * Set the model for subsequent conversation turns on the running Claude
   * process via the set_model SDK control_request (issue #2256). Delivers the
   * subtype through the existing stream-JSON stdin pipe, mirroring mcpToggle
   * (a void control request — discard the response). `model` is the resolved
   * raw `--model` value (e.g. "opus", "fable[1m]"), the same value the query
   * was launched with — never a bare display mode.
   *
   * NOTE: distinct from the Session.setModel display-state setter
   * (cli/src/claude/session.ts) — different class, no collision.
   */
  async setModel(model: string): Promise<void> {
    if (!this.childStdin) {
      throw new Error("setModel requires --input-format stream-json");
    }

    await this.request(
      {
        subtype: "set_model",
        model,
      } as ControlRequest,
      this.childStdin
    );
  }

  /**
   * Set the permission mode for subsequent conversation turns on the running
   * Claude process via the set_permission_mode SDK control_request (issue #2346).
   * Delivers the subtype through the existing stream-JSON stdin pipe, mirroring
   * mcpToggle / setModel (a void control request — discard the response). `mode`
   * is a PermissionMode (validated claude-flavor upstream). Empirically confirmed
   * to mutate a LIVE query (Task 1): the flip is reflected in the running query's
   * re-emitted permissionMode and its tool-gating behavior.
   *
   * NOTE: distinct from the Session.setPermissionMode display-state setter
   * (cli/src/claude/session.ts:99) — different class, no collision. Both take a
   * PermissionMode, so a misdirected call would compile cleanly; this one delivers
   * a control_request to the SDK subprocess, that one flips an in-memory field.
   */
  async setPermissionMode(mode: ClaudePermissionMode): Promise<void> {
    if (!this.childStdin) {
      throw new Error("setPermissionMode requires --input-format stream-json");
    }

    await this.request(
      {
        subtype: "set_permission_mode",
        mode,
      } as ControlRequest,
      this.childStdin
    );
  }

  /**
   * Send control request to Claude process. With `timeoutMs`, an unanswered
   * request is dropped and rejects with code `timeout` (#6170); without it the
   * request waits for a reply or the process exit, as before.
   */
  private request(
    request: ControlRequest,
    childStdin: Writable,
    opts?: {
      timeoutMs?: number;
      /** Issue #6169: called once the request line is written, with its id. */
      onSent?: (requestId: string) => void;
    }
  ): Promise<SDKControlResponse["response"]> {
    const requestId = Math.random().toString(36).substring(2, 15);
    const sdkRequest: SDKControlRequest = {
      request_id: requestId,
      type: "control_request",
      request,
    };

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts?.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.pendingControlResponses.delete(requestId);
          reject(
            new SdkRequestError(
              `Control request ${request.subtype} timed out after ${opts.timeoutMs} ms`,
              "timeout"
            )
          );
        }, opts.timeoutMs);
      }
      this.pendingControlResponses.set(requestId, response => {
        // A reply settles the request: forget it so the map holds only
        // requests still waiting (cleanupControllers drains those on exit).
        this.pendingControlResponses.delete(requestId);
        if (timer !== undefined) clearTimeout(timer);
        if (response.subtype === "success") {
          resolve(response);
        } else {
          reject(
            new SdkRequestError(
              response.error ?? "Control request failed",
              response.code
            )
          );
        }
      });

      childStdin.write(JSON.stringify(sdkRequest) + "\n");
      opts?.onSent?.(requestId);
    });
  }

  /**
   * Handle incoming control requests for tool permissions
   * Replicates the exact logic from the SDK's handleControlRequest method
   */
  private async handleControlRequest(
    request: CanUseToolControlRequest
  ): Promise<void> {
    if (!this.childStdin) {
      logDebug("Cannot handle control request - no stdin available");
      return;
    }

    const controller = new AbortController();
    this.cancelControllers.set(request.request_id, controller);

    try {
      const response = await this.processControlRequest(
        request,
        controller.signal
      );
      const controlResponse: CanUseToolControlResponse = {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: request.request_id,
          response,
        },
      };
      this.childStdin.write(JSON.stringify(controlResponse) + "\n");
    } catch (error) {
      const controlErrorResponse: CanUseToolControlResponse = {
        type: "control_response",
        response: {
          subtype: "error",
          request_id: request.request_id,
          error: error instanceof Error ? error.message : String(error),
        },
      };
      this.childStdin.write(JSON.stringify(controlErrorResponse) + "\n");
    } finally {
      this.cancelControllers.delete(request.request_id);
    }
  }

  /**
   * Handle control cancel requests
   * Replicates the exact logic from the SDK's handleControlCancelRequest method
   */
  private handleControlCancelRequest(request: ControlCancelRequest): void {
    const controller = this.cancelControllers.get(request.request_id);
    if (controller) {
      controller.abort();
      this.cancelControllers.delete(request.request_id);
    }
  }

  /**
   * Process control requests based on subtype
   * Replicates the exact logic from the SDK's processControlRequest method
   */
  private async processControlRequest(
    request: CanUseToolControlRequest,
    signal: AbortSignal
  ): Promise<PermissionResult> {
    if (request.request.subtype === "can_use_tool") {
      if (!this.canCallTool) {
        throw new Error("canCallTool callback is not provided.");
      }
      return this.canCallTool(
        request.request.tool_name,
        request.request.input,
        {
          signal,
        }
      );
    }

    throw new Error(
      "Unsupported control request subtype: " + request.request.subtype
    );
  }

  /**
   * Cleanup method to abort all pending control requests and drain pending
   * control-response handlers. Without draining pendingControlResponses, any
   * Promise returned by request() (interrupt, mcp_toggle, etc.) will hang
   * forever if the Claude subprocess exits before its control_response arrives.
   */
  private cleanupControllers(): void {
    for (const [requestId, controller] of this.cancelControllers.entries()) {
      controller.abort();
      this.cancelControllers.delete(requestId);
    }
    for (const [requestId, handler] of this.pendingControlResponses.entries()) {
      handler({
        request_id: requestId,
        subtype: "error",
        error: "Claude process exited before responding",
        code: "claude_exited",
      });
      this.pendingControlResponses.delete(requestId);
    }
  }
}

/**
 * Main query function to interact with Claude Code
 */
/**
 * Spec for {@link buildClaudeSpawnArgs}. Reuses the relevant {@link QueryOptions}
 * fields, plus two derived inputs that the destructure in {@link query} computes
 * (`continue` is renamed to avoid the reserved word; `hasCanCallTool` collapses
 * the callback presence to a boolean).
 */
type ClaudeSpawnArgsSpec = Pick<
  QueryOptions,
  | "customSystemPrompt"
  | "appendSystemPrompt"
  | "maxTurns"
  | "model"
  | "effort"
  | "safeMode"
  | "forkSession"
  | "resume"
  | "settingsPath"
  | "allowedTools"
  | "disallowedTools"
  | "strictMcpConfig"
  | "permissionMode"
  | "fallbackModel"
> & {
  /** True when a canCallTool callback is present → push --permission-prompt-tool stdio. */
  hasCanCallTool?: boolean;
  /** QueryOptions.continue, renamed in query()'s destructure to avoid the reserved word. */
  continueConversation?: boolean;
};

/**
 * Pure construction of the base `claude` spawn argv from query options.
 *
 * Exported (mirrors classifyChildExit / appendToStderrRing) so the argv —
 * including issue #1854's --fork-session — can be unit-tested without spawning a
 * real claude process. Excludes the prompt-input (--print / --input-format) and
 * MCP-config flags, which depend on runtime state handled directly in query().
 */
export function buildClaudeSpawnArgs(spec: ClaudeSpawnArgsSpec): string[] {
  const {
    customSystemPrompt,
    appendSystemPrompt,
    maxTurns,
    model,
    effort,
    safeMode,
    forkSession,
    hasCanCallTool,
    continueConversation,
    resume,
    settingsPath,
    allowedTools = [],
    disallowedTools = [],
    strictMcpConfig,
    permissionMode,
    fallbackModel,
  } = spec;

  const args = ["--output-format", "stream-json", "--verbose"];
  // --replay-user-messages intentionally omitted (causes duplicate user records)

  if (customSystemPrompt) args.push("--system-prompt", customSystemPrompt);
  if (appendSystemPrompt)
    args.push("--append-system-prompt", appendSystemPrompt);
  if (maxTurns) args.push("--max-turns", maxTurns.toString());
  if (model) args.push("--model", model);
  // Issue #2456: reasoning-effort passthrough. The binary accepts --effort
  // natively (claude 2.1.220); an unset effort omits the flag entirely, keeping
  // the spawn byte-identical to pre-#2456 sessions.
  if (effort) args.push("--effort", effort);
  if (safeMode) args.push("--safe-mode");
  if (hasCanCallTool) args.push("--permission-prompt-tool", "stdio");
  if (continueConversation) args.push("--continue");
  if (resume) args.push("--resume", resume);
  // Issue #1854: --fork-session forces a NEW claude session id when resuming,
  // so a branch session forks the parent's transcript instead of sharing it.
  // Pushed immediately after --resume (mirrors the daemon's buildClaudeCommand
  // ordering); only meaningful alongside a resume/continue context, which a
  // branch spawn always has.
  if (forkSession) args.push("--fork-session");
  if (settingsPath) args.push("--settings", settingsPath);
  if (allowedTools.length > 0)
    args.push("--allowedTools", allowedTools.join(","));
  if (disallowedTools.length > 0)
    args.push("--disallowedTools", disallowedTools.join(","));
  if (strictMcpConfig) args.push("--strict-mcp-config");
  if (permissionMode) args.push("--permission-mode", permissionMode);

  if (fallbackModel) {
    if (model && fallbackModel === model) {
      throw new Error(
        "Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option."
      );
    }
    args.push("--fallback-model", fallbackModel);
  }

  return args;
}

export function query(config: {
  prompt: QueryPrompt;
  options?: QueryOptions;
}): Query {
  const {
    prompt,
    options: {
      allowedTools = [],
      appendSystemPrompt,
      customSystemPrompt,
      cwd,
      disallowedTools = [],
      maxTurns,
      mcpServers,
      pathToClaudeCodeExecutable = getDefaultClaudeCodePath(),
      permissionMode = "default",
      continue: continueConversation,
      resume,
      model,
      fallbackModel,
      effort,
      settingsPath,
      strictMcpConfig,
      canCallTool,
      safeMode,
      forkSession,
      bindingEnvVars,
      apiKeyHelperSession,
    } = {},
  } = config;

  // Set entrypoint if not already set.
  // #1734 (OmniBox Phase 0a, in-path hardening — research code-review #4):
  // remember whether THIS invocation set it, so the exit-cleanup below can
  // delete it and stop CLAUDE_CODE_ENTRYPOINT=sdk-ts from persisting in the
  // long-lived wrapper process.env (a billing-signal persistence, the #1692
  // class — it would otherwise bleed into a later same-process spawn).
  const entrypointWasUnset = !process.env.CLAUDE_CODE_ENTRYPOINT;
  if (entrypointWasUnset) {
    process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
  }

  // Build command arguments. The base flag construction is extracted into the
  // exported, pure buildClaudeSpawnArgs() so the spawn argv — including issue
  // #1854's --fork-session — is unit-testable without spawning a real process.
  let cleanupMcpConfig: (() => void) | null = null;

  // canCallTool requires a streaming (non-string) prompt. This precondition
  // depends on the prompt type (not just the options), so it stays here rather
  // than inside buildClaudeSpawnArgs.
  if (canCallTool && typeof prompt === "string") {
    throw new Error(
      "canCallTool callback requires --input-format stream-json. Please set prompt as an AsyncIterable."
    );
  }

  const args = buildClaudeSpawnArgs({
    customSystemPrompt,
    appendSystemPrompt,
    maxTurns,
    model,
    effort,
    safeMode,
    forkSession,
    hasCanCallTool: Boolean(canCallTool),
    continueConversation,
    resume,
    settingsPath,
    allowedTools,
    disallowedTools,
    strictMcpConfig,
    permissionMode,
    fallbackModel,
  });

  // Handle prompt input
  if (typeof prompt === "string") {
    args.push("--print", prompt.trim());
  } else {
    args.push("--input-format", "stream-json");
  }

  // Determine how to spawn Claude Code
  // - If it's just 'claude' command → spawn('claude', args) with shell on Windows
  // - If it's a full path to binary or script → spawn(path, args)
  const isCommandOnly = pathToClaudeCodeExecutable === "claude";

  // Validate executable path (skip for command-only mode)
  if (!isCommandOnly && !existsSync(pathToClaudeCodeExecutable)) {
    throw new ReferenceError(
      `Claude Code executable not found at ${pathToClaudeCodeExecutable}. Is options.pathToClaudeCodeExecutable set?`
    );
  }

  const spawnCommand = pathToClaudeCodeExecutable;
  const spawnArgs = args;

  cleanupMcpConfig = appendMcpConfigArg(spawnArgs, mcpServers);

  // Spawn Claude Code process.
  // #1734 (OmniBox Phase 0a) — THE critical gap: the default `sdk` launcher
  // NEVER routes through buildLauncherEnv, so without this strip the Claude
  // child inherits the wrapper's full process.env including CLI_API_TOKEN
  // (runtime-verified, #1734 research). Strip the agent-secret set when the
  // sandbox is ON; gated by the kill-switch so sandbox-OFF is byte-identical to
  // pre-#1734 (R6). CLAUDE_CODE_OAUTH_TOKEN is intentionally NOT in that set — it
  // is an account-BINDING var, handled by buildSdkSpawnEnv below (#3731).
  //
  // #2383 (W3 of epic #2385) — the UNGATED strip below is load-bearing for cloud
  // VMs. A provisioned VM resolves to THIS launcher (no HAPI_CLAUDE_LAUNCHER in
  // either infrastructure/cloud-vm/*.service.example; provision.sh seeds
  // settings.json with no `launcher` key; launcherResolver defaults to "sdk"), and
  // it does not enable HAPI_OMNIBOX_SANDBOX. So a strip gated on the sandbox
  // switch would be a NO-OP on exactly the deployment the exposure lives on (the
  // account-binding set is handled separately, and ungated, by buildSdkSpawnEnv
  // below).
  //
  // #3731 (R1/R2): the account binding comes ONLY from the launcher's EXPLICIT set
  // (`bindingEnvVars` = claudeEnvVars). buildSdkSpawnEnv strips every
  // BINDING_ENV_VARS key from the ambient copy, then layers the explicit set. The
  // former "keep the ambient token" rule was wrong on the CLAUDE_CONFIG_DIR
  // isolation path: a provisioned VM's service env carried the onboarding token,
  // the child inherited it next to the isolated dir, and native Claude Code
  // preferred the env token — every bound session billed the onboarding account.
  // The env-token path still works because its token arrives in the explicit set
  // (withAccountToken; an unbound session's instance credential too — #3731 R2b).
  // Keep keying on the EXPLICIT set: `process.env` is ambient ∪ explicit here
  // (claudeRemote writes claudeEnvVars into it), so a presence-keyed delete would
  // strip an explicit token under an ambient CLAUDE_CONFIG_DIR.
  //
  // #3813: the ungated #2383 strip + the gated SECRET strip are the CLAUDE view of
  // the shared per-flavor helper (claude `keepSecrets` `[]` ⇒ the whole SECRET set
  // when the sandbox is ON; OFF ⇒ only the ungated #2383 set). Applied OUTERMOST so
  // it also covers the layered explicit set: for the ungated #2383 set this matches
  // buildLauncherEnv's post-`extra` re-strip; for the gated SECRET set it is
  // stricter (buildLauncherEnv strips secrets from the ambient copy only). It never
  // touches the binding vars.
  const spawnEnv = buildHarnessChildEnv(
    "claude",
    buildSdkSpawnEnv(
      withBunRuntimeEnv(process.env, { allowBunBeBun: false }),
      bindingEnvVars,
      { apiKeyHelperSession }
    )
  );
  logDebug(
    `Spawning Claude Code process: ${spawnCommand} ${spawnArgs.join(" ")}`
  );
  logDebug(`Spawn env PATH: ${spawnEnv.PATH ?? "(unset)"}`);

  const child = spawn(spawnCommand, spawnArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    signal: config.options?.abort,
    env: spawnEnv,
    // Use shell on Windows for command resolution
    shell: process.platform === "win32",
  }) as ChildProcessWithoutNullStreams;

  // Handle stdin
  let childStdin: Writable | null = null;
  if (typeof prompt === "string") {
    child.stdin.end();
  } else {
    streamToStdin(prompt, child.stdin, config.options?.abort);
    childStdin = child.stdin;
  }

  // Parse stderr for API error/retry messages and emit as synthetic events.
  // Claude Code prints retry status (e.g. "Retrying in 21 seconds... (attempt 7/10)")
  // to stderr during API errors. We capture these and inject them into the message
  // stream so the web UI can display retry progress instead of appearing hung.
  // Hoisted outside block so the close handler can flush remaining content (Issue #795).
  let stderrBuffer = "";
  // Issue #1239 PR D: separate post-mortem ring buffer that retains the last
  // ~8 KB of ALL stderr (including unmatched lines that parseStderrApiError
  // discards). Pre-PR-D, those lines were silently dropped unless DEBUG was
  // set, leaving the launcher's exit-diagnostic blind to non-API error modes
  // (Node/Bun runtime errors, uncaught exceptions, etc.). The ring is read
  // by the 'close' handler below and attached to the typed exit error so
  // the launcher can surface it in JSONL and SQLite `error_logs`.
  let stderrRing = "";
  child.stderr.on("data", (data: Buffer) => {
    const chunk = data.toString();
    if (process.env.DEBUG) {
      console.error("Claude Code stderr:", chunk);
    }
    stderrBuffer += chunk;
    stderrRing = appendToStderrRing(stderrRing, chunk);
    const lines = stderrBuffer.split("\n");
    // Keep the last incomplete line in the buffer
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parseStderrApiError(trimmed);
      if (event) {
        query.injectMessage(event);
      } else if (process.env.DEBUG) {
        logger.debug(`[Claude stderr] ${trimmed}`);
      }
    }
  });

  // Setup cleanup
  const cleanup = () => {
    if (!child.killed) {
      void killProcessByChildProcess(child);
    }
  };

  config.options?.abort?.addEventListener("abort", cleanup);
  // Saved reference so the listener is removed in processExitPromise.finally()
  // below; otherwise repeated query() invocations accumulate exit listeners on
  // the long-lived process object.
  const onProcessExit = cleanup;
  process.on("exit", onProcessExit);

  // Handle process exit
  const processExitPromise = new Promise<void>(resolve => {
    child.on("close", (code, signal) => {
      // Flush any remaining stderr content before processing exit (Issue #795)
      if (stderrBuffer.trim()) {
        const event = parseStderrApiError(stderrBuffer.trim());
        if (event) {
          query.injectMessage(event);
        } else if (process.env.DEBUG) {
          logger.debug(`[Claude stderr] ${stderrBuffer.trim()}`);
        }
        stderrBuffer = "";
      }

      // Capture proc status before PID is recycled (Issue #795)
      const childPid = child.pid;
      const procStatus = childPid ? readProcStatus(childPid) : null;

      // Issue #1239 PR D: snapshot the stderr ring tail for diagnostic
      // attachment. Empty/whitespace-only buffers stay undefined so the
      // launcher's JSONL `stderr_tail` field is null (omitted from SQLite
      // context) rather than carrying a no-op "".
      const stderrTail = stderrRing.trim() ? stderrRing : undefined;

      if (config.options?.abort?.aborted) {
        query.setError(new AbortError("Claude Code process aborted by user"));
        // Issue #1239 follow-up (silent-failure-hunter C1 / preflight v1.0.387):
        // bail out so the subsequent classifyChildExit() doesn't overwrite the
        // AbortError with a ChildExitError/SignalExitError. When abort fires
        // during exec the OS usually kills the child with SIGTERM/SIGKILL, so
        // `code`/`signal` reflect that kill — without this return, user-cancel
        // events were misreported as crashes (and PR B persisted them to
        // error_logs as `severity: "error"`).
        return;
      }

      // Issue #1239 (PR A + PR C): dispatch is a pure function so the
      // close-handler branch logic is regression-tested in isolation.
      const err = classifyChildExit(code, signal);
      if (err) {
        err.procStatus = procStatus;
        err.childPid = childPid;
        // Issue #1239 PR D: attach stderr ring tail so the launcher's
        // exit-diagnostic emitter can include it in JSONL + error_logs.
        err.stderrTail = stderrTail;
        query.setError(err);
      } else {
        resolve();
      }
    });
  });

  // Create query instance
  const query = new Query(
    childStdin,
    child.stdout,
    processExitPromise,
    canCallTool
  );

  // Handle process errors
  child.on("error", error => {
    cleanupMcpConfig?.();
    if (config.options?.abort?.aborted) {
      query.setError(new AbortError("Claude Code process aborted by user"));
    } else {
      // Include resolved command and PATH for spawn failure diagnostics (#862)
      const pathInfo = ` [command=${spawnCommand}, PATH=${spawnEnv.PATH ?? "(unset)"}]`;
      query.setError(
        new Error(
          `Failed to spawn Claude Code process: ${error.message}${pathInfo}`
        )
      );
    }
  });

  // Cleanup on exit
  processExitPromise.finally(() => {
    cleanup();
    config.options?.abort?.removeEventListener("abort", cleanup);
    process.off("exit", onProcessExit);
    if (process.env.CLAUDE_SDK_MCP_SERVERS) {
      delete process.env.CLAUDE_SDK_MCP_SERVERS;
    }
    // #1734: only delete the entrypoint signal if THIS invocation set it AND it
    // still holds our value — prevents a billing-signal from persisting into a
    // later same-process spawn (the #1692 contamination class).
    if (entrypointWasUnset && process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-ts") {
      delete process.env.CLAUDE_CODE_ENTRYPOINT;
    }
    cleanupMcpConfig?.();
  });

  return query;
}
