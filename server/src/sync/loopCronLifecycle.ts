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
 *  - **Ledger-driven resume, never blanket** (R6). `config.json` carries a
 *    `paused_by` process chain (rp1-home#1743), but a coupler pause and an
 *    operator pause from the web System Jobs page both run loop-cron.sh from
 *    this server process, so the state files cannot tell them apart. The
 *    in-memory ledger records exactly which ids WE paused for each session;
 *    resume touches only those. An operator-paused loop is never auto-resumed,
 *    and a loop we did NOT pause is never touched.
 *  - **Terminal-gated pause** (R6). The pause fires from `handleSessionEnd`
 *    (the true session-end choke point — an unexpected death reaches it without
 *    `archiveSession`). A same-id respawn (switchAccount / tokenRefreshRestart /
 *    config or model-mode restart / relaunchSession) does NOT pause: its
 *    archive's end is flagged, and the dying CLI's own unflagged end is matched
 *    to the respawn by a pre-kill mark (#3478, `respawnMarks.ts`). Heartbeat
 *    rotation archives the same way but replaces the session with a NEW id, so
 *    the old session's loops are paused by its 30 s CLI-disconnect grace archive.
 *  - **Resume on any return** (#3478). Resume fires on `reconnectSession`
 *    success, on the session's inactive→active edge (the first heartbeat after
 *    an end), and when the force-kill watchdog finds a "dead" session alive, so
 *    a loop paused for a session that then comes back — by a daemon
 *    reconnect-respawn, RecoveryService, or a revival — never stays paused. A
 *    session that never comes back keeps its loops paused, and a session that
 *    ends again mid-resume gets the not-yet-resumed loops back in its ledger.
 *  - **Double-fire safe.** The ledger's own presence guards the pause: once a
 *    session's loops are ledgered, a second terminal `handleSessionEnd` (e.g.
 *    archive + the CLI end event) is a no-op.
 *  - **Ordered per loop** (#3478). loop-cron.sh serialises config writes only
 *    on a non-FIFO `flock -w 20`, and one call can run up to the controller's
 *    30 s timeout (the 2026-09-25 incident logged ~37 s with queueing). The
 *    coupler's own pause/resume for a loop runs strictly in call order, so its
 *    resume cannot overtake its in-flight pause. Operator actions from the web
 *    System Jobs page are NOT ordered against these, and an operator who
 *    re-pauses an auto-paused loop is overridden by the next auto-resume (the
 *    ledger cannot see that pause).
 *  - **The ledger does not survive a server restart**: a loop auto-paused
 *    before a restart is not auto-resumed after it (#4477 / rp1-home#2503).
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

/** One session's auto-pause record. */
interface LedgerEntry {
  /** Every id this end set out to pause. */
  ids: string[];
  pausedAtMs: number;
  /**
   * #3478: the ids whose pause was actually issued — the only loops a resume
   * may touch. Shorter than `ids` when a resume cut the pausing short.
   */
  issued: string[];
}

export class LoopCronLifecycleCoupler {
  /** `sessionId → { ids we auto-paused, when }`. In-memory; a crash loses it. */
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly now: () => number;
  /** `loopId → its last queued pause/resume` (see `serialize`). */
  private readonly opChains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: LoopCronLifecycleCouplerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * A session ended. Terminal ends (default) pause the session's not-already
   * paused loops and ledger them; respawn ends skip entirely. Idempotent via
   * the ledger. Never throws.
   */
  async onSessionEnd(sessionId: string, isRespawn: boolean): Promise<void> {
    if (isRespawn) return;
    if (this.ledger.has(sessionId)) return; // already handled — double-fire guard
    const host = this.deps.getHost();
    if (!host) return;
    try {
      const loops = host.loopsBoundToSession(sessionId);
      // #3478: a loop with a pause/resume of ours still queued reads as paused
      // on disk, but a queued resume (from the session's previous return) is
      // about to un-pause it — so pause it too, queued behind that resume.
      const toPause = loops.filter(
        l => l.hasCrontabLine && (!l.paused || this.opChains.has(l.id))
      );
      if (toPause.length === 0) return;
      // Ledger BEFORE pausing so a crash mid-pause still reflects intent.
      const entry: LedgerEntry = {
        ids: toPause.map(l => l.id),
        pausedAtMs: this.now(),
        issued: [],
      };
      this.ledger.set(sessionId, entry);
      for (const l of toPause) {
        // #3478: a resume consumed this entry while an earlier pause was in
        // flight; it resumes only the pauses already issued, so stop here and
        // leave the rest untouched rather than strand them paused.
        if (this.ledger.get(sessionId) !== entry) break;
        entry.issued.push(l.id);
        try {
          await this.serialize(l.id, () => host.loopCronPause(l.id));
        } catch (err) {
          this.warn(`auto-pause failed for loop ${l.id}`, err, sessionId);
        }
      }
    } catch (err) {
      this.warn("auto-pause hook failed", err, sessionId);
    }
  }

  /**
   * A session came back (reconnect or the inactive→active edge). Resumes ONLY
   * the loops we auto-paused (the ledger entry's issued pauses), then emits the
   * R6 resume signal. Never throws.
   */
  async onReconnect(sessionId: string): Promise<void> {
    const entry = this.ledger.get(sessionId);
    if (!entry) return;
    this.ledger.delete(sessionId);
    const host = this.deps.getHost();
    if (!host) return;
    const toResume = [...entry.issued];
    let resumed = 0;
    let superseded = false;
    for (let i = 0; i < toResume.length; i++) {
      // #3478: the session ended again while we were resuming. The loops not
      // yet resumed are still paused, so hand them to that newer entry (the
      // next return resumes them) and stop, instead of un-pausing them for a
      // session that is gone.
      const newer = this.ledger.get(sessionId);
      if (newer) {
        for (const id of toResume.slice(i)) {
          if (!newer.ids.includes(id)) newer.ids.push(id);
          if (!newer.issued.includes(id)) newer.issued.push(id);
        }
        superseded = true;
        break;
      }
      const id = toResume[i];
      try {
        await this.serialize(id, () => host.loopCronResume(id));
        resumed += 1;
      } catch (err) {
        this.warn(`auto-resume failed for loop ${id}`, err, sessionId);
      }
    }
    // An end during the LAST resume never reaches the check above.
    superseded ||= this.ledger.has(sessionId);
    if (resumed > 0 && !superseded) {
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

  /**
   * #3478: run one loop's pause/resume after every earlier one queued for the
   * same loop has settled (fulfilled or rejected), so they reach loop-cron.sh in
   * call order. Different loops never wait on each other. An entry stays in
   * `opChains` only while an operation for that loop is queued or running.
   */
  private serialize(
    loopId: string,
    op: () => Promise<unknown>
  ): Promise<unknown> {
    const prev = this.opChains.get(loopId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.opChains.set(loopId, next);
    const release = () => {
      if (this.opChains.get(loopId) === next) this.opChains.delete(loopId);
    };
    next.then(release, release);
    return next;
  }

  /** Test/introspection aid — the ledger entry for a session, if any. */
  peekLedger(sessionId: string): { ids: string[]; pausedAtMs: number } | null {
    const entry = this.ledger.get(sessionId);
    return entry ? { ids: entry.ids, pausedAtMs: entry.pausedAtMs } : null;
  }

  private warn(msg: string, err: unknown, sessionId: string): void {
    this.deps.errorLogger?.warn(
      `[loop-cron lifecycle] ${msg}: ${err instanceof Error ? err.message : String(err)}`,
      { category: "sync", sessionId }
    );
  }
}
