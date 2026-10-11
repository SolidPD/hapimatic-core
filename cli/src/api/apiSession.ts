// SPDX-License-Identifier: MIT
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { io, type Socket } from "socket.io-client";
import axios from "axios";
import type { ZodType } from "zod";
import { logger } from "@/ui/logger";
import { backoff } from "@/utils/time";
import { AsyncLock } from "@/utils/lock";
import type { RawJSONLines } from "@/claude/types";
import { configuration } from "@/configuration";
import type {
  AgentState,
  ClientToServerEvents,
  MessageContent,
  MessageMeta,
  Metadata,
  ServerToClientEvents,
  Session,
  SessionModelMode,
  SessionPermissionMode,
  Update,
  UserMessage,
} from "./types";
import {
  AgentStateSchema,
  CliMessagesResponseSchema,
  MetadataSchema,
  UserMessageSchema,
} from "./types";
import { RpcHandlerManager } from "./rpc/RpcHandlerManager";
import { registerCommonHandlers } from "../modules/common/registerCommonHandlers";
import { TerminalManager } from "@/terminal/TerminalManager";
import {
  TerminalClosePayloadSchema,
  TerminalOpenPayloadSchema,
  TerminalResizePayloadSchema,
  TerminalWritePayloadSchema,
  type TerminalOpenPayload,
  type TerminalOutputPayload,
} from "@/terminal/types";
import {
  ClaudePtyResizePayloadSchema,
  ClaudePtyWritePayloadSchema,
  type ClaudePtyOutputPayload,
} from "@/claude/claudePtyTypes";
import { getActivePty } from "@/claude/utils/activePtyRegistry";
import type { TurnEventPayload } from "@/claude/utils/turnReporter";
import type {
  BackgroundAgentsSnapshot,
  ProviderUsageSnapshotWindow,
} from "@hapi/protocol/schemas";
import { applyVersionedAck } from "./versionedUpdate";

/**
 * #4517: forward terminal output only while the `/cli` socket is connected.
 * socket.io-client buffers emits made while disconnected and flushes them on
 * reconnect, so a persistent shell printing through a long hub outage would
 * grow that buffer without bound. Nothing is lost by dropping it: the hub has
 * no attachment to deliver it to, and the shell's mirror keeps the screen for
 * the re-attach snapshot. (Legacy terminals are closed on disconnect.)
 */
export function emitTerminalOutput(
  socket: Pick<Socket, "connected" | "emit">,
  payload: TerminalOutputPayload
): void {
  if (socket.connected) {
    socket.emit("terminal:output", payload);
  }
}

/**
 * #4517: open (or re-attach) the terminal a `terminal:open` names. `fresh` is
 * the only way an exited persistent shell is replaced while its session runs
 * ("Start new shell"), so it must survive every hop to `create`.
 */
export function openTerminal(
  manager: Pick<TerminalManager, "create">,
  payload: TerminalOpenPayload
): void {
  manager.create(
    payload.terminalId,
    payload.cols,
    payload.rows,
    payload.persistent === true,
    payload.fresh === true
  );
}

export class ApiSessionClient extends EventEmitter {
  private readonly token: string;
  readonly sessionId: string;
  private metadata: Metadata | null;

  /**
   * Round 11 (epic #3285): read-only view of the server record's metadata as
   * fetched at session creation — the durable pins (`permissionMode`,
   * `modelMode`, `effort`, `rawModel`) a disconnected-session save staged for
   * this respawn. runClaude seeds its initial permission posture from it.
   */
  getMetadata(): Metadata | null {
    return this.metadata;
  }
  private metadataVersion: number;
  private agentState: AgentState | null;
  private agentStateVersion: number;
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private pendingMessages: UserMessage[] = [];
  private pendingMessageCallback: ((message: UserMessage) => void) | null =
    null;
  private lastSeenMessageSeq: number | null = null;
  private backfillInFlight: Promise<void> | null = null;
  private needsBackfill = false;
  private hasConnectedOnce = false;
  readonly rpcHandlerManager: RpcHandlerManager;
  private readonly terminalManager: TerminalManager;
  private agentStateLock = new AsyncLock();
  private metadataLock = new AsyncLock();
  /**
   * The server session record this client was constructed from (issue #1268).
   * Retained so extension lifecycle hooks can be handed a real `Session` — the
   * payload type `CliExtensionHost.lifecycle.onSessionStart/End` requires. Only
   * the immutable fields are read from it; the mutable ones are overlaid live by
   * {@link ApiSessionClient.getSessionSnapshot}.
   */
  private readonly sessionRecord: Session;

