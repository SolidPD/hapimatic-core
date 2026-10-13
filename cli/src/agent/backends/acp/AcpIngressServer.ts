// SPDX-License-Identifier: AGPL-3.0-only
/**
 * ACP ingress server (issue #1906, Tasks 5 + 7) — Hapimatic exposed AS an ACP
 * agent over stdio.
 *
 * The inverse of the client-side {@link AcpSdkBackend}: instead of Hapimatic
 * driving an external ACP agent, an editor (Zed/Neovim) drives a governed
 * Hapimatic Claude session through this server. It binds the reused
 * {@link AcpStdioTransport} framing to the agent's own stdio (streams mode) and
 * routes each editor-driven prompt through the standard SDK launcher
 * (`claudeRemote`) — so the same hooks, the same permission surface, and a
 * first-class PWA-visible session all come for free (DECISION-1 SDK-launcher pin,
 * DECISION-2 `flavor:"claude"`; both operator-accepted).
 *
 * Protocol handlers:
 * - `initialize`  → advertise agent capabilities (R1)
 * - `session/new` → bootstrap a governed session + start its turn driver (R2)
 * - `session/prompt` → run one turn, stream `session/update`, return stopReason (R3)
 * - `session/request_permission` → surfaced by the permission bridge (R4)
 * - `session/cancel` → interrupt the in-flight turn, resolve with `cancelled` (R5)
 */
import type { Readable, Writable } from "node:stream";
import type { SDKMessage, SDKResultMessage, Query } from "@/claude/sdk";
import type { EnhancedMode } from "@/claude/loop";
import type { ApiSessionClient } from "@/api/apiSession";
import { claudeRemote } from "@/claude/claudeRemote";
import {
  bootstrapSession,
  type SessionStartedBy,
} from "@/agent/sessionFactory";
import { startHappyServer } from "@/claude/utils/startHappyServer";
import { startHookServer } from "@/claude/utils/startHookServer";
import {
  generateHookSettingsFile,
  cleanupHookSettingsFile,
} from "@/claude/utils/generateHookSettings";
import { HAPI_MCP_SERVER_NAME } from "@/claude/utils/scrubHapiOnSpawn";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { asString, isObject } from "@/agent/utils";
import { logger } from "@/ui/logger";
import { AcpStdioTransport, type AcpTransport } from "./AcpStdioTransport";
import { AcpIngressPermissionBridge } from "./AcpIngressPermissionBridge";
import {
  sdkMessageToAcpUpdates,
  resultToStopReason,
  ACP_STOP_REASONS,
  type AcpStopReason,
} from "./sdkMessageToAcp";
import { CLI_VERSION } from "@/version";

/**
 * Grace after a `session/cancel` interrupt within which the turn's own `result`
 * (mapped to `cancelled`) should resolve the pending `session/prompt`. If it
 * doesn't (interrupt produced no result), the fallback resolves it directly so
 * the editor never hangs waiting on a cancelled turn.
 */
const ACP_CANCEL_GRACE_MS = 3_000;

type PromptQueueItem = { message: string; mode: EnhancedMode };

interface IngressSession {
  /** ACP-facing sessionId — the Hapimatic session id (PWA-visible). */
  readonly sessionId: string;
  readonly apiSession: ApiSessionClient;
  readonly happyServer: { stop: () => void };
  readonly hookServer: { stop: () => void };
  readonly hookSettingsPath: string;
  readonly path: string;
  readonly mcpServers: Record<string, unknown>;
  readonly allowedTools: string[];
  readonly promptQueue: PushableAsyncIterable<PromptQueueItem>;
  readonly permissionBridge: AcpIngressPermissionBridge;
  readonly abort: AbortController;
  /** The SDK Query, captured for `session/cancel` interrupts. */
  query: Query | null;
  /**
   * Resolver/rejecter for the in-flight `session/prompt`, or null between
   * turns. `reject` (issue #3260, R4) signals a genuine driver crash — see
   * {@link AcpIngressServer.teardownSession}.
   */
  activeTurn: {
    resolve: (reason: AcpStopReason) => void;
    reject: (error: Error) => void;
  } | null;
  /** Set when a `session/cancel` is in flight so the next `result` maps to `cancelled`. */
  cancelRequested: boolean;
  torndown: boolean;
}

