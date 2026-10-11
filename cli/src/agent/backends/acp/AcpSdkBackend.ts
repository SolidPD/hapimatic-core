// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentBackend,
  AgentMessage,
  AgentSessionConfig,
  PermissionRequest,
  PermissionResponse,
  PromptContent,
} from "@/agent/types";
import { asString, isObject } from "@/agent/utils";
import { AcpStdioTransport, type AcpTransport } from "./AcpStdioTransport";
import { AcpMessageHandler } from "./AcpMessageHandler";
import { acpUsageFromPromptResponse } from "./acpUsageDetector";
// Type-only import (erased at runtime) — no runtime cycle even though
// `manifestDriver.ts` imports DEFAULT_ACP_CLIENT_CAPABILITIES from this file.
import type { AcpQuirkId } from "./manifestDriver";
import { logger } from "@/ui/logger";
import packageJson from "../../../../package.json";

/**
 * Issue #3347: bound the ACP boot handshakes (`initialize`, `session/new`) so a
 * gemini/opencode subprocess that spawns but never answers the handshake
 * (interactive-auth stall, wedged model load, hung MCP connect) surfaces as a
 * throw instead of hanging `runAgentSession` forever. Since #3347 starts the
 * keepAlive heartbeat BEFORE backend boot, an un-bounded hang would otherwise
 * leave a session that heartbeats (`active=true`) yet can never accept a prompt —
 * a "connected corpse". A valid handshake completes in ~1-3s (model loading
 * happens on the first prompt, not here), so the default is generous; override
 * with `HAPI_ACP_BOOT_TIMEOUT_MS`. Byte-identical for any responsive agent — the
 * win is only against a non-responding one.
 */
const DEFAULT_ACP_BOOT_TIMEOUT_MS = 60_000;

function resolveAcpBootTimeoutMs(): number {
  const raw = process.env.HAPI_ACP_BOOT_TIMEOUT_MS;
  if (!raw) return DEFAULT_ACP_BOOT_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_ACP_BOOT_TIMEOUT_MS;
}

type PendingPermission = {
  resolve: (result: {
    outcome: { outcome: string; optionId?: string };
  }) => void;
};

/**
 * ACP client-capability advertisement sent in the `initialize` handshake
 * (issue #1975). The flags tell the agent what THIS client offers; they do
 * NOT force the agent to route fs/terminal through the client — OpenCode runs
 * its own fs/terminal and surfaces approvals via `session/request_permission`
 * regardless (verified against opencode v1.17.11). Gemini keeps the text-only
 * default so its handshake stays byte-identical (regression-safe); OpenCode
 * opts into fs + terminal so it can act as a coding harness.
 */
export type AcpClientCapabilities = {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: boolean;
};

export const DEFAULT_ACP_CLIENT_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

/**
 * Factory that produces an {@link AcpTransport} for a spawn config. The default
 * spawns a real subprocess; tests inject a fake to observe the wire protocol
 * without a real CLI binary (issue #3127).
 */
export type AcpTransportFactory = (options: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}) => AcpTransport;

/**
 * Construction options for {@link AcpSdkBackend} / {@link createAcpBackend}
 * (#3127). `command`/`args`/`env` are the spawn config; `clientCapabilities`
 * (#1975) opts into fs/terminal (omitted → text-only default); `quirks` (#3127)
 * are the declared ACP-dialect adjustments (CLOSED vocabulary — `manifestDriver.ts`);
 * `transportFactory` is the test-only transport seam.
 */
export interface AcpBackendOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Issue #1975: per-flavor ACP client capabilities. Omitted →
   *  text-only default (Gemini-compatible). OpenCode passes fs+terminal. */
  clientCapabilities?: AcpClientCapabilities;
  /**
   * Issue #3127: declared ACP-dialect quirks (CLOSED vocabulary, see
   * `manifestDriver.ts`). Each id has exactly one interpreter in the backend.
   * Omitted / empty → NO quirk behavior, so the handshake and message handling
   * are byte-identical to the pre-#3127 backend (the gemini/opencode oracle).
   */
  quirks?: readonly AcpQuirkId[];
  /**
   * Issue #3127: test seam. Injects the transport instead of spawning a real
   * subprocess. Omitted → the production {@link AcpStdioTransport}. This is the
   * ONLY way to observe the ACP handshake/round-trip in CI (no gemini / cursor
   * binary is installed); production behavior is byte-identical.
   */
  transportFactory?: AcpTransportFactory;
}

export class AcpSdkBackend implements AgentBackend {
  private transport: AcpTransport | null = null;
  private permissionHandler: ((request: PermissionRequest) => void) | null =
    null;
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private messageHandler: AcpMessageHandler | null = null;
  private activeSessionId: string | null = null;