  constructor(token: string, session: Session) {
    super();
    this.token = token;
    this.sessionId = session.id;
    this.sessionRecord = session;
    this.metadata = session.metadata;
    this.metadataVersion = session.metadataVersion;
    this.agentState = session.agentState;
    this.agentStateVersion = session.agentStateVersion;

    this.rpcHandlerManager = new RpcHandlerManager({
      scopePrefix: this.sessionId,
      logger: (msg, data) => logger.debug(msg, data),
    });

    if (this.metadata?.path) {
      registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);
    }

    this.socket = io(`${configuration.serverUrl}/cli`, {
      auth: {
        token: this.token,
        clientType: "session-scoped" as const,
        sessionId: this.sessionId,
      },
      path: "/socket.io/",
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ["websocket"],
      autoConnect: false,
    });

    this.terminalManager = new TerminalManager({
      sessionId: this.sessionId,
      getSessionPath: () => this.metadata?.path ?? null,
      onReady: payload => this.socket.emit("terminal:ready", payload),
      onOutput: payload => emitTerminalOutput(this.socket, payload),
      onExit: payload => this.socket.emit("terminal:exit", payload),
      onError: payload => this.socket.emit("terminal:error", payload),
    });

    this.socket.on("connect", () => {
      logger.debug("Socket connected successfully");
      this.rpcHandlerManager.onSocketConnect(this.socket);
      if (this.hasConnectedOnce) {
        this.needsBackfill = true;
      }
      void this.backfillIfNeeded();
      this.hasConnectedOnce = true;
    });

    this.socket.on(
      "rpc-request",
      async (
        data: { method: string; params: string },
        callback: (response: string) => void
      ) => {
        callback(await this.rpcHandlerManager.handleRequest(data));
      }
    );

    this.socket.on("disconnect", reason => {
      logger.debug("[API] Socket disconnected:", reason);
      this.rpcHandlerManager.onSocketDisconnect();
      // #4517 (R6, K3): a `/cli` socket drop (hub restart/redeploy, network
      // blip) must NOT kill persistent shells — they survive and are
      // re-attached by the browser's next `terminal:create` once the CLI
      // reconnects. Legacy terminals keep today's close-on-disconnect.
      this.terminalManager.closeNonPersistent();
      if (this.hasConnectedOnce) {
        this.needsBackfill = true;
      }
    });

    this.socket.on("connect_error", error => {
      logger.debug("[API] Socket connection error:", error);
      this.rpcHandlerManager.onSocketDisconnect();
    });

    this.socket.on("error", payload => {
      logger.debug("[API] Socket error:", payload);
    });

    const handleTerminalEvent =
      <T extends { sessionId: string }>(
        schema: ZodType<T>,
        handler: (payload: T) => void
      ) =>
      (data: unknown) => {
        const parsed = schema.safeParse(data);
        if (!parsed.success) {
          return;
        }
        if (parsed.data.sessionId !== this.sessionId) {
          return;
        }
        handler(parsed.data);
      };

    this.socket.on(
      "terminal:open",
      handleTerminalEvent(TerminalOpenPayloadSchema, payload => {
        openTerminal(this.terminalManager, payload);
      })
    );

    this.socket.on(
      "terminal:write",
      handleTerminalEvent(TerminalWritePayloadSchema, payload => {
        this.terminalManager.write(payload.terminalId, payload.data);
      })
    );

    this.socket.on(
      "terminal:resize",
      handleTerminalEvent(TerminalResizePayloadSchema, payload => {
        this.terminalManager.resize(
          payload.terminalId,
          payload.cols,
          payload.rows
        );
      })
    );

    this.socket.on(
      "terminal:close",
      handleTerminalEvent(TerminalClosePayloadSchema, payload => {
        this.terminalManager.close(payload.terminalId);
      })
    );

    this.socket.on(
      "claude:pty-write",
      handleTerminalEvent(ClaudePtyWritePayloadSchema, payload => {
        const handle = getActivePty(payload.sessionId);
        if (!handle || handle.killed()) {
          logger.debug(
            `[API] claude:pty-write dropped — no active PTY for session ${payload.sessionId}`
          );
          return;
        }
        handle.write(payload.data);
      })
    );

