// SPDX-License-Identifier: AGPL-3.0-only
/**
 * FederationTerminalNodeHandler — node-side WebSocket handler for
 * terminal proxy connections from the hub.
 *
 * When the hub opens a WebSocket to /api/federation/terminal, this handler:
 * 1. Receives JSON messages (create, write, resize, close)
 * 2. Routes them to the local CLI socket via the existing Socket.IO pipeline
 * 3. Listens for CLI responses (ready, output, exit, error) and relays back
 *
 * The existing CLI terminal handlers also fire for these events but harmlessly
 * drop them because the TerminalRegistry entry has a synthetic socketId that
 * doesn't map to a real /terminal namespace socket.
 */
import { z } from "zod";
import {
  FedTermHubMessageSchema,
  type FedTermHubMessage,
  type FedTermNodeMessage,
} from "@hapi/protocol";
import type { TerminalRegistry } from "../socket/terminalRegistry";
import type { SocketServer, SocketWithData } from "../socket/socketTypes";

type FedTermEntry = {
  ws: { send(data: string): void };
  sessionId: string;
  cliSocketId: string;
  // #4517: a persistent entry detaches (keeps the shell) on WS close; an
  // explicit `close` message still kills.
  persistent: boolean;
};

type FedTermCreateMessage = Extract<FedTermHubMessage, { type: "create" }>;

const cliTerminalReadySchema = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  // #4517: the CLI's persistence acknowledgement (absent from an older CLI).
  persistent: z.boolean().optional(),
});

const cliTerminalOutputSchema = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  data: z.string(),
});

const cliTerminalExitSchema = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
});

const cliTerminalErrorSchema = z.object({
  sessionId: z.string().min(1),
  terminalId: z.string().min(1),
  message: z.string(),
});

export class FederationTerminalNodeHandler {
  private readonly io: SocketServer;
  private readonly terminalRegistry: TerminalRegistry;
  private readonly getSession: (
    sessionId: string
  ) => { active: boolean; namespace: string } | null;

  /** terminalId → federation entry */
  private readonly fedTerminals = new Map<string, FedTermEntry>();

  /** Track which CLI sockets have federation listeners attached */
  private readonly instrumentedCliSockets = new Set<string>();

  /** ws identity → Set<terminalId> for cleanup on WS disconnect */
  private readonly terminalsByWs = new Map<
    { send(data: string): void },
    Set<string>
  >();

  constructor(deps: {
    io: SocketServer;
    terminalRegistry: TerminalRegistry;
    getSession: (
      sessionId: string
    ) => { active: boolean; namespace: string } | null;
  }) {
    this.io = deps.io;
    this.terminalRegistry = deps.terminalRegistry;
    this.getSession = deps.getSession;
  }

  /** Called when a new federation terminal WebSocket connection is opened. */
  handleOpen(ws: { send(data: string): void }): void {
    this.terminalsByWs.set(ws, new Set());
  }

  /** Called when a message arrives on the federation terminal WebSocket. */
  handleMessage(
    ws: { send(data: string): void },
    message: string | Buffer
  ): void {
    const text = typeof message === "string" ? message : message.toString();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.sendError(ws, "unknown", "Invalid JSON");
      return;
    }

