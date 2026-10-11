// SPDX-License-Identifier: AGPL-3.0-only
import { Server as Engine } from "@socket.io/bun-engine";
import { Server, type DefaultEventsMap } from "socket.io";
import { jwtVerify } from "jose";
import { z } from "zod";
import type { Store } from "../store";
import { configuration } from "../configuration";
import { constantTimeEquals } from "../utils/crypto";
import { parseAccessToken } from "../utils/accessToken";
import { registerCliHandlers } from "./handlers/cli";
import { registerTerminalHandlers } from "./handlers/terminal";
import { registerClaudePtyWebHandlers } from "./handlers/claudePty";
import { RpcRegistry } from "./rpcRegistry";
import type { SyncEvent } from "../sync/syncEngine";
import type { BackgroundAgentsSnapshot } from "@hapi/protocol/schemas";
import type { TurnOpenEvent, TurnFinalizeEvent } from "../sync/turnLifecycle";
import type { ProviderUsageSnapshotEvent } from "./handlers/cli/sessionHandlers";
import { TerminalRegistry } from "./terminalRegistry";
import { ClaudePtyRegistry } from "./claudePtyRegistry";
import type { SocketData, SocketServer } from "./socketTypes";
import type { RemoteTerminalProxy } from "../federation/remoteTerminalProxy";
import type { ErrorLogger } from "../logging/errorLogger";
import type { MessageWriteRetryQueue } from "./handlers/cli/messageWriteRetryQueue";

const jwtPayloadSchema = z.object({
  uid: z.number(),
  ns: z.string(),
});

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_MAX_TERMINALS = 4;

function resolveEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export type SocketServerDeps = {
  store: Store;
  jwtSecret: Uint8Array;
  getSession?: (
    sessionId: string
  ) => { active: boolean; namespace: string } | null;
  onWebappEvent?: (event: SyncEvent) => void;
  onSessionAlive?: (payload: {
    sid: string;
    time: number;
    thinking?: boolean;
    mode?: "local" | "remote";
    effort?: string;
    rawModel?: string | null;
    resolvedModel?: string;
    contextWindowTokens?: number;
    contextUsedTokens?: number;
    contextPercentage?: number;
    // Issue #4383: background-agents snapshot forwarded whole to the engine (K11).
    backgroundAgents?: BackgroundAgentsSnapshot | null;
  }) => void;
  onSessionEnd?: (payload: { sid: string; time: number }) => void;
  onMachineAlive?: (payload: { machineId: string; time: number }) => void;
  /** Archive a session after disconnect grace timeout. (Issue #849) */
  onArchiveSession?: (sessionId: string) => void;
  /** Issue #1664 (Sub B): per-turn telemetry open/finalize → turnLifecycle. */
  onTurnOpen?: (event: TurnOpenEvent) => void;
  onTurnFinalize?: (event: TurnFinalizeEvent) => void;
  /** Issue #3809: an OpenAI/codex pacing snapshot → ProviderUsageService. */
  onProviderUsageSnapshot?: (event: ProviderUsageSnapshotEvent) => void;
  /** Federation: proxy for remote terminal I/O (hub only, late-bound). */
  getRemoteTerminalProxy?: () => RemoteTerminalProxy | null;
  /** Federation: resolve sessionId → remote node URL (hub only, late-bound). */
  findNodeForSession?: (
    sessionId: string
  ) => { nodeId: string; url: string } | null;
  /** #3631: logging channel for the CLI handlers' fail-open store writes. */
  errorLogger?: ErrorLogger | null;
  /** #3631: deferred re-attempt queue for a SQLITE_BUSY message write (ruling D1). */
  messageWriteRetryQueue?: MessageWriteRetryQueue | null;
};