    this.socket.on(
      "claude:pty-resize",
      handleTerminalEvent(ClaudePtyResizePayloadSchema, payload => {
        const handle = getActivePty(payload.sessionId);
        if (!handle || handle.killed()) {
          logger.debug(
            `[API] claude:pty-resize dropped — no active PTY for session ${payload.sessionId}`
          );
          return;
        }
        handle.resize(payload.cols, payload.rows);
      })
    );

    this.socket.on("update", (data: Update) => {
      try {
        if (!data.body) return;

        // Defense-in-depth: validate session ID matches to prevent
        // cross-session contamination during server restart reconnection
        if ("sid" in data.body && data.body.sid !== this.sessionId) {
          logger.debug("[API] ISOLATION: Dropped update for wrong session", {
            expected: this.sessionId,
            received: data.body.sid,
          });
          return;
        }

        if (data.body.t === "new-message") {
          this.handleIncomingMessage(data.body.message);
          return;
        }

        if (data.body.t === "update-session") {
          if (
            data.body.metadata &&
            data.body.metadata.version > this.metadataVersion
          ) {
            const parsed = MetadataSchema.safeParse(data.body.metadata.value);
            if (parsed.success) {
              this.metadata = parsed.data;
            } else {
              logger.debug("[API] Ignoring invalid metadata update", {
                version: data.body.metadata.version,
              });
            }
            this.metadataVersion = data.body.metadata.version;
          }
          if (
            data.body.agentState &&
            data.body.agentState.version > this.agentStateVersion
          ) {
            const next = data.body.agentState.value;
            if (next == null) {
              this.agentState = null;
            } else {
              const parsed = AgentStateSchema.safeParse(next);
              if (parsed.success) {
                this.agentState = parsed.data;
              } else {
                logger.debug("[API] Ignoring invalid agentState update", {
                  version: data.body.agentState.version,
                });
              }
            }
            this.agentStateVersion = data.body.agentState.version;
          }
          return;
        }

        this.emit("message", data.body);
      } catch (error) {
        logger.debug("[SOCKET] [UPDATE] [ERROR] Error handling update", {
          error,
        });
      }
    });

