// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelMode, PermissionMode } from "@hapi/protocol/types";
import type { BackgroundAgentsSnapshot } from "@hapi/protocol/schemas";
import type { Store, StoredMachine, StoredSession } from "../../../store";
import type { RpcRegistry } from "../../rpcRegistry";
import type { SyncEvent } from "../../../sync/syncEngine";
import type {
  TurnOpenEvent,
  TurnFinalizeEvent,
} from "../../../sync/turnLifecycle";
import type { TerminalRegistry } from "../../terminalRegistry";
import type { ClaudePtyRegistry } from "../../claudePtyRegistry";
import type { SocketServer, SocketWithData } from "../../socketTypes";
import type { ErrorLogger } from "../../../logging/errorLogger";
import type { MessageWriteRetryQueue } from "./messageWriteRetryQueue";
import { recordFirstCliConnect } from "./cliConnectFloors";
import { registerMachineHandlers } from "./machineHandlers";
import { registerRpcHandlers } from "./rpcHandlers";
import {
  registerSessionHandlers,
  type ProviderUsageSnapshotEvent,
} from "./sessionHandlers";
import {
  cleanupTerminalHandlers,
  registerTerminalHandlers,
} from "./terminalHandlers";
import {
  cleanupClaudePtyCliHandlers,
  registerClaudePtyCliHandlers,
} from "./claudePtyHandlers";

type SessionAlivePayload = {
  sid: string;
  time: number;
  thinking?: boolean;
  mode?: "local" | "remote";
  permissionMode?: PermissionMode;
  modelMode?: ModelMode;
  // Issue #2456: live reasoning-effort level riding the keepAlive tick.
  effort?: string;
  // Issue #6166: applied effort read back from Claude (`null` = none).
  appliedEffort?: string | null;
  appliedModel?: string;
  appliedForEffort?: string | null;
  resolvedModel?: string;
  contextWindowTokens?: number;
  contextUsedTokens?: number;
  contextPercentage?: number;
  // Issue #4383: background-agents snapshot forwarded whole (K11).
  backgroundAgents?: BackgroundAgentsSnapshot | null;
};

type SessionEndPayload = {
  sid: string;
  time: number;
};

type MachineAlivePayload = {
  machineId: string;
  time: number;
};

export type CliHandlersDeps = {
  io: SocketServer;
  store: Store;
  rpcRegistry: RpcRegistry;
  terminalRegistry: TerminalRegistry;
  claudePtyRegistry: ClaudePtyRegistry;
  onSessionAlive?: (payload: SessionAlivePayload) => void;
  onSessionEnd?: (payload: SessionEndPayload) => void;
  onMachineAlive?: (payload: MachineAlivePayload) => void;
  onWebappEvent?: (event: SyncEvent) => void;
  onArchiveSession?: (sessionId: string) => void;
  onTurnOpen?: (event: TurnOpenEvent) => void;
  onTurnFinalize?: (event: TurnFinalizeEvent) => void;
  /** Issue #3809: an OpenAI/codex pacing snapshot → ProviderUsageService. */
  onProviderUsageSnapshot?: (event: ProviderUsageSnapshotEvent) => void;
  /** #3631: logging channel for the fail-open session `message` store write. */
  errorLogger?: ErrorLogger | null;
  /** #3631: deferred re-attempt queue for a SQLITE_BUSY message write (ruling D1). */
  messageWriteRetryQueue?: MessageWriteRetryQueue | null;
};

/**
 * Grace timers for CLI socket disconnects. When a CLI socket disconnects,
 * we wait 30s before archiving the session — the CLI may reconnect (e.g.,
 * during context compaction or brief network drops). (Issue #849)
 */
const disconnectGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DISCONNECT_GRACE_MS = 30_000;

type AccessErrorReason = "namespace-missing" | "access-denied" | "not-found";

type AccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AccessErrorReason };