  constructor(private readonly options: AcpBackendOptions) {}

  async initialize(): Promise<void> {
    if (this.transport) return;

    const transportFactory: AcpTransportFactory =
      this.options.transportFactory ?? (o => new AcpStdioTransport(o));
    this.transport = transportFactory({
      command: this.options.command,
      args: this.options.args,
      env: this.options.env,
    });

    this.transport.onNotification((method, params) => {
      if (method === "session/update") {
        this.handleSessionUpdate(params);
      }
    });

    this.transport.registerRequestHandler(
      "session/request_permission",
      async (params, requestId) => {
        return await this.handlePermissionRequest(params, requestId);
      }
    );

    const response = await this.sendBootRequestWithTimeout("initialize", {
      protocolVersion: 1,
      clientCapabilities:
        this.options.clientCapabilities ?? DEFAULT_ACP_CLIENT_CAPABILITIES,
      clientInfo: {
        name: "hapi",
        version: packageJson.version,
      },
    });

    if (!isObject(response) || typeof response.protocolVersion !== "number") {
      throw new Error("Invalid initialize response from ACP agent");
    }

    // Quirk interpreter (#3127): auth negotiation. No-op unless the
    // `auth-negotiation` quirk is declared AND the agent advertised auth
    // methods — so the shipped gemini/opencode handshake is byte-identical.
    await this.negotiateAuthIfNeeded(response);

    logger.debug(
      `[ACP] Initialized with protocol version ${response.protocolVersion}`
    );
  }

  /**
   * Interpreter for the `auth-negotiation` quirk (#3127). When declared and the
   * `initialize` response advertises a non-empty `authMethods` array, send an
   * ACP `authenticate` request selecting the first advertised method before any
   * `session/new`. Absent quirk (or no advertised methods) → does nothing, which
   * is exactly the pre-#3127 behavior (the backend ignored `authMethods`).
   *
   * The request shape follows the ACP spec (`authenticate({methodId})` keyed on
   * an `AuthMethod.id`). It is opt-in per manifest and is NOT exercised by any
   * shipped agent; verify against a real CLI binary before a manifest declares
   * it (Cursor is the expected first consumer — see Task 7).
   */
  private async negotiateAuthIfNeeded(
    initializeResponse: Record<string, unknown>
  ): Promise<void> {
    if (!this.options.quirks?.includes("auth-negotiation")) return;
    if (!this.transport) return;

    const authMethods = initializeResponse.authMethods;
    if (!Array.isArray(authMethods) || authMethods.length === 0) return;

    const first = authMethods[0];
    const methodId = isObject(first)
      ? (asString(first.id) ?? asString(first.methodId))
      : asString(first);
    if (!methodId) {
      logger.debug(
        "[ACP] auth-negotiation quirk: advertised authMethods carry no id; skipping"
      );
      return;
    }

    logger.debug(`[ACP] auth-negotiation quirk: authenticate(${methodId})`);
    await this.transport.sendRequest("authenticate", { methodId });
  }