    this.socket.connect();
  }

  /**
   * A current `Session` view for extension lifecycle events (issue #1268):
   * the construction-time record overlaid with this client's live
   * metadata/agentState, which mutate over the session's life. Returning the
   * raw construction-time record instead would hand extensions a stale
   * `metadata` (and therefore a stale `path`, `flavor`, launcher kind, …) at
   * session end, when the whole point of the event is to report final state.
   */
  getSessionSnapshot(): Session {
    return {
      ...this.sessionRecord,
      metadata: this.metadata,
      metadataVersion: this.metadataVersion,
      agentState: this.agentState,
      agentStateVersion: this.agentStateVersion,
    };
  }

  onUserMessage(callback: (data: UserMessage) => void): void {
    this.pendingMessageCallback = callback;
    while (this.pendingMessages.length > 0) {
      callback(this.pendingMessages.shift()!);
    }
  }

  private enqueueUserMessage(message: UserMessage): void {
    if (this.pendingMessageCallback) {
      this.pendingMessageCallback(message);
    } else {
      this.pendingMessages.push(message);
    }
  }

  private handleIncomingMessage(message: {
    seq?: number;
    content: unknown;
  }): void {
    const seq = typeof message.seq === "number" ? message.seq : null;
    if (seq !== null) {
      if (this.lastSeenMessageSeq !== null && seq <= this.lastSeenMessageSeq) {
        return;
      }
      this.lastSeenMessageSeq = seq;
    }

    const userResult = UserMessageSchema.safeParse(message.content);
    if (userResult.success) {
      this.enqueueUserMessage(userResult.data);
      return;
    }

    this.emit("message", message.content);
  }

  private async backfillIfNeeded(): Promise<void> {
    if (!this.needsBackfill) {
      return;
    }
    try {
      await this.backfillMessages();
      this.needsBackfill = false;
    } catch (error) {
      logger.debug("[API] Backfill failed", error);
      this.needsBackfill = true;
    }
  }

  private async backfillMessages(): Promise<void> {
    if (this.backfillInFlight) {
      await this.backfillInFlight;
      return;
    }

    const startSeq = this.lastSeenMessageSeq ?? 0;
    if (startSeq === 0) {
      logger.debug(
        "[API] Backfilling from beginning (no last-seen message sequence)"
      );
    }

    const limit = 200;
    const run = async () => {
      let cursor = startSeq;
      while (true) {
        const response = await axios.get(
          `${configuration.serverUrl}/cli/sessions/${encodeURIComponent(this.sessionId)}/messages`,
          {
            params: { afterSeq: cursor, limit },
            headers: {
              Authorization: `Bearer ${this.token}`,
              "Content-Type": "application/json",
            },
            timeout: 15_000,
          }
        );

        const parsed = CliMessagesResponseSchema.safeParse(response.data);
        if (!parsed.success) {
          throw new Error("Invalid /cli/sessions/:id/messages response");
        }

        const messages = parsed.data.messages;
        if (messages.length === 0) {
          break;
        }

        let maxSeq = cursor;
        for (const message of messages) {
          if (typeof message.seq === "number") {
            if (message.seq > maxSeq) {
              maxSeq = message.seq;
            }
          }
          this.handleIncomingMessage(message);
        }

        const observedSeq = this.lastSeenMessageSeq ?? maxSeq;
        const nextCursor = Math.max(maxSeq, observedSeq);
        if (nextCursor <= cursor) {
          logger.debug("[API] Backfill stopped due to non-advancing cursor", {
            cursor,
            maxSeq,
            observedSeq,
          });
          break;
        }

        cursor = nextCursor;
        if (messages.length < limit) {
          break;
        }
      }
    };

    this.backfillInFlight = run().finally(() => {
      this.backfillInFlight = null;
    });

    await this.backfillInFlight;
  }

  sendClaudeSessionMessage(body: RawJSONLines): void {
    let content: MessageContent;

    if (
      body.type === "user" &&
      typeof body.message.content === "string" &&
      body.isSidechain !== true &&
      body.isMeta !== true
    ) {
      content = {
        role: "user",
        content: {
          type: "text",
          text: body.message.content,
        },
        meta: {
          sentFrom: "cli",
          generatedAt: Date.now(),
          ...((body as Record<string, unknown>).isTaskNotification
            ? { isTaskNotification: true }
            : {}),
        },
      };
    } else {
      content = {
        role: "agent",
        content: {
          type: "output",
          data: body,
        },
        meta: {
          sentFrom: "cli",
          generatedAt: Date.now(),
        },
      };
    }

    if (!this.socket.connected) {
      logger.warn(
        `[apiSession] ⚠️ Emitting message while disconnected — will be buffered by Socket.IO. ` +
          `type=${body.type}, generatedAt=${Date.now()}`
      );
    }

    this.socket.emit("message", {
      sid: this.sessionId,
      message: content,
    });

    if (body.type === "summary" && "summary" in body && "leafUuid" in body) {
      this.updateMetadata(metadata => ({
        ...metadata,
        summary: {
          text: body.summary,
          updatedAt: Date.now(),
        },
      }));
    }
  }

  sendUserMessage(text: string, meta?: MessageMeta): void {
    if (!text) {
      return;
    }

    const content: MessageContent = {
      role: "user",
      content: {
        type: "text",
        text,
      },
      meta: {
        sentFrom: "cli",
        generatedAt: Date.now(),
        ...(meta ?? {}),
      },
    };

    this.socket.emit("message", {
      sid: this.sessionId,
      message: content,
    });
  }

  sendClaudePtyOutput(data: string): void {
    if (!data) return;
    const payload: ClaudePtyOutputPayload = {
      sessionId: this.sessionId,
      data,
    };
    this.socket.emit("claude:pty-output", payload);
  }

  sendCodexMessage(body: unknown): void {
    const content = {
      role: "agent",
      content: {
        type: "codex",
        data: body,
      },
      meta: {
        sentFrom: "cli",
        generatedAt: Date.now(),
      },
    };
    this.socket.emit("message", {
      sid: this.sessionId,
      message: content,
    });
  }

  sendSessionEvent(
    event:
      | {
          type: "switch";
          mode: "local" | "remote";
        }
      | {
          type: "message";
          message: string;
        }
      | {
          type: "permission-mode-changed";
          mode: SessionPermissionMode;
        }
      | {
          type: "ready";
        }
      | {
          type: "exit-diagnostics";
          exitType: "signal" | "crash" | "rapid-exit";
          exitCode: number | null;
          signal: string | null;
          duration_ms: number;
          ongoingToolCalls: number;
          errorDetail: string;
        },
    id?: string
  ): void {
    const content = {
      role: "agent",
      content: {
        id: id ?? randomUUID(),
        type: "event",
        data: event,
      },
    };

    this.socket.emit("message", {
      sid: this.sessionId,
      message: content,
    });
  }

  keepAlive(
    thinking: boolean,
    mode: "local" | "remote",
    runtime?: {
      permissionMode?: SessionPermissionMode;
      modelMode?: SessionModelMode;
      // Issue #2456: live reasoning-effort level → session-alive → web effort tag.
      effort?: string;
      // Composer-chip pin integrity: pinned raw model id; `null` = pin cleared.
      rawModel?: string | null;
      resolvedModel?: string;
      contextWindowTokens?: number;
      contextUsedTokens?: number;
      contextPercentage?: number;
      // Issue #1653: blocked-on-TUI-prompt state rides the runtime object
      // (ruling D5 — NOT a 4th positional arg). Spread into the session-alive
      // payload below; the server mirrors `thinking`'s always-assign so this
      // must be sent on every tick (getKeepAliveRuntime always includes it).
      blockedOnTuiPrompt?: { message: string; since: number } | null;
      // Issue #1647: rate-limited (429 session-limit) state rides the same
      // runtime object, same always-assign contract as blockedOnTuiPrompt.
      rateLimited?: {
        resetText: string;
        resetAt: number | null;
        since: number;
      } | null;
      // Issue #4383: background-agents snapshot (K11 — always present, null when
      // none). Rides the same runtime object spread into session-alive.
      backgroundAgents?: BackgroundAgentsSnapshot | null;
    }
  ): void {
    // Reliable keepalive - do NOT use .volatile as dropped keepalives cause
    // the server's expireInactive() to mark session as inactive, leading to
    // "process stopped unexpectedly" errors on next prompt (see issue #30)
    this.socket.emit("session-alive", {
      sid: this.sessionId,
      time: Date.now(),
      thinking,
      mode,
      ...(runtime ?? {}),
    });
  }

  sendSessionDeath(): void {
    this.socket.emit("session-end", { sid: this.sessionId, time: Date.now() });
  }

  /**
   * Issue #1664 (epic #1662, Sub B): emit a per-turn telemetry event over the
   * `/cli` channel on a dedicated `turn:open` / `turn:finalize` event (mirrors
   * the `emit("message")` disconnect-buffering pattern). The server injects the
   * persisted `seq`; the CLI carries only the `turnLocalId` (dedup key) and the
   * facts the server cannot reconstruct (the reporter's clock + outcome).
   *
   * FAIL-OPEN (R8): a turn-telemetry emit MUST NEVER throw to the session
   * critical path. Any error is logged and swallowed — turn rows are a
   * rebuildable index, never worth disturbing a live session for.
   */
  sendTurnEvent(payload: TurnEventPayload): void {
    try {
      if (!this.socket.connected) {
        logger.debug(
          `[apiSession] turn:${payload.kind} emitted while disconnected — Socket.IO will buffer it`
        );
      }
      // Branch so TypeScript pairs each event name with its narrowed payload.
      if (payload.kind === "open") {
        this.socket.emit("turn:open", { sid: this.sessionId, ...payload });
      } else {
        this.socket.emit("turn:finalize", { sid: this.sessionId, ...payload });
      }
    } catch (error) {
      logger.debug("[apiSession] sendTurnEvent failed (swallowed, R8):", error);
    }
  }

  /**
   * Issue #3809: emit an OpenAI/codex `token_count.rate_limits` pacing snapshot
   * over the SAME `/cli` socket the turn reporter uses (a distinct event, not a
   * parallel channel). The server attributes it to the session's bound account
   * (`session.metadata.accountUuid`) and stores the newest per account.
   *
   * FAIL-OPEN (mirrors `sendTurnEvent`): a snapshot emit MUST NEVER throw to the
   * session critical path — provider usage is a rebuildable pacing signal.
   */
  sendProviderUsageSnapshot(payload: {
    provider: "openai";
    windows: ProviderUsageSnapshotWindow[];
  }): void {
    try {
      this.socket.emit("provider-usage-snapshot", {
        sid: this.sessionId,
        ...payload,
      });
    } catch (error) {
      logger.debug(
        "[apiSession] sendProviderUsageSnapshot failed (swallowed):",
        error
      );
    }
  }

  updateMetadata(handler: (metadata: Metadata) => Metadata): void {
    this.metadataLock.inLock(async () => {
      await backoff(async () => {
        const current = this.metadata ?? ({} as Metadata);
        const updated = handler(current);

        const answer = (await this.socket.emitWithAck("update-metadata", {
          sid: this.sessionId,
          expectedVersion: this.metadataVersion,
          metadata: updated,
        })) as unknown;

        applyVersionedAck(answer, {
          valueKey: "metadata",
          parseValue: value => {
            const parsed = MetadataSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
          },
          applyValue: value => {
            this.metadata = value;
          },
          applyVersion: version => {
            this.metadataVersion = version;
          },
          logInvalidValue: (context, version) => {
            const suffix =
              context === "success" ? "ack" : "version-mismatch ack";
            logger.debug(
              `[API] Ignoring invalid metadata value from ${suffix}`,
              { version }
            );
          },
          invalidResponseMessage: "Invalid update-metadata response",
          errorMessage: "Metadata update failed",
          versionMismatchMessage: "Metadata version mismatch",
        });
      });
    });
  }

  updateAgentState(handler: (state: AgentState) => AgentState): void {
    this.agentStateLock.inLock(async () => {
      await backoff(async () => {
        const current = this.agentState ?? ({} as AgentState);
        const updated = handler(current);

        const answer = (await this.socket.emitWithAck("update-state", {
          sid: this.sessionId,
          expectedVersion: this.agentStateVersion,
          agentState: updated,
        })) as unknown;

        applyVersionedAck(answer, {
          valueKey: "agentState",
          parseValue: value => {
            const parsed = AgentStateSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
          },
          applyValue: value => {
            this.agentState = value;
          },
          applyVersion: version => {
            this.agentStateVersion = version;
          },
          logInvalidValue: (context, version) => {
            const suffix =
              context === "success" ? "ack" : "version-mismatch ack";
            logger.debug(
              `[API] Ignoring invalid agentState value from ${suffix}`,
              { version }
            );
          },
          invalidResponseMessage: "Invalid update-state response",
          errorMessage: "Agent state update failed",
          versionMismatchMessage: "Agent state version mismatch",
        });
      });
    });
  }

  private async waitForConnected(timeoutMs: number): Promise<boolean> {
    if (this.socket.connected) {
      return true;
    }

    this.socket.connect();

    return await new Promise<boolean>(resolve => {
      let settled = false;

      const cleanup = () => {
        this.socket.off("connect", onConnect);
        clearTimeout(timeout);
      };

      const onConnect = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(true);
      };

      const timeout = setTimeout(
        () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(false);
        },
        Math.max(0, timeoutMs)
      );

      this.socket.on("connect", onConnect);
    });
  }

  private async drainLock(
    lock: AsyncLock,
    timeoutMs: number
  ): Promise<boolean> {
    if (timeoutMs <= 0) {
      return false;
    }

    return await new Promise<boolean>(resolve => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;

      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      };

      timeout = setTimeout(() => finish(false), timeoutMs);

      lock
        .inLock(async () => {})
        .then(() => finish(true))
        .catch(() => finish(false));
    });
  }

  async flush(options?: { timeoutMs?: number }): Promise<void> {
    const deadlineMs = Date.now() + (options?.timeoutMs ?? 5_000);

    const remainingMs = () => Math.max(0, deadlineMs - Date.now());

    await this.drainLock(this.metadataLock, remainingMs());
    await this.drainLock(this.agentStateLock, remainingMs());

    if (remainingMs() === 0) {
      return;
    }

    const connected = await this.waitForConnected(remainingMs());
    if (!connected) {
      return;
    }

    const pingTimeoutMs = remainingMs();
    if (pingTimeoutMs === 0) {
      return;
    }

    try {
      await this.socket.timeout(pingTimeoutMs).emitWithAck("ping");
    } catch {
      // best effort
    }
  }

  close(): void {
    this.rpcHandlerManager.onSocketDisconnect();
    this.terminalManager.closeAll();
    this.socket.disconnect();
  }
}