export interface AcpIngressServerOptions {
  input: Readable;
  output: Writable;
  startedBy?: SessionStartedBy;
  /**
   * Driver-injection seam (KD-4, issue #3260) — defaults to the production
   * `claudeRemote`. Lets tests inject a fake driver without spawning a real
   * Claude session. Typed as `typeof claudeRemote` (not a hand-retyped option
   * list) because `claudeRemote`'s options are an anonymous inline object
   * literal with no exported alias — any hand-written re-declaration would
   * drift from its 20+ field contract.
   */
  driverRunner?: typeof claudeRemote;
}

export class AcpIngressServer {
  private readonly transport: AcpTransport;
  private readonly startedBy: SessionStartedBy;
  private readonly sessions = new Map<string, IngressSession>();
  /** In-flight per-session claudeRemote drivers, awaited on shutdown. */
  private readonly driverPromises = new Set<Promise<void>>();
  /** Driver-injection seam (KD-4, issue #3260) — defaults to `claudeRemote`. */
  private readonly driverRunner: typeof claudeRemote;
  private isShutDown = false;
  private readonly closed: {
    promise: Promise<void>;
    resolve: () => void;
  };

  constructor(options: AcpIngressServerOptions) {
    this.startedBy = options.startedBy ?? "terminal";
    this.driverRunner = options.driverRunner ?? claudeRemote;

    let resolveClosed: () => void = () => {};
    const closedPromise = new Promise<void>(resolve => {
      resolveClosed = resolve;
    });
    this.closed = { promise: closedPromise, resolve: resolveClosed };

    this.transport = AcpStdioTransport.fromStreams({
      input: options.input,
      output: options.output,
      onDisconnect: () => void this.shutdown(),
    });

    this.registerHandlers();
  }

  /** Resolves when the ACP client disconnects (input stream ends). */
  get whenClosed(): Promise<void> {
    return this.closed.promise;
  }

  private registerHandlers(): void {
    this.transport.registerRequestHandler("initialize", async params =>
      this.handleInitialize(params)
    );
    this.transport.registerRequestHandler("session/new", async params =>
      this.handleSessionNew(params)
    );
    this.transport.registerRequestHandler("session/prompt", async params =>
      this.handleSessionPrompt(params)
    );
    this.transport.onNotification((method, params) => {
      if (method === "session/cancel") {
        this.handleSessionCancel(params);
      }
    });
  }

  // ---- initialize (R1) --------------------------------------------------

  private async handleInitialize(_params: unknown): Promise<unknown> {
    // v1 is text-only: no image/audio/embeddedContext, no session load, no auth
    // (stdio is locally trusted). Confirmed against agentclientprotocol.com.
    return {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: {
        name: "hapi",
        title: "Hapimatic",
        version: CLI_VERSION,
      },
      authMethods: [],
    };
  }

  // ---- session/new (R2) + turn driver bootstrap (Task 7) ----------------