export function createSocketServer(deps: SocketServerDeps): {
  io: SocketServer;
  engine: Engine;
  rpcRegistry: RpcRegistry;
  terminalRegistry: TerminalRegistry;
  claudePtyRegistry: ClaudePtyRegistry;
} {
  const corsOrigins = configuration.corsOrigins;
  const allowAllOrigins = corsOrigins.includes("*");

  const io = new Server<
    DefaultEventsMap,
    DefaultEventsMap,
    DefaultEventsMap,
    SocketData
  >({
    cors: {
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        if (allowAllOrigins || corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error("Origin not allowed"), false);
      },
      methods: ["GET", "POST"],
      credentials: false,
    },
  });

  // maxHttpBufferSize controls Bun.serve's maxRequestBodySize (via
  // socketEngine.handler() in web/server.ts) and also gates the Socket.IO WS
  // message size. Default is 1MB which is too small for file uploads.
  // Set to 220MB (issue #2030) to support video uploads — strictly greater than
  // the 200MB application MAX_FILE_SIZE (upload.ts) so the friendly app-level
  // 400 fires before this bare transport 413.
  const engine = new Engine({
    path: "/socket.io/",
    maxHttpBufferSize: 220 * 1024 * 1024,
  });
  io.bind(engine);

  const rpcRegistry = new RpcRegistry();
  const idleTimeoutMs = resolveEnvNumber(
    "HAPI_TERMINAL_IDLE_TIMEOUT_MS",
    DEFAULT_IDLE_TIMEOUT_MS
  );
  const maxTerminals = resolveEnvNumber(
    "HAPI_TERMINAL_MAX_TERMINALS",
    DEFAULT_MAX_TERMINALS
  );
  const maxTerminalsPerSocket = maxTerminals;
  const maxTerminalsPerSession = maxTerminals;
  const cliNs = io.of("/cli");
  const terminalNs = io.of("/terminal");
  const claudePtyNs = io.of("/claude-pty");
  const claudePtyRegistry = new ClaudePtyRegistry();
  const terminalRegistry = new TerminalRegistry({
    idleTimeoutMs,
    onIdle: entry => {
      const terminalSocket = terminalNs.sockets.get(entry.socketId);
      terminalSocket?.emit("terminal:error", {
        terminalId: entry.terminalId,
        message: "Terminal closed due to inactivity.",
      });
      const cliSocket = cliNs.sockets.get(entry.cliSocketId);
      cliSocket?.emit("terminal:close", {
        sessionId: entry.sessionId,
        terminalId: entry.terminalId,
      });
    },
  });

  cliNs.use((socket, next) => {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const token = typeof auth?.token === "string" ? auth.token : null;
    const parsedToken = token ? parseAccessToken(token) : null;
    if (
      !parsedToken ||
      !constantTimeEquals(parsedToken.baseToken, configuration.cliApiToken)
    ) {
      return next(new Error("Invalid token"));
    }
    socket.data.namespace = parsedToken.namespace;
    next();
  });
  cliNs.on("connection", socket =>
    registerCliHandlers(socket, {
      io,
      store: deps.store,
      rpcRegistry,
      terminalRegistry,
      claudePtyRegistry,
      onSessionAlive: deps.onSessionAlive,
      onSessionEnd: deps.onSessionEnd,
      onTurnOpen: deps.onTurnOpen,
      onTurnFinalize: deps.onTurnFinalize,
      onProviderUsageSnapshot: deps.onProviderUsageSnapshot,
      onMachineAlive: deps.onMachineAlive,
      onWebappEvent: deps.onWebappEvent,
      onArchiveSession: deps.onArchiveSession,
      errorLogger: deps.errorLogger,
      messageWriteRetryQueue: deps.messageWriteRetryQueue,
    })
  );

  terminalNs.use(async (socket, next) => {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const token = typeof auth?.token === "string" ? auth.token : null;
    if (!token) {
      return next(new Error("Missing token"));
    }

    try {
      const verified = await jwtVerify(token, deps.jwtSecret, {
        algorithms: ["HS256"],
      });
      const parsed = jwtPayloadSchema.safeParse(verified.payload);
      if (!parsed.success) {
        return next(new Error("Invalid token payload"));
      }
      socket.data.userId = parsed.data.uid;
      socket.data.namespace = parsed.data.ns;
      next();
      return;
    } catch {
      return next(new Error("Invalid token"));
    }
  });
  terminalNs.on("connection", socket =>
    registerTerminalHandlers(socket, {
      io,
      getSession: sessionId =>
        deps.getSession?.(sessionId) ??
        deps.store.sessions.getSession(sessionId),
      terminalRegistry,
      maxTerminalsPerSocket,
      maxTerminalsPerSession,
      getRemoteTerminalProxy: deps.getRemoteTerminalProxy,
      findNodeForSession: deps.findNodeForSession,
    })
  );

  claudePtyNs.use(async (socket, next) => {
    const auth = socket.handshake.auth as Record<string, unknown> | undefined;
    const token = typeof auth?.token === "string" ? auth.token : null;
    if (!token) {
      return next(new Error("Missing token"));
    }

    try {
      const verified = await jwtVerify(token, deps.jwtSecret, {
        algorithms: ["HS256"],
      });
      const parsed = jwtPayloadSchema.safeParse(verified.payload);
      if (!parsed.success) {
        return next(new Error("Invalid token payload"));
      }
      socket.data.userId = parsed.data.uid;
      socket.data.namespace = parsed.data.ns;
      next();
      return;
    } catch {
      return next(new Error("Invalid token"));
    }
  });
  claudePtyNs.on("connection", socket =>
    registerClaudePtyWebHandlers(socket, {
      io,
      getSession: sessionId =>
        deps.getSession?.(sessionId) ??
        deps.store.sessions.getSession(sessionId),
      claudePtyRegistry,
    })
  );

  return { io, engine, rpcRegistry, terminalRegistry, claudePtyRegistry };
}
