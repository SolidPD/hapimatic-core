// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { ClaudePtyRegistry } from "../claudePtyRegistry";
import type { SocketServer, SocketWithData } from "../socketTypes";

const claudePtySubscribeSchema = z.object({
  sessionId: z.string().min(1),
});

const claudePtyWriteSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

const claudePtyResizeSchema = z.object({
  sessionId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

const claudePtyUnsubscribeSchema = z.object({
  sessionId: z.string().min(1),
});

export type ClaudePtyHandlersDeps = {
  io: SocketServer;
  getSession: (
    sessionId: string
  ) => { active: boolean; namespace: string } | null;
  claudePtyRegistry: ClaudePtyRegistry;
};

export function registerClaudePtyWebHandlers(
  socket: SocketWithData,
  deps: ClaudePtyHandlersDeps
): void {
  const { io, getSession, claudePtyRegistry } = deps;
  const cliNamespace = io.of("/cli");
  const namespace =
    typeof socket.data.namespace === "string" ? socket.data.namespace : null;

  const subscribedSessions = new Set<string>();

  const emitError = (sessionId: string, message: string) => {
    socket.emit("claude:pty-error", { sessionId, message });
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

  const verifyAccess = (sessionId: string): boolean => {
    if (!namespace) {
      emitError(sessionId, "Namespace missing.");
      return false;
    }
    const session = getSession(sessionId);
    if (!session || session.namespace !== namespace) {
      emitError(sessionId, "Session not found or access denied.");
      return false;
    }
    if (!session.active) {
      emitError(sessionId, "Session is inactive.");
      return false;
    }
    return true;
  };

  socket.on("claude:pty-subscribe", (data: unknown) => {
    const parsed = claudePtySubscribeSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const { sessionId } = parsed.data;
    if (!verifyAccess(sessionId)) {
      return;
    }
    socket.join(`session:${sessionId}`);
    subscribedSessions.add(sessionId);
    socket.emit("claude:pty-ready", { sessionId });
  });

  socket.on("claude:pty-unsubscribe", (data: unknown) => {
    const parsed = claudePtyUnsubscribeSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    socket.leave(`session:${parsed.data.sessionId}`);
    subscribedSessions.delete(parsed.data.sessionId);
  });

  socket.on("claude:pty-write", (data: unknown) => {
    const parsed = claudePtyWriteSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const { sessionId, data: payload } = parsed.data;
    if (!subscribedSessions.has(sessionId)) {
      return;
    }
    if (!verifyAccess(sessionId)) {
      return;
    }
    const cliSocketId =
      claudePtyRegistry.get(sessionId)?.cliSocketId ??
      pickCliSocketId(sessionId);
    if (!cliSocketId) {
      emitError(sessionId, "CLI is not connected for this session.");
      return;
    }
    const cliSocket = cliNamespace.sockets.get(cliSocketId);
    if (!cliSocket) {
      emitError(sessionId, "CLI socket not found.");
      return;
    }
    cliSocket.emit("claude:pty-write", { sessionId, data: payload });
  });

  socket.on("claude:pty-resize", (data: unknown) => {
    const parsed = claudePtyResizeSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const { sessionId, cols, rows } = parsed.data;
    if (!subscribedSessions.has(sessionId)) {
      return;
    }
    if (!verifyAccess(sessionId)) {
      return;
    }
    const cliSocketId =
      claudePtyRegistry.get(sessionId)?.cliSocketId ??
      pickCliSocketId(sessionId);
    if (!cliSocketId) {
      emitError(sessionId, "CLI is not connected for this session.");
      return;
    }
    const cliSocket = cliNamespace.sockets.get(cliSocketId);
    if (!cliSocket) {
      emitError(sessionId, "CLI socket not found.");
      return;
    }
    cliSocket.emit("claude:pty-resize", { sessionId, cols, rows });
  });

  socket.on("disconnect", () => {
    for (const sessionId of subscribedSessions) {
      socket.leave(`session:${sessionId}`);
    }
    subscribedSessions.clear();
  });
}