  private async handleSessionNew(params: unknown): Promise<unknown> {
    const cwd =
      (isObject(params) ? asString(params.cwd) : null) ?? process.cwd();

    // DECISION-2: a first-class, PWA-visible, governed Hapimatic session.
    const boot = await bootstrapSession({
      flavor: "claude",
      startedBy: this.startedBy,
      workingDirectory: cwd,
    });
    const sessionId = boot.sessionInfo.id;
    const apiSession = boot.session;

    // Reconstruct the exact governed-session scaffolding the PWA launcher builds
    // (runClaude.ts:807-844): HAPI MCP server + hook server + hook-settings file.
    const happyServer = await startHappyServer(apiSession);
    const hookServer = await startHookServer({ onSessionHook: () => {} });
    const hookSettingsPath = generateHookSettingsFile(
      hookServer.port,
      hookServer.token
    );
    const mcpServers: Record<string, unknown> = {
      [HAPI_MCP_SERVER_NAME]: { type: "http", url: happyServer.url },
    };
    const allowedTools = happyServer.toolNames.map(
      toolName => `mcp__${HAPI_MCP_SERVER_NAME}__${toolName}`
    );

    const session: IngressSession = {
      sessionId,
      apiSession,
      happyServer,
      hookServer,
      hookSettingsPath,
      path: cwd,
      mcpServers,
      allowedTools,
      promptQueue: new PushableAsyncIterable<PromptQueueItem>(),
      permissionBridge: new AcpIngressPermissionBridge(
        this.transport,
        sessionId
      ),
      abort: new AbortController(),
      query: null,
      activeTurn: null,
      cancelRequested: false,
      torndown: false,
    };
    this.sessions.set(sessionId, session);

    // Start the persistent claudeRemote turn driver. It blocks on the empty
    // prompt queue until the first session/prompt, then runs each turn. Tracked
    // so shutdown() can await its teardown before the process exits.
    const driver = this.runDriver(session);
    this.driverPromises.add(driver);
    void driver.finally(() => this.driverPromises.delete(driver));

    logger.debug(`[ACP] session/new → ${sessionId} (cwd=${cwd})`);
    return { sessionId };
  }

  /** The persistent SDK-launcher turn driver for one ACP session (Task 7). */
  private async runDriver(session: IngressSession): Promise<void> {
    let driverError: unknown = null;
    try {
      await this.driverRunner({
        sessionId: null,
        path: session.path,
        allowedTools: session.allowedTools,
        mcpServers: session.mcpServers,
        hookSettingsPath: session.hookSettingsPath,
        signal: session.abort.signal,
        // R4: the ACP permission surface (default-deny-on-timeout).
        canCallTool: session.permissionBridge.canCallTool,
        // v1: no per-tool abort loop-exit — cancel is handled via Query.interrupt().
        isAborted: () => false,
        // Drain the editor's prompt queue; null ends the loop (session closed).
        nextMessage: async () => {
          const next = await session.promptQueue.next();
          return next.done ? null : next.value;
        },
        onReady: () => {},
        onSessionFound: claudeSessionId => {
          logger.debug(
            `[ACP] session ${session.sessionId} → claude session ${claudeSessionId}`
          );
        },
        onMessage: message => this.handleSdkMessage(session, message),
        onQueryCreated: query => {
          session.query = query;
        },
      });
    } catch (error) {
      // R4 (issue #3260): discriminate a genuine driver crash from the
      // intentional `session.abort.abort()` this class's own `shutdown()`
      // performs on client disconnect — `shutdown()` is the only `abort()`
      // caller, so `aborted` is a reliable discriminator (KD-3).
      if (session.abort.signal.aborted) {
        logger.debug(`[ACP] driver aborted for ${session.sessionId}`, error);
      } else {
        driverError = error;
        logger.error(`[ACP] driver crashed for ${session.sessionId}`, error);
        logger.reportCaught(error, {
          category: "acp-ingress",
          severity: "error",
          sessionId: session.sessionId,
        });
      }
    } finally {
      this.teardownSession(session, driverError);
    }
  }

  /** Stream translated updates to the editor + resolve the turn on `result`. */
  private handleSdkMessage(session: IngressSession, message: SDKMessage): void {
    for (const update of sdkMessageToAcpUpdates(message)) {
      this.transport.sendNotification("session/update", {
        sessionId: session.sessionId,
        update,
      });
    }

    if (message.type === "result") {
      const turn = session.activeTurn;
      if (!turn) return;
      session.activeTurn = null;
      const stopReason = session.cancelRequested
        ? ACP_STOP_REASONS.cancelled
        : resultToStopReason(message as SDKResultMessage);
      session.cancelRequested = false;
      turn.resolve(stopReason);
    }
  }

  // ---- session/prompt (R3) ----------------------------------------------

  private async handleSessionPrompt(params: unknown): Promise<unknown> {
    const sessionId = isObject(params) ? asString(params.sessionId) : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      throw new Error(`Unknown ACP session: ${sessionId ?? "(none)"}`);
    }
    if (session.activeTurn) {
      throw new Error(
        `A turn is already in progress for session ${session.sessionId}`
      );
    }

