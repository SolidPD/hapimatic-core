// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { StoredSession } from "../../../store";
import type { ClaudePtyRegistry } from "../../claudePtyRegistry";
import type { SocketServer, SocketWithData } from "../../socketTypes";
import {
  createReportGate,
  type AfterDroppedReportFn,
  type GateReportFn,
} from "./reportGate";

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
  /** Issue #6974 (Task 5, O5 P1): the runner identity backstop. */
  gateReport?: GateReportFn;
  /** Issue #6974 (Task 5): after a drop, cut its socket off (R5). */
  afterDroppedReport?: AfterDroppedReportFn;
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
  const { gate, dropped } = createReportGate(
    socket,
    deps.gateReport,
    deps.afterDroppedReport
  );

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
    // #6974 (O5 P1): the one ungated path that re-pointed the operator's
    // keystrokes to its sender; the backstop runs before the re-point.
    if (!gate(parsed.data.sessionId, "claude:pty-output")) {
      dropped();
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