  /**
   * Issue #3347: race a boot-handshake request against a timeout so a
   * non-responding agent surfaces as an error instead of an infinite hang. The
   * underlying `sendRequest` promise stays pending on timeout; it is rejected
   * when the caller tears the transport down (`disconnect()` → `close()` →
   * `rejectAllPending`), so nothing leaks.
   */
  private async sendBootRequestWithTimeout(
    method: string,
    params: unknown
  ): Promise<unknown> {
    if (!this.transport) {
      throw new Error("ACP transport not initialized");
    }
    const timeoutMs = resolveAcpBootTimeoutMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `ACP ${method} timed out after ${timeoutMs}ms — the agent process did not respond to the boot handshake (check the agent CLI is installed, authenticated, and on PATH).`
          )
        );
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.transport.sendRequest(method, params),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async newSession(config: AgentSessionConfig): Promise<string> {
    if (!this.transport) {
      throw new Error("ACP transport not initialized");
    }

    const response = await this.sendBootRequestWithTimeout("session/new", {
      cwd: config.cwd,
      mcpServers: config.mcpServers,
    });

    const sessionId = isObject(response) ? asString(response.sessionId) : null;
    if (!sessionId) {
      throw new Error("Invalid session/new response from ACP agent");
    }

    this.activeSessionId = sessionId;
    return sessionId;
  }

  async prompt(
    sessionId: string,
    content: PromptContent[],
    onUpdate: (msg: AgentMessage) => void
  ): Promise<void> {
    if (!this.transport) {
      throw new Error("ACP transport not initialized");
    }

    this.activeSessionId = sessionId;
    this.messageHandler = new AcpMessageHandler(onUpdate);

    try {
      const response = await this.transport.sendRequest("session/prompt", {
        sessionId,
        prompt: content,
      });

      // Issue #3352: per-turn token usage rides the prompt RESPONSE (gemini's
      // `_meta.quota`), NOT a session/update — surface it as a `usage` message
      // so the runner records it onto the open turn. Absent → no message (a
      // zero-fidelity turn is boundary-only). Emitted BEFORE turn_complete so
      // the runner has the usage before the prompt-cycle finalize fires.
      const usage = acpUsageFromPromptResponse(response);
      if (usage) {
        onUpdate({
          type: "usage",
          tokIn: usage.tokIn,
          tokOut: usage.tokOut,
          tokCacheRead: usage.tokCacheRead,
          tokCacheWrite: usage.tokCacheWrite,
          modelId: usage.modelId,
        });
      }

      const stopReason = isObject(response)
        ? asString(response.stopReason)
        : null;
      if (stopReason) {
        onUpdate({ type: "turn_complete", stopReason });
      }
    } finally {
      this.messageHandler = null;
    }
  }

  async cancelPrompt(sessionId: string): Promise<void> {
    if (!this.transport) {
      return;
    }

    this.transport.sendNotification("session/cancel", { sessionId });
  }

  async respondToPermission(
    _sessionId: string,
    request: PermissionRequest,
    response: PermissionResponse
  ): Promise<void> {
    const pending = this.pendingPermissions.get(request.id);
    if (!pending) {
      logger.debug("[ACP] No pending permission request for id", request.id);
      return;
    }

    this.pendingPermissions.delete(request.id);

    if (response.outcome === "cancelled") {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      return;
    }

    pending.resolve({
      outcome: {
        outcome: "selected",
        optionId: response.optionId,
      },
    });
  }

  onPermissionRequest(handler: (request: PermissionRequest) => void): void {
    this.permissionHandler = handler;
  }

  async disconnect(): Promise<void> {
    if (!this.transport) return;
    await this.transport.close();
    this.transport = null;
  }

  private handleSessionUpdate(params: unknown): void {
    if (!isObject(params)) return;
    const sessionId = asString(params.sessionId);
    if (
      this.activeSessionId &&
      sessionId &&
      sessionId !== this.activeSessionId
    ) {
      return;
    }
    const update = params.update;
    if (!this.messageHandler) return;
    this.messageHandler.handleUpdate(update);
  }

  private async handlePermissionRequest(
    params: unknown,
    requestId: string | number | null
  ): Promise<unknown> {
    if (!isObject(params)) {
      return { outcome: { outcome: "cancelled" } };
    }

    const sessionId =
      asString(params.sessionId) ?? this.activeSessionId ?? "unknown";
    const toolCall = isObject(params.toolCall) ? params.toolCall : {};
    const toolCallId = asString(toolCall.toolCallId) ?? `tool-${Date.now()}`;
    const title = asString(toolCall.title) ?? undefined;
    const kind = asString(toolCall.kind) ?? undefined;
    const rawInput = "rawInput" in toolCall ? toolCall.rawInput : undefined;
    const rawOutput = "rawOutput" in toolCall ? toolCall.rawOutput : undefined;
    const options = Array.isArray(params.options)
      ? params.options
          .filter(option => isObject(option))
          .map((option, index) => ({
            optionId: asString(option.optionId) ?? `option-${index + 1}`,
            name: asString(option.name) ?? `Option ${index + 1}`,
            kind: asString(option.kind) ?? "allow_once",
          }))
      : [];

    const request: PermissionRequest = {
      id: toolCallId,
      sessionId,
      toolCallId,
      title,
      kind,
      rawInput,
      rawOutput,
      options,
    };

    if (this.permissionHandler) {
      this.permissionHandler(request);
    } else {
      logger.debug(
        "[ACP] No permission handler registered; cancelling request"
      );
      return { outcome: { outcome: "cancelled" } };
    }

    return await new Promise(resolve => {
      this.pendingPermissions.set(toolCallId, { resolve });
    });
  }
}

/**
 * The public factory for the generic ACP egress backend (#3127). Call sites
 * (gemini, opencode, and future ACP-capable CLIs) build a backend from a
 * resolved config (`resolveAcpConfig`, `manifestDriver.ts`) plus a call-site
 * `env`, instead of `new AcpSdkBackend(...)` directly. Routing all construction
 * through one factory is what lets an ACP-capable CLI be added with declarative
 * config only — no new backend code (the AC). It is the additive `export` #1906
 * ingress and #3127 egress both hang off of; keep the seam here, not a new
 * `AgentBackend` per CLI.
 */
export function createAcpBackend(options: AcpBackendOptions): AcpSdkBackend {
  return new AcpSdkBackend(options);
}