    const message = extractPromptText(
      isObject(params) ? params.prompt : undefined
    );

    const stopReason = await new Promise<AcpStopReason>((resolve, reject) => {
      session.activeTurn = { resolve, reject };
      session.cancelRequested = false;
      session.promptQueue.push({
        message,
        mode: { permissionMode: "default" },
      });
    });

    return { stopReason };
  }

  // ---- session/cancel (R5) ----------------------------------------------

  private handleSessionCancel(params: unknown): void {
    const sessionId = isObject(params) ? asString(params.sessionId) : null;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || !session.activeTurn) return;

    logger.debug(`[ACP] session/cancel → ${session.sessionId}`);
    session.cancelRequested = true;

    // Interrupt the current turn WITHOUT killing the driver loop, so the session
    // stays alive for the next prompt.
    if (session.query) {
      session.query
        .interrupt()
        .catch(error =>
          logger.debug(`[ACP] interrupt failed for ${session.sessionId}`, error)
        );
    }

    // Fallback: if the interrupt produces no `result` within the grace window,
    // resolve the pending prompt directly so the editor never hangs.
    const turn = session.activeTurn;
    setTimeout(() => {
      if (session.activeTurn === turn) {
        session.activeTurn = null;
        session.cancelRequested = false;
        turn.resolve(ACP_STOP_REASONS.cancelled);
      }
    }, ACP_CANCEL_GRACE_MS);
  }

  // ---- teardown ---------------------------------------------------------

  private teardownSession(
    session: IngressSession,
    driverError: unknown = null
  ): void {
    if (session.torndown) return;
    session.torndown = true;

    if (session.activeTurn) {
      const turn = session.activeTurn;
      session.activeTurn = null;
      if (driverError) {
        // R4 (issue #3260): a genuine driver crash rejects the pending
        // `session/prompt` with a distinct error — propagates to the
        // transport's `-32603` JSON-RPC error response, distinguishable from
        // a user cancel (KD-2: the ACP `StopReason` enum has no "error"
        // member, so an error response is the protocol-correct signal).
        turn.reject(
          driverError instanceof Error
            ? driverError
            : new Error(String(driverError))
        );
      } else {
        turn.resolve(ACP_STOP_REASONS.cancelled); // normal/disconnect teardown — unchanged
      }
    }
    safe(() => session.happyServer.stop());
    safe(() => session.hookServer.stop());
    safe(() => cleanupHookSettingsFile(session.hookSettingsPath));
    // Disconnect the session's socket to the Hapimatic server — otherwise the
    // open socket keeps the `hapi acp` process alive after the editor
    // disconnects (leaking the process AND a dangling server session).
    safe(() => session.apiSession.close());
    this.sessions.delete(session.sessionId);
    logger.debug(`[ACP] torn down session ${session.sessionId}`);
  }

  /** Client disconnected (input stream ended) — end every session's driver. */
  private async shutdown(): Promise<void> {
    if (this.isShutDown) return;
    this.isShutDown = true;
    logger.debug("[ACP] client disconnected — shutting down ingress");
    // Snapshot the drivers BEFORE ending queues — each driver's teardown mutates
    // the set as it settles.
    const drivers = [...this.driverPromises];
    for (const session of this.sessions.values()) {
      session.abort.abort();
      if (!session.promptQueue.done) {
        session.promptQueue.end();
      }
    }
    // Wait for every driver's finally (teardownSession → stop servers + close
    // the api socket) so no open handle survives whenClosed and the process exits.
    await Promise.allSettled(drivers);
    this.closed.resolve();
  }
}

/**
 * Flatten an ACP `session/prompt` `prompt` (ContentBlock[] or a bare string)
 * into the single string `claudeRemote`'s `nextMessage` expects. v1 keeps only
 * text blocks (promptCapabilities is text-only).
 */
function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map(block =>
      isObject(block) && block.type === "text"
        ? (asString(block.text) ?? "")
        : ""
    )
    .filter(text => text.length > 0)
    .join("\n");
}

function safe(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    logger.debug("[ACP] teardown step failed", error);
  }
}