export function registerCliHandlers(
  socket: SocketWithData,
  deps: CliHandlersDeps
): void {
  const {
    io,
    store,
    rpcRegistry,
    terminalRegistry,
    claudePtyRegistry,
    onSessionAlive,
    onSessionEnd,
    onMachineAlive,
    onWebappEvent,
  } = deps;
  const terminalNamespace = io.of("/terminal");
  const claudePtyNamespace = io.of("/claude-pty");
  const namespace =
    typeof socket.data.namespace === "string" ? socket.data.namespace : null;

  const resolveSessionAccess = (
    sessionId: string
  ): AccessResult<StoredSession> => {
    if (!namespace) {
      return { ok: false, reason: "namespace-missing" };
    }
    const session = store.sessions.getSessionByNamespace(sessionId, namespace);
    if (session) {
      return { ok: true, value: session };
    }
    if (store.sessions.getSession(sessionId)) {
      return { ok: false, reason: "access-denied" };
    }
    return { ok: false, reason: "not-found" };
  };

  const resolveMachineAccess = (
    machineId: string
  ): AccessResult<StoredMachine> => {
    if (!namespace) {
      return { ok: false, reason: "namespace-missing" };
    }
    const machine = store.machines.getMachineByNamespace(machineId, namespace);
    if (machine) {
      return { ok: true, value: machine };
    }
    if (store.machines.getMachine(machineId)) {
      return { ok: false, reason: "access-denied" };
    }
    return { ok: false, reason: "not-found" };
  };

  const auth = socket.handshake.auth as Record<string, unknown> | undefined;
  const sessionId = typeof auth?.sessionId === "string" ? auth.sessionId : null;
  if (sessionId && resolveSessionAccess(sessionId).ok) {
    socket.join(`session:${sessionId}`);
    // #4682 (R15): the floor an old wrapper's from-zero backfill is served
    // from. This listener runs before any packet from the client is
    // processed, so the floor never includes the client's flushed buffered
    // writes. Never throws.
    recordFirstCliConnect(store, sessionId);

    // Cancel any pending disconnect grace timer — this session reconnected. (Issue #849)
    const pendingTimer = disconnectGraceTimers.get(sessionId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      disconnectGraceTimers.delete(sessionId);
    }
  }

  const machineId = typeof auth?.machineId === "string" ? auth.machineId : null;
  if (machineId && resolveMachineAccess(machineId).ok) {
    socket.join(`machine:${machineId}`);
  }

  const emitAccessError = (
    scope: "session" | "machine",
    id: string,
    reason: AccessErrorReason
  ) => {
    const message =
      reason === "access-denied"
        ? `${scope} access denied`
        : reason === "not-found"
          ? `${scope} not found`
          : "Namespace missing";
    socket.emit("error", { message, code: reason, scope, id });
  };

  registerRpcHandlers(socket, rpcRegistry);
  registerSessionHandlers(socket, {
    store,
    resolveSessionAccess,
    emitAccessError,
    onSessionAlive,
    onSessionEnd,
    onWebappEvent,
    onTurnOpen: deps.onTurnOpen,
    onTurnFinalize: deps.onTurnFinalize,
    onProviderUsageSnapshot: deps.onProviderUsageSnapshot,
    errorLogger: deps.errorLogger,
    messageWriteRetryQueue: deps.messageWriteRetryQueue,
  });
  registerMachineHandlers(socket, {
    store,
    resolveMachineAccess,
    emitAccessError,
    onMachineAlive,
    onWebappEvent,
  });
  registerTerminalHandlers(socket, {
    terminalRegistry,
    terminalNamespace,
    resolveSessionAccess,
    emitAccessError,
  });
  registerClaudePtyCliHandlers(socket, {
    claudePtyRegistry,
    claudePtyNamespace,
    resolveSessionAccess,
    emitAccessError,
  });

  socket.on("ping", (callback: () => void) => {
    callback();
  });

  socket.on("disconnect", () => {
    rpcRegistry.unregisterAll(socket);
    cleanupTerminalHandlers(socket, { terminalRegistry, terminalNamespace });
    cleanupClaudePtyCliHandlers(socket, {
      claudePtyRegistry,
      claudePtyNamespace,
    });

    // Start disconnect grace timer — if the CLI doesn't reconnect within
    // DISCONNECT_GRACE_MS, archive the session to trigger process cleanup.
    // This catches tab closes, network drops, and browser crashes that
    // previously left MCP server processes orphaned. (Issue #849)
    if (sessionId && deps.onArchiveSession) {
      const archiveCallback = deps.onArchiveSession;
      // #6264: replace, never orphan, a pending timer. An overwritten handle can
      // no longer be cancelled by a reconnect and would archive a live session.
      clearTimeout(disconnectGraceTimers.get(sessionId));
      const cliNamespace = socket.nsp;
      const timer = setTimeout(() => {
        disconnectGraceTimers.delete(sessionId);
        // #6264: a stale socket's disconnect (e.g. one that outlived a server
        // stall) must not archive a session another socket now serves. By the
        // "disconnect" event socket.io has already removed THIS socket from its
        // rooms, so any live member is a different connection.
        if (hasLiveCliSocket(cliNamespace, sessionId)) {
          deps.errorLogger?.warn(
            `Disconnect grace expired for ${sessionId} but a live CLI socket is connected — skipping archive (issue #6264)`,
            { category: "socket", sessionId }
          );
          return;
        }
        archiveCallback(sessionId);
      }, DISCONNECT_GRACE_MS);
      disconnectGraceTimers.set(sessionId, timer);
    }
  });
}

/** True when room `session:<id>` holds a socket the namespace still knows. */
function hasLiveCliSocket(
  cliNamespace: SocketWithData["nsp"],
  sessionId: string
): boolean {
  const room = cliNamespace.adapter.rooms.get(`session:${sessionId}`);
  for (const id of room ?? []) {
    if (cliNamespace.sockets.get(id)) return true;
  }
  return false;
}