    const parsed = FedTermHubMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.sendError(ws, "unknown", "Invalid message schema");
      return;
    }

    const msg = parsed.data;
    // #4517: write/resize/close act only on a terminal attached to THIS
    // WebSocket. With a stable terminal id, a WebSocket whose create was
    // refused, or one that lost the terminal to a re-attach, must not reach it.
    switch (msg.type) {
      case "create":
        this.handleCreate(ws, msg);
        break;
      case "write":
        this.handleWrite(ws, msg.terminalId, msg.data);
        break;
      case "resize":
        this.handleResize(ws, msg.terminalId, msg.cols, msg.rows);
        break;
      case "close":
        this.handleClose(ws, msg.terminalId);
        break;
    }
  }

  /** Called when the federation terminal WebSocket closes. */
  handleWsClose(ws: { send(data: string): void }): void {
    const terminalIds = this.terminalsByWs.get(ws);
    if (!terminalIds) return;

    // #4517 (R8): snapshot before iterating — cleanup/detach mutate the set.
    for (const terminalId of [...terminalIds]) {
      const fed = this.fedTerminals.get(terminalId);
      if (fed?.persistent) {
        // Detach: keep the shell alive for the browser's next re-attach.
        this.detachTerminal(terminalId);
      } else {
        // Legacy: kill the shell (emits terminal:close to the CLI).
        this.cleanupTerminal(terminalId);
      }
    }
    this.terminalsByWs.delete(ws);
  }

  private handleCreate(
    ws: { send(data: string): void },
    msg: FedTermCreateMessage
  ): void {
    const { sessionId, terminalId, cols, rows } = msg;
    const persistent = msg.persistent === true;
    const fresh = msg.fresh === true;
    const session = this.getSession(sessionId);
    // #4517: the hub asserts the browser's namespace. A session in another
    // namespace gets the same answer as a missing one (no existence leak), and
    // a create without a namespace is refused (fail closed, like the #1097
    // session-mutation receivers), so one namespace can neither open nor take
    // over another's shell.
    if (
      !session ||
      !session.active ||
      !msg.namespace ||
      session.namespace !== msg.namespace
    ) {
      this.sendError(ws, terminalId, "Session is inactive or unavailable.");
      return;
    }

    const cliNs = this.io.of("/cli");
    const cliSocketId = this.pickCliSocketId(cliNs, sessionId);
    if (!cliSocketId) {
      this.sendError(ws, terminalId, "CLI is not connected for this session.");
      return;
    }

    // The synthetic socketId is stable per terminal — it's how the CLI handlers
    // (which look up a /terminal socket by this id and find none) harmlessly
    // drop these events.
    const syntheticSocketId = `fed:${terminalId}`;

    // #4517 re-attach: a registered entry here usually means a hub WebSocket
    // is still attached. Either the hub re-sent create over the same WebSocket
    // (a take-over or a same-socket re-create), or a new WebSocket arrived
    // before the old one's close was processed. Move the entry to this
    // WebSocket and let the CLI's create() existing-path replay the snapshot.
    // (After a clean detach there is no entry, and the new-entry path below
    // re-attaches through the same CLI path.) The registry is shared with this
    // node's own browser handler, so the entry can also belong to a local
    // browser, which this rebind does not notify (#4606).
    const existing = this.terminalRegistry.get(terminalId);
    if (existing) {
      if (existing.sessionId !== sessionId || !existing.persistent) {
        this.sendError(ws, terminalId, "Terminal ID is already in use.");
        return;
      }
      this.terminalRegistry.rebind(terminalId, syntheticSocketId, cliSocketId);
      const prev = this.fedTerminals.get(terminalId);
      if (prev && prev.ws !== ws) {
        this.terminalsByWs.get(prev.ws)?.delete(terminalId);
      }
      this.fedTerminals.set(terminalId, {
        ws,
        sessionId,
        cliSocketId,
        persistent: true,
      });
      this.terminalsByWs.get(ws)?.add(terminalId);
      this.instrumentCliSocket(cliNs, cliSocketId);
      const cliSocket = cliNs.sockets.get(cliSocketId);
      if (!cliSocket) {
        this.detachTerminal(terminalId);
        this.sendError(ws, terminalId, "CLI disconnected.");
        return;
      }
      cliSocket.emit("terminal:open", {
        sessionId,
        terminalId,
        cols,
        rows,
        persistent: true,
        ...(fresh ? { fresh: true } : {}),
      });
      this.terminalRegistry.markActivity(terminalId);
      return;
    }

    // Register in TerminalRegistry with a synthetic socketId.
    // The existing CLI handlers will find this entry but fail to forward
    // because the socketId doesn't map to a real /terminal socket.
    const entry = this.terminalRegistry.register(
      terminalId,
      sessionId,
      syntheticSocketId,
      cliSocketId,
      persistent
    );
    if (!entry) {
      this.sendError(ws, terminalId, "Terminal ID is already in use.");
      return;
    }

    // Store federation routing info
    this.fedTerminals.set(terminalId, {
      ws,
      sessionId,
      cliSocketId,
      persistent,
    });
    this.terminalsByWs.get(ws)?.add(terminalId);

    // Ensure the CLI socket has federation listeners attached
    this.instrumentCliSocket(cliNs, cliSocketId);

    // Forward terminal:open to the CLI socket
    const cliSocket = cliNs.sockets.get(cliSocketId);
    if (!cliSocket) {
      this.terminalRegistry.remove(terminalId);
      this.fedTerminals.delete(terminalId);
      this.terminalsByWs.get(ws)?.delete(terminalId);
      this.sendError(ws, terminalId, "CLI disconnected.");
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
    this.terminalRegistry.markActivity(terminalId);
  }

  private handleWrite(
    ws: { send(data: string): void },
    terminalId: string,
    data: string
  ): void {
    const fed = this.fedTerminals.get(terminalId);
    if (!fed || fed.ws !== ws) return;

    const cliNs = this.io.of("/cli");
    const cliSocket = cliNs.sockets.get(fed.cliSocketId);
    if (!cliSocket) return;

    cliSocket.emit("terminal:write", {
      sessionId: fed.sessionId,
      terminalId,
      data,
    });
    this.terminalRegistry.markActivity(terminalId);
  }

  private handleResize(
    ws: { send(data: string): void },
    terminalId: string,
    cols: number,
    rows: number
  ): void {
    const fed = this.fedTerminals.get(terminalId);
    if (!fed || fed.ws !== ws) return;

    const cliNs = this.io.of("/cli");
    const cliSocket = cliNs.sockets.get(fed.cliSocketId);
    if (!cliSocket) return;

    cliSocket.emit("terminal:resize", {
      sessionId: fed.sessionId,
      terminalId,
      cols,
      rows,
    });
    this.terminalRegistry.markActivity(terminalId);
  }

  private handleClose(
    ws: { send(data: string): void },
    terminalId: string
  ): void {
    if (this.fedTerminals.get(terminalId)?.ws !== ws) return;
    this.cleanupTerminal(terminalId);
  }

  private cleanupTerminal(terminalId: string): void {
    const fed = this.fedTerminals.get(terminalId);
    if (!fed) return;

    // Remove from TerminalRegistry
    this.terminalRegistry.remove(terminalId);

    // Emit terminal:close to CLI
    const cliNs = this.io.of("/cli");
    const cliSocket = cliNs.sockets.get(fed.cliSocketId);
    cliSocket?.emit("terminal:close", {
      sessionId: fed.sessionId,
      terminalId,
    });

    // Clean up internal state
    this.fedTerminals.delete(terminalId);
    for (const [, ids] of this.terminalsByWs) {
      ids.delete(terminalId);
    }
  }

  /**
   * #4517 (R8): detach a federation terminal — drop the node-side registry +
   * routing state WITHOUT emitting terminal:close to the CLI, so the persistent
   * shell survives for the browser's next re-attach (a new hub WebSocket).
   */
  private detachTerminal(terminalId: string): void {
    const fed = this.fedTerminals.get(terminalId);
    if (!fed) return;

    this.terminalRegistry.remove(terminalId);
    this.fedTerminals.delete(terminalId);
    for (const [, ids] of this.terminalsByWs) {
      ids.delete(terminalId);
    }
    // Deliberately NO terminal:close to the CLI (that would kill the shell).
  }

  /**
   * Add federation-aware listeners to a CLI socket so that terminal events
   * for federation-proxied terminals are forwarded to the hub WebSocket.
   */
  private instrumentCliSocket(
    cliNs: ReturnType<SocketServer["of"]>,
    cliSocketId: string
  ): void {
    if (this.instrumentedCliSockets.has(cliSocketId)) return;
    this.instrumentedCliSockets.add(cliSocketId);

    const cliSocket = cliNs.sockets.get(cliSocketId);
    if (!cliSocket) return;

    // These listeners run IN ADDITION to the existing CLI terminal handlers.
    // The existing handlers will harmlessly fail for federation terminals
    // (they try to find a /terminal socket by the synthetic socketId, get null).
    // These listeners use fedTerminals map for routing.

    cliSocket.on("terminal:ready", (data: unknown) => {
      const parsed = cliTerminalReadySchema.safeParse(data);
      if (!parsed.success) return;
      const fed = this.fedTerminals.get(parsed.data.terminalId);
      if (!fed) return;
      // #4517: a CLI that did not confirm persistence (an older one) runs an
      // ephemeral shell. Treat the terminal as legacy, so a hub WebSocket
      // close kills the shell instead of orphaning it, and tell the hub.
      const persistent = parsed.data.persistent === true;
      if (!persistent) {
        fed.persistent = false;
      }
      this.sendToHub(fed.ws, {
        type: "ready",
        terminalId: parsed.data.terminalId,
        persistent,
      });
    });

    cliSocket.on("terminal:output", (data: unknown) => {
      const parsed = cliTerminalOutputSchema.safeParse(data);
      if (!parsed.success) return;
      const fed = this.fedTerminals.get(parsed.data.terminalId);
      if (!fed) return;
      this.sendToHub(fed.ws, {
        type: "output",
        terminalId: parsed.data.terminalId,
        data: parsed.data.data,
      });
    });

    cliSocket.on("terminal:exit", (data: unknown) => {
      const parsed = cliTerminalExitSchema.safeParse(data);
      if (!parsed.success) return;
      const fed = this.fedTerminals.get(parsed.data.terminalId);
      if (!fed) return;
      this.sendToHub(fed.ws, {
        type: "exit",
        terminalId: parsed.data.terminalId,
        code: parsed.data.code,
        signal: parsed.data.signal,
      });
      // Clean up — terminal exited
      this.fedTerminals.delete(parsed.data.terminalId);
      for (const [, ids] of this.terminalsByWs) {
        ids.delete(parsed.data.terminalId);
      }
    });

    cliSocket.on("terminal:error", (data: unknown) => {
      const parsed = cliTerminalErrorSchema.safeParse(data);
      if (!parsed.success) return;
      const fed = this.fedTerminals.get(parsed.data.terminalId);
      if (!fed) return;
      this.sendToHub(fed.ws, {
        type: "error",
        terminalId: parsed.data.terminalId,
        message: parsed.data.message,
      });
    });

    // Clean up if CLI socket disconnects
    cliSocket.on("disconnect", () => {
      this.instrumentedCliSockets.delete(cliSocketId);
      // Find and clean up all federation terminals for this CLI socket
      for (const [terminalId, fed] of this.fedTerminals) {
        if (fed.cliSocketId === cliSocketId) {
          this.sendToHub(fed.ws, {
            type: "error",
            terminalId,
            message: "CLI disconnected.",
          });
          this.terminalRegistry.remove(terminalId);
          this.fedTerminals.delete(terminalId);
          for (const [, ids] of this.terminalsByWs) {
            ids.delete(terminalId);
          }
        }
      }
    });
  }

  private pickCliSocketId(
    cliNs: ReturnType<SocketServer["of"]>,
    sessionId: string
  ): string | null {
    const room = cliNs.adapter.rooms.get(`session:${sessionId}`);
    if (!room || room.size === 0) return null;
    for (const socketId of room) {
      const cliSocket = cliNs.sockets.get(socketId);
      if (cliSocket) return cliSocket.id;
    }
    return null;
  }

  private sendToHub(
    ws: { send(data: string): void },
    msg: FedTermNodeMessage
  ): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // WebSocket might be closed
    }
  }

  private sendError(
    ws: { send(data: string): void },
    terminalId: string,
    message: string
  ): void {
    this.sendToHub(ws, { type: "error", terminalId, message });
  }
}
