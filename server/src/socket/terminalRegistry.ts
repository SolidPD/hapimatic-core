// SPDX-License-Identifier: AGPL-3.0-only
export type TerminalRegistryEntry = {
  terminalId: string;
  sessionId: string;
  socketId: string;
  cliSocketId: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
  // #4517: persistent entries never get an idle timer and detach (rather than
  // close) when the browser socket disconnects.
  persistent: boolean;
};

type TerminalRegistryOptions = {
  idleTimeoutMs: number;
  onIdle?: (entry: TerminalRegistryEntry) => void;
};

export class TerminalRegistry {
  private readonly terminals = new Map<string, TerminalRegistryEntry>();
  private readonly terminalsBySocket = new Map<string, Set<string>>();
  private readonly terminalsBySession = new Map<string, Set<string>>();
  private readonly terminalsByCliSocket = new Map<string, Set<string>>();
  private readonly idleTimeoutMs: number;
  private readonly onIdle?: (entry: TerminalRegistryEntry) => void;

  constructor(options: TerminalRegistryOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.onIdle = options.onIdle;
  }

  register(
    terminalId: string,
    sessionId: string,
    socketId: string,
    cliSocketId: string,
    persistent = false
  ): TerminalRegistryEntry | null {
    if (this.terminals.has(terminalId)) {
      return null;
    }

    const entry: TerminalRegistryEntry = {
      terminalId,
      sessionId,
      socketId,
      cliSocketId,
      idleTimer: null,
      persistent,
    };

    this.terminals.set(terminalId, entry);
    this.addToIndex(this.terminalsBySocket, socketId, terminalId);
    this.addToIndex(this.terminalsBySession, sessionId, terminalId);
    this.addToIndex(this.terminalsByCliSocket, cliSocketId, terminalId);
    this.scheduleIdle(entry);

    return entry;
  }

  /**
   * #4517: move an existing entry to a new browser socket (and refresh its CLI
   * socket, which may have reconnected) — the take-over / re-attach primitive.
   * Returns the PREVIOUS browser socketId so the caller can notify that socket
   * it was detached (`attached-elsewhere`). Returns null if the entry is gone.
   */
  rebind(
    terminalId: string,
    newSocketId: string,
    newCliSocketId: string
  ): string | null {
    const entry = this.terminals.get(terminalId);
    if (!entry) {
      return null;
    }
    const prevSocketId = entry.socketId;
    if (entry.socketId !== newSocketId) {
      this.removeFromIndex(this.terminalsBySocket, entry.socketId, terminalId);
      this.addToIndex(this.terminalsBySocket, newSocketId, terminalId);
      entry.socketId = newSocketId;
    }
    if (entry.cliSocketId !== newCliSocketId) {
      this.removeFromIndex(
        this.terminalsByCliSocket,
        entry.cliSocketId,
        terminalId
      );
      this.addToIndex(this.terminalsByCliSocket, newCliSocketId, terminalId);
      entry.cliSocketId = newCliSocketId;
    }
    return prevSocketId;
  }

  /**
   * #4517: the CLI answered a persistent create without confirming persistence
   * (an older CLI ignores the flag and runs an ephemeral shell). Treat the
   * entry as legacy from now on: a browser disconnect closes the shell instead
   * of orphaning it, and the idle timer applies again.
   */
  downgradeToLegacy(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry || !entry.persistent) {
      return;
    }
    entry.persistent = false;
    this.scheduleIdle(entry);
  }

  markActivity(terminalId: string): void {
    const entry = this.terminals.get(terminalId);
    if (!entry) {
      return;
    }
    this.scheduleIdle(entry);
  }

  get(terminalId: string): TerminalRegistryEntry | null {
    return this.terminals.get(terminalId) ?? null;
  }

  remove(terminalId: string): TerminalRegistryEntry | null {
    const entry = this.terminals.get(terminalId);
    if (!entry) {
      return null;
    }

    this.terminals.delete(terminalId);
    this.removeFromIndex(this.terminalsBySocket, entry.socketId, terminalId);
    this.removeFromIndex(this.terminalsBySession, entry.sessionId, terminalId);
    this.removeFromIndex(
      this.terminalsByCliSocket,
      entry.cliSocketId,
      terminalId
    );
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    return entry;
  }

  removeBySocket(socketId: string): TerminalRegistryEntry[] {
    const ids = this.terminalsBySocket.get(socketId);
    if (!ids || ids.size === 0) {
      return [];
    }
    return Array.from(ids)
      .map(terminalId => this.remove(terminalId))
      .filter(Boolean) as TerminalRegistryEntry[];
  }

  removeByCliSocket(socketId: string): TerminalRegistryEntry[] {
    const ids = this.terminalsByCliSocket.get(socketId);
    if (!ids || ids.size === 0) {
      return [];
    }
    return Array.from(ids)
      .map(terminalId => this.remove(terminalId))
      .filter(Boolean) as TerminalRegistryEntry[];
  }

  countForSocket(socketId: string): number {
    return this.terminalsBySocket.get(socketId)?.size ?? 0;
  }

  countForSession(sessionId: string): number {
    return this.terminalsBySession.get(sessionId)?.size ?? 0;
  }

  private scheduleIdle(entry: TerminalRegistryEntry): void {
    // #4517 (R7): persistent terminals are never killed for inactivity.
    if (entry.persistent) {
      return;
    }
    if (this.idleTimeoutMs <= 0) {
      return;
    }

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
    }

    entry.idleTimer = setTimeout(() => {
      const current = this.terminals.get(entry.terminalId);
      if (!current) {
        return;
      }
      this.onIdle?.(current);
      this.remove(entry.terminalId);
    }, this.idleTimeoutMs);
  }

  private addToIndex(
    index: Map<string, Set<string>>,
    key: string,
    terminalId: string
  ): void {
    const set = index.get(key);
    if (set) {
      set.add(terminalId);
    } else {
      index.set(key, new Set([terminalId]));
    }
  }

  private removeFromIndex(
    index: Map<string, Set<string>>,
    key: string,
    terminalId: string
  ): void {
    const set = index.get(key);
    if (!set) {
      return;
    }
    set.delete(terminalId);
    if (set.size === 0) {
      index.delete(key);
    }
  }
}
