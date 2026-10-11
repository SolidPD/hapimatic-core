// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorLogger } from "../logging/errorLogger";

/**
 * loop-cron ↔ session lifecycle coupling (issue #2453, Task 7).
 *
 * Auto-pauses a session's bound loops when the session terminally ends,
 * auto-resumes ONLY the loops it auto-paused when the session reconnects, and
 * purges the bound loops when the session is deleted. Every hook is best-effort
 * — a failure here must NEVER break the session lifecycle op it rides on.
 *
 * Correctness properties:
 *  - **Ledger-driven resume, never blanket** (R6). `config.json` has no pause
 *    attribution (loop-cron.sh writes a hard-coded "paused by operator" to
 *    tick.log), so an operator-paused loop is indistinguishable in the state
 *    files. The in-memory ledger records exactly which ids WE paused for each
 *    session; resume touches only those. An operator-paused loop is never
 *    auto-resumed, and a loop we did NOT pause is never touched.
 *  - **Terminal-gated pause** (R6). The pause fires from `handleSessionEnd`
 *    (the true session-end choke point — an unexpected death reaches it without
 *    `archiveSession`). Respawn-archives (switchAccount / tokenRefreshRestart /
 *    heartbeat-rotation / modelModeRestart) pass `isRespawn` so they DON'T pause
 *    a session that immediately respawns under the same uuid — the "resume looks
 *    dead" class this feature removes.
 *  - **Double-fire safe.** The ledger's own presence guards the pause: once a
 *    session's loops are ledgered, a second `handleSessionEnd` (e.g. archive +
 *    the CLI end event) is a no-op.
 *  - **Orphans are NOT auto-cleaned here** — a loop whose bound session is gone
 *    surfaces as the red orphaned card with a manual Delete (the immortal-loop
 *    class). Only an explicit session DELETE purges.
 */

/** The narrow slice of `SystemJobsService` the coupler needs. */
export interface LoopCronLifecycleHost {
  loopsBoundToSession(sessionId: string): Array<{
    id: string;
    paused: boolean;
    hasCrontabLine: boolean;
  }>;
  loopCronPause(id: string): Promise<unknown>;
  loopCronResume(id: string): Promise<unknown>;
  loopCronDelete(id: string): Promise<unknown>;
}

export interface LoopCronResumeSignal {
  sessionId: string;
  count: number;
  /** When these loops were auto-paused (the R6 toast's "paused on disconnect"). */
  pausedAtMs: number;
}

export interface LoopCronLifecycleCouplerDeps {
  /** Late-bound host — the per-node SystemJobsService (constructed post-SyncEngine). */
  getHost: () => LoopCronLifecycleHost | null;
  /** Injectable clock (test seam). */
  now?: () => number;
  /** Emits the R6 resume signal (wired to the SSE event in Task 14). */
  emitResumeSignal?: (signal: LoopCronResumeSignal) => void;
  errorLogger?: ErrorLogger | null;
}

export class LoopCronLifecycleCoupler {
  /** `sessionId → { ids we auto-paused, when }`. In-memory; a crash loses it. */
  private readonly ledger = new Map<
    string,
    { ids: string[]; pausedAtMs: number }
  >();
  private readonly now: () => number;

  constructor(private readonly deps: LoopCronLifecycleCouplerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * A session ended. Terminal ends (default) pause the session's not-already
   * paused loops and ledger them; respawn-archives skip entirely. Idempotent via
   * the ledger. Never throws.
   */
  async onSessionEnd(sessionId: string, isRespawn: boolean): Promise<void> {
    if (isRespawn) return;
    if (this.ledger.has(sessionId)) return; // already handled — double-fire guard
    const host = this.deps.getHost();
    if (!host) return;
    try {
      const loops = host.loopsBoundToSession(sessionId);
      const toPause = loops.filter(l => l.hasCrontabLine && !l.paused);
      if (toPause.length === 0) return;
      // Ledger BEFORE pausing so a crash mid-pause still reflects intent.
      this.ledger.set(sessionId, {
        ids: toPause.map(l => l.id),
        pausedAtMs: this.now(),
      });
      for (const l of toPause) {
        try {
          await host.loopCronPause(l.id);
        } catch (err) {
          this.warn(`auto-pause failed for loop ${l.id}`, err, sessionId);
        }
      }
    } catch (err) {
      this.warn("auto-pause hook failed", err, sessionId);
    }
  }

  /**
   * A session reconnected. Resumes ONLY the loops we auto-paused (the ledger
   * entry), then emits the R6 resume signal. Never throws.
   */
  async onReconnect(sessionId: string): Promise<void> {
    const entry = this.ledger.get(sessionId);
    if (!entry) return;
    this.ledger.delete(sessionId);
    const host = this.deps.getHost();
    if (!host) return;
    let resumed = 0;
    for (const id of entry.ids) {
      try {
        await host.loopCronResume(id);
        resumed += 1;
      } catch (err) {
        this.warn(`auto-resume failed for loop ${id}`, err, sessionId);
      }
    }
    if (resumed > 0) {
      try {
        this.deps.emitResumeSignal?.({
          sessionId,
          count: resumed,
          pausedAtMs: entry.pausedAtMs,
        });
      } catch (err) {
        this.warn("resume-signal emit failed", err, sessionId);
      }
    }
  }

  /**
   * A session was deleted. Purges ALL its bound loops (the session is gone —
   * every bound loop is now an orphan) and clears any pending ledger entry.
   * Never throws.
   */
  async onDelete(sessionId: string): Promise<void> {
    this.ledger.delete(sessionId);
    const host = this.deps.getHost();
    if (!host) return;
    try {
      const loops = host.loopsBoundToSession(sessionId);
      for (const l of loops) {
        try {
          await host.loopCronDelete(l.id);
        } catch (err) {
          this.warn(`auto-purge failed for loop ${l.id}`, err, sessionId);
        }
      }
    } catch (err) {
      this.warn("auto-purge hook failed", err, sessionId);
    }
  }

  /** Test/introspection aid — the ledger entry for a session, if any. */
  peekLedger(sessionId: string): { ids: string[]; pausedAtMs: number } | null {
    return this.ledger.get(sessionId) ?? null;
  }

  private warn(msg: string, err: unknown, sessionId: string): void {
    this.deps.errorLogger?.warn(
      `[loop-cron lifecycle] ${msg}: ${err instanceof Error ? err.message : String(err)}`,
      { category: "sync", sessionId }
    );
  }
}
