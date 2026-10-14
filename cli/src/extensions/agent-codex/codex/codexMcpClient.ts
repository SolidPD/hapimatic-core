// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { logger } from "@/ui/logger";
import { buildHarnessChildEnv } from "@/sandbox/secretEnvVars";
import { isProcessAlive, killProcess } from "@/utils/process";
import type { CodexSessionConfig, CodexToolResponse } from "./types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Event emitted by the Codex MCP server via codex/event notifications */
export interface CodexEvent {
  type?: string;
  session_id?: string;
  sessionId?: string;
  conversation_id?: string;
  conversationId?: string;
  // codex mcp-server >= 0.144.6 identifies the session by threadId
  thread_id?: string;
  threadId?: string;
  // agent_message
  message?: string;
  // agent_reasoning / agent_reasoning_delta
  text?: string;
  delta?: string;
  // exec_command_begin / exec_command_end / exec_approval_request
  command?: string;
  output?: string;
  error?: string;
  call_id?: string;
  // patch_apply_begin
  auto_approved?: boolean;
  changes?: Record<string, unknown>;
  // patch_apply_end
  stdout?: string;
  stderr?: string;
  success?: boolean;
  // turn_diff
  unified_diff?: string;
  data?: {
    session_id?: string;
    sessionId?: string;
    conversation_id?: string;
    conversationId?: string;
    thread_id?: string;
    threadId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** Shape of a Codex MCP call-tool response with optional identifier fields */
interface CodexCallToolResponse extends CallToolResult {
  meta?: {
    sessionId?: string;
    conversationId?: string;
    [key: string]: unknown;
  };
  sessionId?: string;
  conversationId?: string;
  // codex mcp-server >= 0.144.6 returns the session identifier as
  // structuredContent.threadId (paired with the tool's outputSchema). The SDK's
  // CallToolResult already types structuredContent loosely; the explicit shape
  // documents intent and gives structuredContent.threadId a type.
  threadId?: string;
  structuredContent?: {
    threadId?: string;
    conversationId?: string;
    [key: string]: unknown;
  };
}
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexPermissionHandler } from "./utils/permissionHandler";
import { execFileSync } from "child_process";
import { randomUUID } from "node:crypto";

type ElicitResponseValue = string | number | boolean | string[];
type ElicitRequestedSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function extractRequestedSchema(
  params: Record<string, unknown>
): ElicitRequestedSchema | null {
  const raw = params.requestedSchema;
  if (!isObject(raw)) return null;
  const properties = isObject(raw.properties)
    ? (raw.properties as Record<string, unknown>)
    : undefined;
  const required = Array.isArray(raw.required)
    ? raw.required.filter(item => typeof item === "string")
    : undefined;
  const type = typeof raw.type === "string" ? raw.type : undefined;
  return { type, properties, required };
}

function extractToolCallId(params: Record<string, unknown>): string | null {
  const candidateKeys = [
    "codex_call_id",
    "codex_mcp_tool_call_id",
    "codex_event_id",
    "call_id",
    "tool_call_id",
    "toolCallId",
    "mcp_tool_call_id",
    "mcpToolCallId",
    "id",
  ];

  for (const key of candidateKeys) {
    const value = params[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return null;
}

function extractCommand(params: Record<string, unknown>): string[] | null {
  const command = params.codex_command ?? params.command ?? params.cmd;
  if (
    Array.isArray(command) &&
    command.every(item => typeof item === "string")
  ) {
    return command as string[];
  }
  if (typeof command === "string" && command.length > 0) {
    return [command];
  }
  return null;
}

function extractCwd(params: Record<string, unknown>): string | null {
  const cwd = params.codex_cwd ?? params.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

function buildElicitationResult(
  decision: "approved" | "approved_for_session" | "denied" | "abort",
  requestedSchema: ElicitRequestedSchema | null,
  reason?: string
): {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, ElicitResponseValue>;
  decision?: string;
  reason?: string;
} {
  const action: "accept" | "decline" | "cancel" =
    decision === "approved" || decision === "approved_for_session"
      ? "accept"
      : decision === "abort"
        ? "cancel"
        : "decline";

  if (
    !requestedSchema?.properties ||
    Object.keys(requestedSchema.properties).length === 0
  ) {
    return reason ? { action, decision, reason } : { action, decision };
  }

  if (action !== "accept") {
    return reason ? { action, decision, reason } : { action, decision };
  }

  const properties = requestedSchema?.properties ?? null;
  const content: Record<string, ElicitResponseValue> = {};

  if (properties && Object.keys(properties).length > 0) {
    const approved =
      decision === "approved" || decision === "approved_for_session";

    if (Object.prototype.hasOwnProperty.call(properties, "decision")) {
      content.decision = decision;
    }
    if (Object.prototype.hasOwnProperty.call(properties, "approved")) {
      content.approved = approved;
    }
    if (Object.prototype.hasOwnProperty.call(properties, "allow")) {
      content.allow = approved;
    }
    if (reason && Object.prototype.hasOwnProperty.call(properties, "reason")) {
      content.reason = reason;
    }

    if (Object.keys(content).length === 0) {
      const [fallbackKey] = Object.keys(properties);
      if (fallbackKey) {
        content[fallbackKey] = decision;
      }
    }
  } else {
    content.decision = decision;
    if (reason) {
      content.reason = reason;
    }
  }

  return reason
    ? { action, content, decision, reason }
    : { action, content, decision };
}

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

/**
 * Range of codex CLI versions whose `threadId` session-contract Hapimatic is
 * verified against. 0.144.6 is the first version carrying the verified `threadId`
 * contract; the client is tested through 0.147.0.
 */
const CODEX_MIN_SUPPORTED = "0.144.6";
const CODEX_TESTED_MAX = "0.147.0";

/**
 * Read and parse the installed codex CLI version, e.g. "0.147.0" or
 * "0.148.0-alpha.3". Returns null when codex is not installed or the version
 * output cannot be parsed. Read once here and reused by getCodexMcpCommand and
 * checkSupportedCodexVersion. Uses execFileSync (no shell) — the argument list is
 * static, so there is no injection surface.
 */
function parseCodexVersion(): string | null {
  try {
    const version = execFileSync("codex", ["--version"], {
      encoding: "utf8",
    }).trim();
    const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
    return match ? match[1] : null;
  } catch (error) {
    logger.debug("[CodexMCP] Error reading codex version:", error);
    return null;
  }
}

/** Compare two X.Y.Z version strings, ignoring any -alpha suffix. Returns -1 / 0 / 1. */
function compareStableVersion(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/**
 * Warn (never throw) when the installed codex version is outside the range whose
 * threadId contract Hapimatic is verified against, and return the detected version.
 *
 * Below CODEX_MIN_SUPPORTED the legacy sessionId/conversationId contract still works
 * and the retained fallback capture layers (extractIdentifiers / updateIdentifiersFromEvent)
 * serve it, so a connect-time throw would regress a working install. Above
 * CODEX_TESTED_MAX (or an -alpha prerelease) the contract MAY still hold, so a hard
 * fail would be its own regression. Returns null when codex is absent / unparseable —
 * stay silent in that case (mirrors getCodexMcpCommand's tolerant default).
 */
function checkSupportedCodexVersion(): string | null {
  const versionStr = parseCodexVersion();
  if (!versionStr) return null;

  const isAlpha = versionStr.includes("-alpha.");
  if (compareStableVersion(versionStr, CODEX_MIN_SUPPORTED) < 0) {
    logger.warn(
      `[CodexMCP] Installed codex ${versionStr} is BELOW the verified minimum ` +
        `${CODEX_MIN_SUPPORTED}. Hapimatic's Codex threadId contract is verified for ` +
        `>= ${CODEX_MIN_SUPPORTED} (tested through ${CODEX_TESTED_MAX}); on this older ` +
        `codex only the legacy sessionId contract applies and Codex sessions may fail.`
    );
  } else if (
    isAlpha ||
    compareStableVersion(versionStr, CODEX_TESTED_MAX) > 0
  ) {
    logger.warn(
      `[CodexMCP] Installed codex ${versionStr} is ABOVE the tested maximum ` +
        `${CODEX_TESTED_MAX}${isAlpha ? " (prerelease)" : ""}. Hapimatic's Codex ` +
        `threadId contract is tested through ${CODEX_TESTED_MAX}; if Codex sessions ` +
        `misbehave, update Hapimatic.`
    );
  }
  return versionStr;
}

/**
 * Get the correct MCP subcommand based on installed codex version
 * Versions >= 0.43.0-alpha.5 use 'mcp-server', older versions use 'mcp'
 */
function getCodexMcpCommand(): string {
  const versionStr = parseCodexVersion();
  if (!versionStr) return "mcp-server"; // Default to newer command if we can't parse

  const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

  // Version >= 0.43.0-alpha.5 has mcp-server
  if (major > 0 || minor > 43) return "mcp-server";
  if (minor === 43 && patch === 0) {
    // Check for alpha version
    if (versionStr.includes("-alpha.")) {
      const alphaNum = parseInt(versionStr.split("-alpha.")[1]);
      return alphaNum >= 5 ? "mcp-server" : "mcp";
    }
    return "mcp-server"; // 0.43.0 stable has mcp-server
  }
  return "mcp"; // Older versions use mcp
}

export class CodexMcpClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private connected: boolean = false;
  // Canonical session identifier on codex mcp-server >= 0.144.6. The "session id"
  // the app carries around IS the codex thread id now; getSessionId()/hasActiveSession()
  // return `threadId ?? sessionId`, keeping the public surface stable while the legacy
  // fields remain for backward-compatible fallback against older servers.
  private threadId: string | null = null;
  private sessionId: string | null = null;
  private conversationId: string | null = null;
  // Version detected at connect() by checkSupportedCodexVersion(); surfaced in the
  // continueSession "No active session" guard so an out-of-range codex is named.
  private detectedCodexVersion: string | null = null;
  private handler: ((event: CodexEvent) => void) | null = null;
  private permissionHandler: CodexPermissionHandler | null = null;

  constructor() {
    this.client = new Client(
      { name: "hapi-codex-client", version: "1.0.0" },
      { capabilities: { elicitation: {} } }
    );

    // Avoid TS instantiation depth issues by widening the schema type.
    const codexNotificationSchema: z.ZodTypeAny = z
      .object({
        method: z.literal("codex/event"),
        params: z.object({
          msg: z.any(),
        }),
      })
      .passthrough();

    const setNotificationHandler = this.client.setNotificationHandler.bind(
      this.client
    ) as (
      schema: unknown,
      handler: (notification: { params: { msg: CodexEvent } }) => void
    ) => void;

    setNotificationHandler(codexNotificationSchema, data => {
      const msg = data.params.msg as CodexEvent;
      this.updateIdentifiersFromEvent(msg);
      this.handler?.(msg);
    });
  }

  setHandler(handler: ((event: CodexEvent) => void) | null): void {
    this.handler = handler;
  }

  /**
   * Set the permission handler for tool approval
   */
  setPermissionHandler(handler: CodexPermissionHandler): void {
    this.permissionHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    const mcpCommand = getCodexMcpCommand();
    // Surface a loud warning at connect time (before any turn) when the installed
    // codex version is outside the verified threadId-contract range. Never throws —
    // pre-0.144.6 installs keep working on the legacy fallback layers.
    this.detectedCodexVersion = checkSupportedCodexVersion();
    logger.debug(
      `[CodexMCP] Connecting to Codex MCP server using command: codex ${mcpCommand}`
    );

    // #3813: strip secrets at this wrapper→child seam via the shared per-flavor
    // helper. codex `keepSecrets` = ["OPENAI_API_KEY"] ⇒ the codex child KEEPS its
    // provider key but loses CLI_API_TOKEN / GH_TOKEN / the rest of SECRET_ENV_VARS
    // (when the sandbox is ON) plus the ungated #2383 set (always). The codex `hapi
    // mcp` bridge takes its URL by `--url` arg, so losing HAPI_HTTP_MCP_URL is safe.
    const codexChildEnv = buildHarnessChildEnv(
      "codex",
      Object.keys(process.env).reduce(
        (acc, key) => {
          const value = process.env[key];
          if (typeof value === "string") acc[key] = value;
          return acc;
        },
        {} as Record<string, string>
      )
    );
    this.transport = new StdioClientTransport({
      command: "codex",
      args: [mcpCommand],
      env: codexChildEnv,
    });

    // Register request handlers for Codex permission methods
    this.registerPermissionHandlers();

    await this.client.connect(this.transport);
    this.connected = true;

    logger.debug("[CodexMCP] Connected to Codex");
  }

  private registerPermissionHandlers(): void {
    // Register handler for exec command approval requests
    this.client.setRequestHandler(ElicitRequestSchema, async request => {
      const params = request.params as Record<string, unknown>;
      const requestedSchema = extractRequestedSchema(params);

      // Load params
      const toolCallId = extractToolCallId(params) ?? randomUUID();
      const command = extractCommand(params);
      const cwd = extractCwd(params);
      const toolName = "CodexBash";

      // If no permission handler set, deny by default
      if (!this.permissionHandler) {
        logger.debug(
          "[CodexMCP] No permission handler set, denying by default"
        );
        return buildElicitationResult(
          "denied",
          requestedSchema,
          "Permission handler not configured"
        );
      }

      try {
        // Request permission through the handler
        const result = await this.permissionHandler.handleToolCall(
          toolCallId,
          toolName,
          {
            command: command ?? [],
            cwd: cwd ?? "",
          }
        );

        logger.debug("[CodexMCP] Permission result:", result);
        return buildElicitationResult(
          result.decision,
          requestedSchema,
          result.reason
        );
      } catch (error) {
        logger.debug("[CodexMCP] Error handling permission request:", error);
        const reason =
          error instanceof Error ? error.message : "Permission request failed";
        return buildElicitationResult("denied", requestedSchema, reason);
      }
    });

    logger.debug("[CodexMCP] Permission handlers registered");
  }

  async startSession(
    config: CodexSessionConfig,
    options?: { signal?: AbortSignal }
  ): Promise<CodexToolResponse> {
    if (!this.connected) await this.connect();

    // Reset identifiers at the start of every session. The remote launcher re-enters
    // startSession WITHOUT clearSession() on AbortError (codexRemoteLauncher.ts), and
    // startSession does not otherwise reset them — so a stale threadId from a now-dead
    // thread must not survive into the new session. Otherwise a restart response that
    // carries only legacy fields would leave the dead thread's id live and route the
    // next codex-reply into the aborted thread (expert-review R15).
    this.threadId = null;
    this.sessionId = null;
    this.conversationId = null;

    logger.debug("[CodexMCP] Starting Codex session:", config);

    const response = await this.client.callTool(
      {
        name: "codex",
        arguments: config as unknown as Record<string, unknown>,
      },
      undefined,
      {
        signal: options?.signal,
        timeout: DEFAULT_TIMEOUT,
        // maxTotalTimeout: 10000000000
      }
    );

    logger.debug("[CodexMCP] startSession response:", response);

    // Extract session / conversation identifiers from response if present
    this.extractIdentifiers(response as CodexCallToolResponse);

    return response as CodexToolResponse;
  }

  async continueSession(
    prompt: string,
    options?: { signal?: AbortSignal }
  ): Promise<CodexToolResponse> {
    if (!this.connected) await this.connect();

    const activeThreadId = this.threadId ?? this.sessionId;
    if (!activeThreadId) {
      const versionHint = this.detectedCodexVersion
        ? `codex ${this.detectedCodexVersion} detected`
        : "codex version undetected";
      throw new Error(
        `No active session. Call startSession first. (${versionHint}; ` +
          `Hapimatic's Codex threadId contract is verified for >= ${CODEX_MIN_SUPPORTED}, ` +
          `tested through ${CODEX_TESTED_MAX} — on older codex the legacy sessionId ` +
          `contract applies; if you see this on a modern codex, update Hapimatic.)`
      );
    }

    // codex-reply >= 0.144.6 requires threadId; conversationId is DEPRECATED and
    // sessionId is absent from the current tool contract, so send only threadId.
    const args = {
      threadId: activeThreadId,
      prompt,
    };
    logger.debug("[CodexMCP] Continuing Codex session:", args);

    const response = await this.client.callTool(
      {
        name: "codex-reply",
        arguments: args,
      },
      undefined,
      {
        signal: options?.signal,
        timeout: DEFAULT_TIMEOUT,
      }
    );

    logger.debug("[CodexMCP] continueSession response:", response);
    this.extractIdentifiers(response as CodexCallToolResponse);

    return response as CodexToolResponse;
  }

  private updateIdentifiersFromEvent(event: CodexEvent): void {
    if (!event || typeof event !== "object") {
      return;
    }

    const candidates: Array<Record<string, unknown>> = [event];
    if (event.data && typeof event.data === "object") {
      candidates.push(event.data);
    }

    for (const candidate of candidates) {
      // codex mcp-server >= 0.144.6 carries the session id as threadId in
      // codex/event notifications. The exact field name on 0.147.0 is an
      // audit-unknown, so accept both thread_id and threadId defensively; the
      // structuredContent.threadId capture (extractIdentifiers) is the primary path.
      const threadId = (candidate.thread_id ?? candidate.threadId) as
        | string
        | undefined;
      if (threadId) {
        this.threadId = threadId;
        logger.debug(
          "[CodexMCP] threadId extracted from event:",
          this.threadId
        );
      }

      const sessionId = (candidate.session_id ?? candidate.sessionId) as
        | string
        | undefined;
      if (sessionId) {
        this.sessionId = sessionId;
        logger.debug(
          "[CodexMCP] Session ID extracted from event:",
          this.sessionId
        );
      }

      const conversationId = (candidate.conversation_id ??
        candidate.conversationId) as string | undefined;
      if (conversationId) {
        this.conversationId = conversationId;
        logger.debug(
          "[CodexMCP] Conversation ID extracted from event:",
          this.conversationId
        );
      }
    }
  }
  private extractIdentifiers(response: CodexCallToolResponse): void {
    // Primary path (codex mcp-server >= 0.144.6): the session identifier arrives as
    // structuredContent.threadId, paired with the tool's outputSchema. Read it FIRST
    // and prefer it over any legacy field. The "never overwrite a captured threadId"
    // rule is scoped to THIS response's layering only (identifiers are nulled at
    // startSession entry, so a stale threadId from a dead thread cannot survive a
    // restart — see startSession).
    let capturedThreadThisResponse = false;
    const structured = response?.structuredContent as
      | { threadId?: string; conversationId?: string }
      | undefined;
    if (structured?.threadId) {
      this.threadId = structured.threadId;
      capturedThreadThisResponse = true;
      logger.debug("[CodexMCP] threadId extracted:", this.threadId);
    }

    const meta = response?.meta || {};
    if (meta.sessionId) {
      this.sessionId = meta.sessionId;
      logger.debug("[CodexMCP] Session ID extracted:", this.sessionId);
    } else if (response?.sessionId) {
      this.sessionId = response.sessionId;
      logger.debug("[CodexMCP] Session ID extracted:", this.sessionId);
    }

    if (meta.conversationId) {
      this.conversationId = meta.conversationId;
      logger.debug(
        "[CodexMCP] Conversation ID extracted:",
        this.conversationId
      );
    } else if (response?.conversationId) {
      this.conversationId = response.conversationId;
      logger.debug(
        "[CodexMCP] Conversation ID extracted:",
        this.conversationId
      );
    }

    const content = response?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const contentItem = item as Record<string, unknown>;
        // Defensive fallback: per MCP guidance a server SHOULD also serialize the
        // structured object into a TextContent block. Parse a threadId out of a
        // JSON-bearing text block only if structuredContent did not already yield one
        // (within-response never-overwrite).
        if (
          !capturedThreadThisResponse &&
          contentItem?.type === "text" &&
          typeof contentItem.text === "string"
        ) {
          try {
            const parsed = JSON.parse(contentItem.text) as {
              threadId?: string;
            };
            if (parsed?.threadId) {
              this.threadId = parsed.threadId;
              capturedThreadThisResponse = true;
              logger.debug(
                "[CodexMCP] threadId extracted from text content:",
                this.threadId
              );
            }
          } catch {
            // content text is not JSON — ignore and fall through to legacy scans
          }
        }
        if (!this.sessionId && contentItem?.sessionId) {
          this.sessionId = contentItem.sessionId as string;
          logger.debug(
            "[CodexMCP] Session ID extracted from content:",
            this.sessionId
          );
        }
        if (
          !this.conversationId &&
          contentItem &&
          typeof contentItem === "object" &&
          "conversationId" in contentItem &&
          contentItem.conversationId
        ) {
          this.conversationId = contentItem.conversationId as string;
          logger.debug(
            "[CodexMCP] Conversation ID extracted from content:",
            this.conversationId
          );
        }
      }
    }
  }

  getSessionId(): string | null {
    return this.threadId ?? this.sessionId;
  }

  hasActiveSession(): boolean {
    return (this.threadId ?? this.sessionId) !== null;
  }

  clearSession(): void {
    // Store the previous session ID before clearing for potential resume
    const previousSessionId = this.threadId ?? this.sessionId;
    this.threadId = null;
    this.sessionId = null;
    this.conversationId = null;
    logger.debug(
      "[CodexMCP] Session cleared, previous sessionId:",
      previousSessionId
    );
  }

  /**
   * Store the current session ID without clearing it, useful for abort handling
   */
  storeSessionForResume(): string | null {
    const activeId = this.threadId ?? this.sessionId;
    logger.debug("[CodexMCP] Storing session for potential resume:", activeId);
    return activeId;
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;

    // Capture pid in case we need to force-kill
    const pid = this.transport?.pid ?? null;
    logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? "none"}`);

    try {
      // Ask client to close the transport
      logger.debug("[CodexMCP] client.close begin");
      await this.client.close();
      logger.debug("[CodexMCP] client.close done");
    } catch (e) {
      logger.debug(
        "[CodexMCP] Error closing client, attempting transport close directly",
        e
      );
      try {
        logger.debug("[CodexMCP] transport.close begin");
        await this.transport?.close?.();
        logger.debug("[CodexMCP] transport.close done");
      } catch {}
    }

    // As a last resort, if child still exists, send SIGKILL
    if (pid) {
      if (isProcessAlive(pid)) {
        logger.debug("[CodexMCP] Child still alive, sending SIGKILL");
        await killProcess(pid, true);
      }
    }

    this.transport = null;
    this.connected = false;
    this.threadId = null;
    this.sessionId = null;
    this.conversationId = null;

    logger.debug("[CodexMCP] Disconnected");
  }
}
