// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { StoredSession } from "../../../store";
import type { ClaudePtyRegistry } from "../../claudePtyRegistry";
import type { SocketServer, SocketWithData } from "../../socketTypes";

type AccessErrorReason = "namespace-missing" | "access-denied" | "not-found";

type AccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AccessErrorReason };

type ResolveSessionAccess = (sessionId: string) => AccessResult<StoredSession>;

type EmitAccessError = (
  scope: "session" | "machine",
  id: string,
  reason: AccessErrorReason
) => void;

type SocketNamespace = ReturnType<SocketServer["of"]>;

const claudePtyOutputSchema = z.object({
  sessionId: z.string().min(1),
  data: z.string(),
});

export type ClaudePtyCliHandlersDeps = {
  claudePtyRegistry: ClaudePtyRegistry;
  claudePtyNamespace: SocketNamespace;
  resolveSessionAccess: ResolveSessionAccess;
  emitAccessError: EmitAccessError;
};

export function registerClaudePtyCliHandlers(
  socket: SocketWithData,
  deps: ClaudePtyCliHandlersDeps
): void {
  const {
    claudePtyRegistry,
    claudePtyNamespace,
    resolveSessionAccess,
    emitAccessError,
  } = deps;

  socket.on("claude:pty-output", (data: unknown) => {
    const parsed = claudePtyOutputSchema.safeParse(data);
    if (!parsed.success) {
      return;
    }
    const sessionAccess = resolveSessionAccess(parsed.data.sessionId);
    if (!sessionAccess.ok) {
      emitAccessError("session", parsed.data.sessionId, sessionAccess.reason);
      return;
    }
    claudePtyRegistry.register(parsed.data.sessionId, socket.id);
    claudePtyNamespace
      .to(`session:${parsed.data.sessionId}`)
      .emit("claude:pty-output", parsed.data);
  });
}

export function cleanupClaudePtyCliHandlers(
  socket: SocketWithData,
  deps: {
    claudePtyRegistry: ClaudePtyRegistry;
    claudePtyNamespace: SocketNamespace;
  }
): void {
  const removed = deps.claudePtyRegistry.removeByCliSocket(socket.id);
  for (const entry of removed) {
    deps.claudePtyNamespace
      .to(`session:${entry.sessionId}`)
      .emit("claude:pty-cli-disconnected", { sessionId: entry.sessionId });
  }
}
