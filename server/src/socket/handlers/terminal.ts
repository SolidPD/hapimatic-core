// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type {
  TerminalRegistry,
  TerminalRegistryEntry,
} from "../terminalRegistry";
import type { SocketServer, SocketWithData } from "../socketTypes";
import type { RemoteTerminalProxy } from "../../federation/remoteTerminalProxy";

const terminalCreateSchema = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  // #4517: opt-in persistence (absent → legacy close-on-disconnect).
  persistent: z.boolean().optional(),
  // #4517: "Start new shell" — discard an exited persistent shell's record so
  // a new one spawns. Never kills a live shell.
  fresh: z.boolean().optional(),
});

const terminalWriteSchema = z.object({
  terminalId: z.string().min(1),
  data: z.string(),
});

const terminalResizeSchema = z.object({
  terminalId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const terminalCloseSchema = z.object({
  terminalId: z.string().min(1),
});

export type TerminalHandlersDeps = {
  io: SocketServer;
  getSession: (
    sessionId: string
  ) => { active: boolean; namespace: string } | null;
  terminalRegistry: TerminalRegistry;
  maxTerminalsPerSocket: number;
  maxTerminalsPerSession: number;
  /** Federation: proxy for remote terminal I/O (hub only). */
  getRemoteTerminalProxy?: () => RemoteTerminalProxy | null;
  /** Federation: resolve sessionId → remote node URL (hub only). */
  findNodeForSession?: (
    sessionId: string
  ) => { nodeId: string; url: string } | null;
};

export function registerTerminalHandlers(
  socket: SocketWithData,
  deps: TerminalHandlersDeps
): void {
  const {
    io,
    getSession,
    terminalRegistry,
    maxTerminalsPerSocket,
    maxTerminalsPerSession,
    getRemoteTerminalProxy,
    findNodeForSession,
  } = deps;
  const cliNamespace = io.of("/cli");
  const terminalNamespace = io.of("/terminal");
  const namespace =
    typeof socket.data.namespace === "string" ? socket.data.namespace : null;

  const emitTerminalError = (terminalId: string, message: string) => {
    socket.emit("terminal:error", { terminalId, message });
  };

  // #4517 (R10): for a persistent terminal, "no CLI socket right now" is a
  // transient CLI gap — the shell survives on the node. Answer with a detach
  // notice so the browser keeps backing off; an error would end its retries
  // after the first attempt. Legacy terminals keep the error.
  const emitCliUnavailable = (terminalId: string, persistent: boolean) => {
    if (persistent) {
      socket.emit("terminal:detached", {
        terminalId,
        reason: "cli-disconnected",
      });
      return;
    }
    emitTerminalError(terminalId, "CLI is not connected for this session.");
  };

  const resolveEntryForSocket = (
    terminalId: string
  ): TerminalRegistryEntry | null => {
    const entry = terminalRegistry.get(terminalId);
    if (!entry || entry.socketId !== socket.id) {
      return null;
    }
    return entry;
  };

  const resolveCliSocket = (
    entry: TerminalRegistryEntry,
    reportError: boolean
  ): SocketWithData | null => {
    const cliSocket = cliNamespace.sockets.get(entry.cliSocketId);
    if (!cliSocket || cliSocket.data.namespace !== namespace) {
      terminalRegistry.remove(entry.terminalId);
      if (reportError) {
        emitTerminalError(entry.terminalId, "CLI disconnected.");
      }
      return null;
    }
    return cliSocket;
  };

  const emitCloseToCli = (entry: TerminalRegistryEntry): void => {
    const cliSocket = cliNamespace.sockets.get(entry.cliSocketId);
    if (!cliSocket || cliSocket.data.namespace !== namespace) {
      return;
    }
    cliSocket.emit("terminal:close", {
      sessionId: entry.sessionId,
      terminalId: entry.terminalId,
    });
  };

  const pickCliSocketId = (sessionId: string): string | null => {
    const room = cliNamespace.adapter.rooms.get(`session:${sessionId}`);
    if (!room || room.size === 0) {
      return null;
    }
    for (const socketId of room) {
      const cliSocket = cliNamespace.sockets.get(socketId);
      if (cliSocket && cliSocket.data.namespace === namespace) {
        return cliSocket.id;
      }
    }
    return null;
  };

  socket.on("terminal:create", (data: unknown) => {
    const parsed = terminalCreateSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }

    const { sessionId, terminalId, cols, rows } = parsed.data;
    const persistent = parsed.data.persistent === true;
    const fresh = parsed.data.fresh === true;

    // ── Federation: check if this session lives on a remote node ──
    const proxy = getRemoteTerminalProxy?.();
    const remoteNode = findNodeForSession?.(sessionId);
    if (proxy && remoteNode) {
      // #4517: the node checks this namespace against the session's, so a
      // socket without one cannot reach a remote shell at all.
      if (!namespace) {
        emitTerminalError(terminalId, "Session is inactive or unavailable.");
        return;
      }
      // #4517: ownership lives in the proxy (owner = this socket's id), so
      // write/resize/close/disconnect below act only on terminals this socket
      // still owns — not on one it lost to a take-over, a refused create, or
      // a dropped node WebSocket.
      proxy.create({
        nodeUrl: remoteNode.url,
        sessionId,
        terminalId,
        cols,
        rows,
        persistent,
        fresh,
        ownerId: socket.id,
        namespace,
        callbacks: {
          onReady: (persistentAck: boolean) =>
            socket.emit("terminal:ready", {
              terminalId,
              persistent: persistentAck,
            }),
          onOutput: (outputData: string) =>
            socket.emit("terminal:output", { terminalId, data: outputData }),
          onExit: (code: number | null, signal: string | null) =>
            socket.emit("terminal:exit", { terminalId, code, signal }),
          onError: (message: string) =>
            socket.emit("terminal:error", { terminalId, message }),
          // #4517 (R9): another browser socket took over this persistent
          // remote terminal; the proxy already moved ownership to it.
          onDetached: (reason: string) =>
            socket.emit("terminal:detached", { terminalId, reason }),
        },
      });
      return;
    }

    // ── Local session flow ──
    const session = getSession(sessionId);
    if (!namespace || !session || session.namespace !== namespace) {
      emitTerminalError(terminalId, "Session is inactive or unavailable.");
      return;
    }
    if (!session.active) {
      // #4517 (R10): after a hub restart the session stays inactive until its
      // CLI reconnects and sends keepalive. A persistent shell is still alive
      // on the CLI, so tell the browser to keep backing off instead of ending
      // its retries. Legacy terminals keep the error.
      if (persistent) {
        emitCliUnavailable(terminalId, true);
      } else {
        emitTerminalError(terminalId, "Session is inactive or unavailable.");
      }
      return;
    }

    // #4517: an entry exists while a browser socket owns this id (same socket
    // → re-create, another socket → take-over). On a federation node the
    // registry is shared with the federation handler, so the owner can also be
    // a hub WebSocket under the synthetic `fed:<id>` socket id, which the
    // detach notice below does not reach (#4606). The CLI decides whether to
    // spawn or re-attach either way; the limit checks below are skipped
    // because no new registry entry is added.
    const existing = terminalRegistry.get(terminalId);
    if (existing) {
      if (existing.sessionId !== sessionId) {
        emitTerminalError(terminalId, "Terminal ID is already in use.");
        return;
      }
      // The CLI may have reconnected since the original attach; pick fresh.
      const cliSocketId = pickCliSocketId(sessionId);
      if (!cliSocketId) {
        emitCliUnavailable(terminalId, existing.persistent);
        return;
      }
      const cliSocket = cliNamespace.sockets.get(cliSocketId);
      if (!cliSocket) {
        emitCliUnavailable(terminalId, existing.persistent);
        return;
      }

      const sameSocket = existing.socketId === socket.id;
      if (!sameSocket && !existing.persistent) {
        // A legacy terminal owned by another socket cannot be taken over.
        emitTerminalError(terminalId, "Terminal ID is already in use.");
        return;
      }

      // Same socket → idempotent re-create; different socket + persistent →
      // take-over (D-4517-1 = A). rebind refreshes the CLI socket too.
      const prevSocketId = terminalRegistry.rebind(
        terminalId,
        socket.id,
        cliSocketId
      );
      if (prevSocketId && prevSocketId !== socket.id) {
        terminalNamespace.sockets.get(prevSocketId)?.emit("terminal:detached", {
          terminalId,
          reason: "attached-elsewhere",
        });
      }

      cliSocket.emit("terminal:open", {
        sessionId,
        terminalId,
        cols,
        rows,
        persistent: existing.persistent,
        ...(fresh ? { fresh: true } : {}),
      });
      terminalRegistry.markActivity(terminalId);
      return;
    }

    if (terminalRegistry.countForSocket(socket.id) >= maxTerminalsPerSocket) {
      emitTerminalError(
        terminalId,
        `Too many terminals open (max ${maxTerminalsPerSocket}).`
      );
      return;
    }

    if (terminalRegistry.countForSession(sessionId) >= maxTerminalsPerSession) {
      emitTerminalError(
        terminalId,
        `Too many terminals open for this session (max ${maxTerminalsPerSession}).`
      );
      return;
    }

    const cliSocketId = pickCliSocketId(sessionId);
    if (!cliSocketId) {
      emitCliUnavailable(terminalId, persistent);
      return;
    }

    const entry = terminalRegistry.register(
      terminalId,
      sessionId,
      socket.id,
      cliSocketId,
      persistent
    );
    if (!entry) {
      emitTerminalError(terminalId, "Terminal ID is already in use.");
      return;
    }

    const cliSocket = cliNamespace.sockets.get(cliSocketId);
    if (!cliSocket) {
      terminalRegistry.remove(terminalId);
      emitCliUnavailable(terminalId, persistent);
      return;
    }

    cliSocket.emit("terminal:open", {
      sessionId,
      terminalId,
      cols,
      rows,
      persistent,
      ...(fresh ? { fresh: true } : {}),
    });
    terminalRegistry.markActivity(terminalId);
  });

  socket.on("terminal:write", (data: unknown) => {
    const parsed = terminalWriteSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }

    const { terminalId, data: payload } = parsed.data;

    // Federation: route to remote proxy if applicable. #4517: only a terminal
    // this socket owns — after a take-over the previous socket no longer owns
    // the id, so its input must not reach the shell.
    const proxy = getRemoteTerminalProxy?.();
    if (proxy?.has(terminalId)) {
      if (proxy.isOwnedBy(terminalId, socket.id)) {
        proxy.write(terminalId, payload);
      }
      return;
    }

    const entry = resolveEntryForSocket(terminalId);
    if (!entry) {
      return;
    }

    const cliSocket = resolveCliSocket(entry, true);
    if (!cliSocket) {
      return;
    }
    cliSocket.emit("terminal:write", {
      sessionId: entry.sessionId,
      terminalId,
      data: payload,
    });
    terminalRegistry.markActivity(terminalId);
  });

  socket.on("terminal:resize", (data: unknown) => {
    const parsed = terminalResizeSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }

    const { terminalId, cols, rows } = parsed.data;

    // Federation: route to remote proxy if applicable (owner only, #4517 —
    // one owner, one PTY size).
    const proxy = getRemoteTerminalProxy?.();
    if (proxy?.has(terminalId)) {
      if (proxy.isOwnedBy(terminalId, socket.id)) {
        proxy.resize(terminalId, cols, rows);
      }
      return;
    }

    const entry = resolveEntryForSocket(terminalId);
    if (!entry) {
      return;
    }

    const cliSocket = resolveCliSocket(entry, true);
    if (!cliSocket) {
      return;
    }
    cliSocket.emit("terminal:resize", {
      sessionId: entry.sessionId,
      terminalId,
      cols,
      rows,
    });
    terminalRegistry.markActivity(terminalId);
  });

  socket.on("terminal:close", (data: unknown) => {
    const parsed = terminalCloseSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }

    const { terminalId } = parsed.data;

    // Federation: route to remote proxy if applicable (owner only, #4517).
    const proxy = getRemoteTerminalProxy?.();
    if (proxy?.has(terminalId)) {
      if (proxy.isOwnedBy(terminalId, socket.id)) {
        proxy.close(terminalId);
      }
      return;
    }

    const entry = resolveEntryForSocket(terminalId);
    if (!entry) {
      return;
    }

    terminalRegistry.remove(terminalId);
    emitCloseToCli(entry);
  });

  socket.on("disconnect", () => {
    // Clean up local terminals. #4517 (R2): a persistent entry DETACHES — it is
    // dropped from the registry (so CLI output stops routing to this dead
    // socket) but the CLI is NOT told to close, so the shell survives for the
    // browser's next re-attach. Legacy entries keep today's close-on-disconnect.
    const removed = terminalRegistry.removeBySocket(socket.id);
    for (const entry of removed) {
      if (!entry.persistent) {
        emitCloseToCli(entry);
      }
    }

    // Clean up remote terminals this socket still owns: detach persistent
    // ones (close the WS without sending `close` — the node keeps the shell),
    // close legacy ones (R8).
    getRemoteTerminalProxy?.()?.releaseOwner(socket.id);
  });
}
