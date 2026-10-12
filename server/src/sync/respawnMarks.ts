// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Pre-kill respawn marks (issue #3478; plan from #4597, ruling D-4597-1 = A).
 *
 * A server-initiated respawn (switchAccount, tokenRefreshRestart, the config /
 * model-mode restart, relaunchSession) kills the session's CLI and immediately
 * respawns it under the same id. (Heartbeat rotation archives the same way but
 * replaces the session with a new id; its old loops are then paused by the
 * grace archive below.) That kill produces TWO session ends: the
 * archive's own end, flagged `respawn: true`, and the dying CLI's `session-end`,
 * which carries no flag. The Claude/codex CLI emits its end BEFORE it acks the
 * kill RPC, so the unflagged end usually arrives first — a window keyed on the
 * archive cannot exist yet when it lands. Hence a mark set just BEFORE the kill:
 * `SyncEngine.handleSessionEnd` treats the next unflagged CLI end for a marked
 * session as part of the respawn, so the loop-cron coupler does not pause the
 * session's loops for a process that is about to come straight back.
 *
 * - **Consumed once.** Only the end the kill itself produces is exempt; any
 *   later end (a genuine death of the respawned process) pauses as usual. When
 *   the kill finds the old CLI already gone, no end consumes the mark, so the
 *   respawned process's first heartbeat drops it (`handleSessionAlive`).
 * - **TTL.** A mark older than `RESPAWN_MARK_TTL_MS` exempts nothing. Expired
 *   marks are dropped on the next `mark`/`consume` (no timers).
 * - **Backstop.** A respawn whose new process never comes back is still paused:
 *   the old CLI's socket disconnect starts the 30 s CLI-disconnect grace archive
 *   (`socket/handlers/cli/index.ts`), a terminal archive that never consumes.
 *
 * In-memory and best-effort, like the coupler ledger: a server restart loses
 * the marks, which only costs a pause the rising-edge resume then heals.
 */

/** How long a pre-kill mark exempts the dying CLI's end. */
export const RESPAWN_MARK_TTL_MS = 60_000;

export class RespawnMarks {
  /** `sessionId → when the respawn marked it`. */
  private readonly marks = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: { now?: () => number; ttlMs?: number } = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? RESPAWN_MARK_TTL_MS;
  }

  /** Mark a session whose CLI is about to be killed for a respawn. */
  mark(sessionId: string): void {
    this.prune();
    this.marks.set(sessionId, this.now());
  }

  /**
   * True when the session carries a live mark, which is then cleared: the
   * caller's end is the one the respawn's kill produced.
   */
  consume(sessionId: string): boolean {
    this.prune();
    return this.marks.delete(sessionId);
  }

  private prune(): void {
    const now = this.now();
    for (const [sessionId, markedAt] of this.marks) {
      if (now - markedAt > this.ttlMs) this.marks.delete(sessionId);
    }
  }
}
