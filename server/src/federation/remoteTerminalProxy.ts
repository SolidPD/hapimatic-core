// SPDX-License-Identifier: AGPL-3.0-only
/**
 * RemoteTerminalProxy — hub-side WebSocket client for proxying terminal I/O
 * to remote federation nodes.
 *
 * When a browser opens a terminal for a remote session, this proxy:
 * 1. Opens a WebSocket connection to the remote node
 * 2. Forwards create/write/resize/close messages to the node
 * 3. Receives ready/output/exit/error messages and calls browser callbacks
 *
 * Each remote terminal gets its own WebSocket connection (per-terminal, not
 * per-node). This keeps connection management simple and isolates failures.
 */
import {
  FedTermNodeMessageSchema,
  type FedTermHubMessage,
} from "@hapi/protocol";

type FedTermCreateMessage = Extract<FedTermHubMessage, { type: "create" }>;

type RemoteTerminalCallbacks = {
  /**
   * #4517: `persistent` is the node's acknowledgement. False means the node or
   * its CLI is older and the shell is ephemeral, so no snapshot follows.
   */
  onReady: (persistent: boolean) => void;
  onOutput: (data: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onError: (message: string) => void;
  /**
   * #4517 (R9): this browser socket lost the attachment because another socket
   * took over the same persistent remote terminal ("attached-elsewhere").
   */
  onDetached?: (reason: string) => void;
};

type RemoteTerminalEntry = {
  nodeUrl: string;
  sessionId: string;
  terminalId: string;
  ws: WebSocket;
  callbacks: RemoteTerminalCallbacks;
  /** Set to true once the WS is open and create message sent. */
  connected: boolean;
  /**
   * #4517: persistent entries can be taken over by another browser socket.
   * Cleared when the node's ready does not confirm persistence.
   */
  persistent: boolean;
  /** #4517: the browser socket that owns this terminal (one at a time). */
  ownerId: string;
  /** #4517: the owner's namespace; a take-over must come from the same one. */
  namespace: string;
  /**
   * #4517: the create to send when the WebSocket opens. A take-over before
   * the open replaces it, so the node sees the new owner's size and flags.
   */
  pendingCreate: FedTermCreateMessage;
  /**
   * #4517: a create was sent and its ready has not arrived. An error in this
   * window means the node refused the create, so the entry is dropped rather
   * than left holding the terminal id.
   */
  awaitingReady: boolean;
};

const CONNECT_TIMEOUT_MS = 10_000;

export class RemoteTerminalProxy {
  private readonly apiToken: string | null;

  /** terminalId → active remote terminal connection */
  private readonly terminals = new Map<string, RemoteTerminalEntry>();

  constructor(apiToken: string | null) {
    this.apiToken = apiToken;
  }

  /** Check if a terminal is being proxied through federation. */
  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * #4517: whether `ownerId` (a browser socket id) currently owns the remote
   * terminal. Input, resize and close are honoured only for the owner, so a
   * socket whose create was refused, whose WebSocket dropped, or which was
   * taken over cannot reach a terminal that now belongs to someone else.
   */
  isOwnedBy(terminalId: string, ownerId: string): boolean {
    return this.terminals.get(terminalId)?.ownerId === ownerId;
  }

  /** Create a remote terminal on a federation node. */
  create(opts: {
    nodeUrl: string;
    sessionId: string;
    terminalId: string;
    cols: number;
    rows: number;
    persistent?: boolean;
    fresh?: boolean;
    ownerId: string;
    namespace: string;
    callbacks: RemoteTerminalCallbacks;
  }): void {
    const existing = this.terminals.get(opts.terminalId);
    if (existing) {
      // #4517: another namespace gets the answer the node and the local path
      // give a session it cannot see, so the reply does not reveal that the
      // shell exists or is open.
      if (existing.namespace !== opts.namespace) {
        opts.callbacks.onError("Session is inactive or unavailable.");
        return;
      }
      // Only the same persistent shell can be taken over — same session, same
      // node. Any other match on the id is a collision; refusing it here keeps
      // the shell's output from reaching the caller before the node could
      // refuse the create.
      if (
        opts.persistent &&
        existing.persistent &&
        existing.sessionId === opts.sessionId &&
        existing.nodeUrl === opts.nodeUrl
      ) {
        this.takeOver(existing, opts);
        return;
      }
      opts.callbacks.onError("Terminal ID already in use.");
      return;
    }

    const { url: wsUrl, protocols } = this.buildWsUrl(opts.nodeUrl);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, protocols);
    } catch {
      opts.callbacks.onError("Failed to connect to remote node.");
      return;
    }

    const entry: RemoteTerminalEntry = {
      nodeUrl: opts.nodeUrl,
      sessionId: opts.sessionId,
      terminalId: opts.terminalId,
      ws,
      callbacks: opts.callbacks,
      connected: false,
      persistent: opts.persistent === true,
      ownerId: opts.ownerId,
      namespace: opts.namespace,
      pendingCreate: this.buildCreate(opts),
      awaitingReady: false,
    };

    this.terminals.set(opts.terminalId, entry);

    // #4517: every handler below acts only while THIS entry is the one mapped
    // to the id. After a detach and a quick re-create, the old WebSocket's
    // late close or error must not report to, or delete, the new entry.
    const isCurrent = () => this.terminals.get(opts.terminalId) === entry;

    // Connection timeout — if WS doesn't open within the limit, abort. The
    // error goes to the current owner, which a take-over may have changed.
    const connectTimer = setTimeout(() => {
      if (!entry.connected && isCurrent()) {
        entry.callbacks.onError("Connection to remote node timed out.");
        this.cleanupTerminal(opts.terminalId);
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimer);
      if (!isCurrent()) {
        return;
      }
      entry.connected = true;
      entry.awaitingReady = true;
      this.sendToNode(ws, entry.pendingCreate);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!isCurrent()) {
        return;
      }
      const raw =
        typeof event.data === "string" ? event.data : String(event.data);
      this.handleNodeMessage(entry, raw);
    };

    ws.onerror = () => {
      clearTimeout(connectTimer);
      if (isCurrent()) {
        entry.callbacks.onError("Connection to remote node failed.");
        this.cleanupTerminal(opts.terminalId);
      }
    };

    ws.onclose = () => {
      clearTimeout(connectTimer);
      // Only report error if we didn't already clean up (e.g. from exit)
      if (isCurrent()) {
        entry.callbacks.onError("Remote node disconnected.");
        this.terminals.delete(opts.terminalId);
      }
    };
  }

  /** Write data to a remote terminal. */
  write(terminalId: string, data: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry || !entry.connected) return;

    this.sendToNode(entry.ws, {
      type: "write",
      terminalId,
      data,
    });
  }

  /** Resize a remote terminal. */
  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.terminals.get(terminalId);
    if (!entry || !entry.connected) return;

    this.sendToNode(entry.ws, {
      type: "resize",
      terminalId,
      cols,
      rows,
    });
  }

  /** Close a remote terminal and clean up. */
  close(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;

    if (entry.connected) {
      this.sendToNode(entry.ws, {
        type: "close",
        terminalId,
      });
    }

    this.cleanupTerminal(terminalId);
  }

  /**
   * #4517 (R8): detach a remote terminal — tear down the hub→node WebSocket
   * WITHOUT sending `close`, so the node treats the WS close as a detach and
   * keeps the persistent shell alive for the browser's next re-attach. The
   * WebSocket's close handler then finds its entry is no longer the current one
   * for the id (cleanupTerminal deleted it) and fires nothing — even if a new
   * entry with the same stable id exists by then.
   */
  detach(terminalId: string): void {
    this.cleanupTerminal(terminalId);
  }

  /**
   * #4517: a browser socket went away. Release only the terminals it still
   * owns: detach persistent ones (the node keeps the shell) and close legacy
   * ones. A terminal another socket took over is left alone.
   */
  releaseOwner(ownerId: string): void {
    for (const [id, entry] of [...this.terminals]) {
      if (entry.ownerId === ownerId) {
        this.release(id, entry);
      }
    }
  }

  /**
   * Shut down all remote terminal connections. #4517: persistent terminals
   * are detached, not closed, so a hub restart leaves the remote shells alive.
   */
  stop(): void {
    for (const [id, entry] of [...this.terminals]) {
      this.release(id, entry);
    }
  }

  /** #4517: detach a persistent terminal, close a legacy one. */
  private release(terminalId: string, entry: RemoteTerminalEntry): void {
    if (entry.persistent) {
      this.detach(terminalId);
    } else {
      this.close(terminalId);
    }
  }

  /**
   * #4517 (R9, D-4517-1 = A): a second browser socket attached to a persistent
   * remote terminal this hub is already proxying. The terminal id is stable per
   * session (`${sessionId}:shell`), so this is the same shell: keep the existing
   * hub→node WebSocket, hand its callbacks to the new socket, tell the previous
   * socket it was detached, and re-send `create` so the node re-attaches and
   * replays the snapshot to the new owner. Before #4517 every mount used a fresh
   * random id, so this case never arose; rejecting it would turn "open on a
   * second device" into an error for federated sessions. A re-create from the
   * socket that already owns the terminal is not a take-over: it keeps the
   * attachment and gets no detach notice.
   */
  private takeOver(
    entry: RemoteTerminalEntry,
    opts: {
      sessionId: string;
      terminalId: string;
      cols: number;
      rows: number;
      persistent?: boolean;
      fresh?: boolean;
      ownerId: string;
      namespace: string;
      callbacks: RemoteTerminalCallbacks;
    }
  ): void {
    const previous = entry.callbacks;
    const previousOwnerId = entry.ownerId;
    entry.callbacks = opts.callbacks;
    entry.ownerId = opts.ownerId;
    entry.pendingCreate = this.buildCreate(opts);
    if (previousOwnerId !== opts.ownerId) {
      previous.onDetached?.("attached-elsewhere");
    }
    if (entry.connected) {
      entry.awaitingReady = true;
      this.sendToNode(entry.ws, entry.pendingCreate);
    }
    // Not yet connected: ws.onopen sends pendingCreate, and the node's replies
    // reach the new owner through the swapped callbacks.
  }

  private buildCreate(opts: {
    sessionId: string;
    terminalId: string;
    cols: number;
    rows: number;
    persistent?: boolean;
    fresh?: boolean;
    namespace: string;
  }): FedTermCreateMessage {
    return {
      type: "create",
      sessionId: opts.sessionId,
      terminalId: opts.terminalId,
      cols: opts.cols,
      rows: opts.rows,
      persistent: opts.persistent,
      namespace: opts.namespace,
      ...(opts.fresh ? { fresh: true } : {}),
    };
  }

  private handleNodeMessage(entry: RemoteTerminalEntry, raw: string): void {
    const { terminalId } = entry;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }

    const parsed = FedTermNodeMessageSchema.safeParse(json);
    if (!parsed.success) return;

    const msg = parsed.data;

    // Only process messages for this terminal
    if (msg.terminalId !== terminalId) return;

    switch (msg.type) {
      case "ready":
        entry.awaitingReady = false;
        // #4517: an older node or CLI ignores `persistent` and spawns an
        // ephemeral shell. Treat the terminal as legacy from here on, so a
        // browser disconnect closes the shell instead of orphaning it.
        if (msg.persistent !== true) {
          entry.persistent = false;
        }
        entry.callbacks.onReady(entry.persistent);
        break;
      case "output":
        entry.callbacks.onOutput(msg.data);
        break;
      case "exit":
        entry.callbacks.onExit(msg.code, msg.signal);
        this.cleanupTerminal(terminalId);
        break;
      case "error":
        entry.callbacks.onError(msg.message);
        // #4517: an error answering a create is the node refusing it, so drop
        // the entry instead of leaving it holding the id. A take-over re-create
        // that is refused only detaches here: the node keeps the shell.
        if (entry.awaitingReady) {
          this.cleanupTerminal(terminalId);
        }
        break;
    }
  }

  private cleanupTerminal(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) return;

    this.terminals.delete(terminalId);

    if (
      entry.ws.readyState === WebSocket.OPEN ||
      entry.ws.readyState === WebSocket.CONNECTING
    ) {
      entry.ws.close();
    }
  }

  private sendToNode(ws: WebSocket, msg: FedTermHubMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  /**
   * Convert a node HTTP URL to a federation terminal WebSocket URL.
   * e.g. http://rp2:3010 → ws://rp2:3010/api/federation/terminal
   *
   * Auth token is passed via the Sec-WebSocket-Protocol header (as a
   * subprotocol) instead of a URL query param to avoid leaking the
   * token in access logs and proxy logs.
   */
  private buildWsUrl(nodeUrl: string): {
    url: string;
    protocols: string[] | undefined;
  } {
    const url = new URL(nodeUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/federation/terminal";

    // Carry token as a Sec-WebSocket-Protocol subprotocol.
    // Server extracts the token from the "hapi-fed-auth.<token>" protocol.
    const protocols = this.apiToken
      ? ["hapi-fed-v1", `hapi-fed-auth.${this.apiToken}`]
      : undefined;

    return { url: url.toString(), protocols };
  }
}
