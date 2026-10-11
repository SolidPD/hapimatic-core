// SPDX-License-Identifier: AGPL-3.0-only
export type ClaudePtyRegistryEntry = {
  sessionId: string;
  cliSocketId: string;
};

export class ClaudePtyRegistry {
  private readonly bySession = new Map<string, ClaudePtyRegistryEntry>();
  private readonly byCliSocket = new Map<string, Set<string>>();

  register(sessionId: string, cliSocketId: string): void {
    const existing = this.bySession.get(sessionId);
    if (existing && existing.cliSocketId !== cliSocketId) {
      this.removeFromCliIndex(existing.cliSocketId, sessionId);
    }
    this.bySession.set(sessionId, { sessionId, cliSocketId });
    this.addToCliIndex(cliSocketId, sessionId);
  }

  get(sessionId: string): ClaudePtyRegistryEntry | null {
    return this.bySession.get(sessionId) ?? null;
  }

  removeBySession(sessionId: string): ClaudePtyRegistryEntry | null {
    const entry = this.bySession.get(sessionId);
    if (!entry) {
      return null;
    }
    this.bySession.delete(sessionId);
    this.removeFromCliIndex(entry.cliSocketId, sessionId);
    return entry;
  }

  removeByCliSocket(cliSocketId: string): ClaudePtyRegistryEntry[] {
    const sessions = this.byCliSocket.get(cliSocketId);
    if (!sessions || sessions.size === 0) {
      return [];
    }
    const removed: ClaudePtyRegistryEntry[] = [];
    for (const sessionId of Array.from(sessions)) {
      const entry = this.bySession.get(sessionId);
      if (entry && entry.cliSocketId === cliSocketId) {
        this.bySession.delete(sessionId);
        removed.push(entry);
      }
    }
    this.byCliSocket.delete(cliSocketId);
    return removed;
  }

  private addToCliIndex(cliSocketId: string, sessionId: string): void {
    const set = this.byCliSocket.get(cliSocketId);
    if (set) {
      set.add(sessionId);
    } else {
      this.byCliSocket.set(cliSocketId, new Set([sessionId]));
    }
  }

  private removeFromCliIndex(cliSocketId: string, sessionId: string): void {
    const set = this.byCliSocket.get(cliSocketId);
    if (!set) return;
    set.delete(sessionId);
    if (set.size === 0) {
      this.byCliSocket.delete(cliSocketId);
    }
  }
}
