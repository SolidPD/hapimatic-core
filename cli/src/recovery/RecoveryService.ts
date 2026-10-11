// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Recovery Service
 *
 * Handles recovery of Claude sessions after Hapimatic restarts.
 * On startup, checks for persisted sessions and validates they
 * still exist in tmux with running processes.
 */

import fs from "fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

import { logger } from "@/ui/logger";
import { TmuxManager } from "@/tmux";
import {
  describeOwnershipFailure,
  resolveOwnedWindow,
} from "@/tmux/windowOwnership";
import { createSessionStore } from "@/sessionPersistence";
import type { PersistedSession, SessionStatus } from "@/sessionPersistence";
import { syncConfigFromMain } from "@/daemon/worktree";
import { readClaimedPort } from "@/daemon/worktreeMeta";
import type {
  RecoveryStatus,
  RecoveryResult,
  RecoveryError,
  RecoveryServiceOptions,
} from "./types";

const execFileAsync = promisify(execFile);

/**
 * Issue #1328: Determine whether a session's cwd is a hapimatic-private
 * working tree. Used to scope the resume-time `.claude/` re-sync gate so the
 * daemon does NOT issue `git fetch` against unrelated repos' origins (rp1-home,
 * rp1-home worktrees, etc.) on every recovery cycle.
 *
 * Cheap path: Hapimatic-spawned worktrees carry `.worktree-meta.json`. The
 * presence of a parseable meta-file with a claimed_port implies the worktree
 * was created by Hapimatic, which by current construction only spawns
 * hapimatic-private worktrees.
 *
 * Fallback path: query the cwd's `origin` remote URL. Covers manual
 * `git worktree add` worktrees AND the base clones (which lack a meta-file
 * but have the right origin).
 *
 * Fail-closed: any error returns false. The caller logs at debug level and
 * skips the re-sync.
 */
export async function isHapimaticPrivateCwd(cwd: string): Promise<boolean> {
  if ((await readClaimedPort(cwd)) !== null) {
    return true;
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      { cwd, timeout: 5000 }
    );
    return stdout.includes("MattStarfield/hapimatic-private");
  } catch {
    return false;
  }
}

export class RecoveryService {
  private readonly hapiHome: string;
  private readonly tmuxSessionName: string;
  private readonly autoRecover: boolean;

  private status: RecoveryStatus = {
    totalPersisted: 0,
    recovered: 0,
    failed: 0,
    needsReconnect: 0,
    inProgress: 0,
    lastRecoveryAt: null,
    errors: [],
  };

  private initialized = false;

  constructor(options: RecoveryServiceOptions) {
    this.hapiHome = options.hapiHome;
    this.tmuxSessionName = options.tmuxSessionName;
    this.autoRecover = options.autoRecover ?? true;
  }

  /**
   * Initialize the recovery service
   * Should be called on Hapimatic server startup
   *
   * @param serverSessionTags Optional set of valid session tags from the server.
   *        If provided, sessions NOT in this set will be immediately marked as error
   *        and excluded from recovery. This prevents stale local sessions from
   *        incorrectly claiming tmux windows that belong to valid sessions.
   */
  async initialize(serverSessionTags?: Set<string>): Promise<void> {
    if (this.initialized) {
      logger.debug("[RecoveryService] Already initialized");
      return;
    }

    logger.info("[RecoveryService] Initializing...");

    const store = createSessionStore(this.hapiHome);

    // Mark all sessions as offline initially
    await store.markAllOffline();
    logger.debug("[RecoveryService] Marked all sessions as offline");

    // If server validation is provided, mark invalid sessions as error BEFORE recovery
    if (serverSessionTags) {
      const sessions = await store.getAll();
      for (const session of sessions) {
        if (!serverSessionTags.has(session.hapiSessionId)) {
          logger.info(
            `[RecoveryService] Session not found on server, marking as error: ${session.hapiSessionId}`
          );
          await store.updateStatus(session.hapiSessionId, "error");
        }
      }
    }

    // Issue #1082 (ruling D4 / Task 6): GC orphan durable CODEX_HOME dirs whose
    // hapiSessionId no longer has ANY PersistedSession record (the session is
    // gone). Sessions that merely need reconnect KEEP their dir — its sessions/
    // JSONL IS the resume history. Best-effort; never blocks init.
    await this.gcOrphanCodexHomes(store).catch(err => {
      logger.debug(`[RecoveryService] Orphan CODEX_HOME GC failed: ${err}`);
    });

    if (this.autoRecover) {
      await this.recoverAllSessions();
    }

    this.initialized = true;
    logger.info("[RecoveryService] Initialization complete");
  }

  /**
   * Issue #1082 (ruling D4): remove orphan durable CODEX_HOME dirs — those under
   * `<hapiHome>/codex-homes/` whose directory name (the hapiSessionId) has no
   * PersistedSession record. A record in ANY status (active/offline/error/
   * needs-reconnect) protects its dir, so a resumable session's resume JSONL is
   * never GC'd. Covers the daemon-crash-before-stopTmuxSession leak case.
   */
  private async gcOrphanCodexHomes(
    store: ReturnType<typeof createSessionStore>
  ): Promise<void> {
    const codexHomesBase = join(this.hapiHome, "codex-homes");
    let entries: string[];
    try {
      entries = await fs.readdir(codexHomesBase);
    } catch {
      // Dir absent (no codex tmux session ever created one) — nothing to GC.
      return;
    }
    const liveIds = new Set((await store.getAll()).map(s => s.hapiSessionId));
    for (const entry of entries) {
      if (liveIds.has(entry)) {
        continue; // has a record (any status) — keep the dir.
      }
      const orphanDir = join(codexHomesBase, entry);
      await fs
        .rm(orphanDir, { recursive: true, force: true })
        .then(() =>
          logger.info(`[RecoveryService] GC'd orphan CODEX_HOME: ${entry}`)
        )
        .catch(err =>
          logger.debug(
            `[RecoveryService] Failed to GC orphan CODEX_HOME ${orphanDir}: ${err}`
          )
        );
    }
  }

  /**
   * Attempt to recover all persisted sessions
   */
  async recoverAllSessions(): Promise<RecoveryResult[]> {
    const store = createSessionStore(this.hapiHome);
    const tmux = new TmuxManager({
      sessionName: this.tmuxSessionName,
      socketName: this.tmuxSessionName,
    });

    const allSessions = await store.getAll();

    // Filter out sessions already marked as error (e.g., from server validation)
    // These should NOT participate in recovery and should NOT claim tmux windows
    const sessions = allSessions.filter(s => s.status !== "error");
    const alreadyFailed = allSessions.length - sessions.length;

    this.status.totalPersisted = allSessions.length;
    this.status.inProgress = sessions.length;
    this.status.failed = alreadyFailed; // Count pre-filtered sessions as failed
    this.status.errors = [];

    logger.info(
      `[RecoveryService] Attempting to recover ${sessions.length} sessions (${alreadyFailed} already marked as error)`
    );

    const results: RecoveryResult[] = [];

    for (const session of sessions) {
      const result = await this.recoverSession(session, tmux, store);
      results.push(result);

      this.status.inProgress--;
      if (result.success && result.needsReconnect) {
        this.status.needsReconnect++;
      } else if (result.success) {
        this.status.recovered++;
      } else {
        this.status.failed++;
        if (result.error) {
          this.status.errors.push({
            sessionId: session.hapiSessionId,
            error: result.error,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    this.status.lastRecoveryAt = new Date().toISOString();

    logger.info(
      `[RecoveryService] Recovery complete: ${this.status.recovered} recovered, ${this.status.needsReconnect} need reconnect, ${this.status.failed} failed`
    );

    return results;
  }

  /**
   * Recover a single session
   */
  private async recoverSession(
    session: PersistedSession,
    tmux: TmuxManager,
    store: ReturnType<typeof createSessionStore>
  ): Promise<RecoveryResult> {
    logger.debug(
      `[RecoveryService] Recovering session: ${session.hapiSessionId}`
    );

    const result: RecoveryResult = {
      hapiSessionId: session.hapiSessionId,
      success: false,
      tmuxWindowExists: false,
      processAlive: false,
      needsReconnect: false,
      // Issue #1082: surface a recovered codex session's durable CODEX_HOME.
      // The validation flow below is agent-agnostic (window/process/env checks);
      // codex recovery differs only server-side (sessionRespawn threads the
      // codex resume id, ruling D5) — nothing agent-specific is needed here.
      ...(session.codexHome ? { codexHome: session.codexHome } : {}),
    };

    try {
      // Check if tmux session exists
      if (!(await tmux.sessionExists())) {
        result.error = "tmux session does not exist";
        await store.updateStatus(session.hapiSessionId, "error");
        return result;
      }

      // #3734/#3732 Task 3: resolve the session's window by IDENTITY, never by
      // the collision-prone name — restart recovery must never cross-adopt a
      // same-titled sibling (R2). `winTarget` is the resolved @N (preferred) or
      // the legacy name; every window op below uses it. Ordered tiers:
      //   (1) persisted @N — only if this session OWNS it (#4218: an @N is an
      //       address within ONE tmux-server lifetime; after a server restart
      //       the same id can name another session's live window);
      //   (2) @hapi_identity == hapiSessionId dedicated query (legacy record or
      //       stale id → adopt + persist the id);
      //   (3) legacy name existence, then the /proc rename-rediscovery scan
      //       (getWindowHapiSessionId — identity-correct by construction) —
      //       ONLY for a record that never had an @N (#4218 F2: a record whose
      //       id went stale must not reach a same-titled window by name).
      let winTarget = session.tmuxWindow;
      result.tmuxWindowExists = false;
      const hadWindowId = Boolean(session.tmuxWindowId);

      // (1) persisted @N fast path — exists AND owned
      if (session.tmuxWindowId) {
        const windowId = session.tmuxWindowId;
        const byId = await resolveOwnedWindow(
          tmux,
          windowId,
          session.hapiSessionId
        );
        if (byId.kind === "owned") {
          winTarget = windowId;
          result.tmuxWindowExists = true;
        } else if (byId.kind === "fault") {
          // A tmux fault proves nothing: keep the id and skip this session for
          // this pass (status unchanged — the next recovery pass retries).
          result.error = `tmux ownership read for window ${windowId} failed: ${
            byId.error instanceof Error
              ? byId.error.message
              : String(byId.error)
          }`;
          logger.warn(
            `[RecoveryService] ${result.error} — skipping ${session.hapiSessionId} this pass`
          );
          return result;
        } else {
          // Keep the id (operator ruling on the #4218 close, overriding 4238-3):
          // clearing it made the record look id-less, so the next daemon start
          // (markAllOffline resets the status) would reach the NAME tier, and the
          // two #4038-owned sites (rename sync, detector stale-kill) would fall
          // back from the cleared id to the window NAME — a same-titled live
          // window. A kept id keeps F2 in force on every pass; tier 2 below
          // replaces it when the identity row is found. Those two sites now
          // check ownership of a kept id before reading, renaming or killing
          // through it (#4038), so a recycled id reaches no other window.
          logger.warn(
            `[RecoveryService] stale window id ${windowId} for ${session.hapiSessionId} (tmux server restarted?) — kept; identity tier only`
          );
        }
      }

      // (2) @hapi_identity dedicated-query fallback (legacy / stale id)
      if (!result.tmuxWindowExists) {
        const idRows = await tmux.listWindowIdentities();
        const match = idRows.find(
          r => r.identity === session.hapiSessionId && r.id
        );
        if (match?.id) {
          logger.info(
            `[RecoveryService] Resolved session ${session.hapiSessionId} to window ${match.id} by @hapi_identity`
          );
          winTarget = match.id;
          session.tmuxWindowId = match.id;
          // Keep the stored name a hint in step with the resolved window.
          const currentName = await tmux.getWindowName(match.id);
          if (currentName) session.tmuxWindow = currentName;
          await store.save(session);
          result.tmuxWindowExists = true;
        }
      }

      // (3) legacy path: name existence, then the /proc rename-rediscovery scan
      // (verifying HAPI_SESSION_ID in the process environment — prevents
      // cross-contamination from tmux-resurrect ghost windows). Never for a
      // record that had an @N (#4218 F2).
      if (!result.tmuxWindowExists && !hadWindowId) {
        result.tmuxWindowExists = await tmux.windowExists(session.tmuxWindow);
        if (!result.tmuxWindowExists) {
          const windows = await tmux.listWindows();
          for (const window of windows) {
            if (window.name === "control") continue;
            const windowSessionId = await tmux.getWindowHapiSessionId(
              window.name
            );
            if (windowSessionId === session.hapiSessionId) {
              logger.info(
                `[RecoveryService] Window "${session.tmuxWindow}" verified as renamed to "${window.name}" for session ${session.hapiSessionId}`
              );
              session.tmuxWindow = window.name;
              await store.save(session);
              winTarget = window.name;
              result.tmuxWindowExists = true;
              break;
            }
          }
        }
      }

      if (!result.tmuxWindowExists) {
        result.error = hadWindowId
          ? `tmux window for ${session.hapiSessionId} not found (its stored window id was stale and no @hapi_identity row matched)`
          : `tmux window "${session.tmuxWindow}" does not exist`;
        await store.updateStatus(session.hapiSessionId, "error");
        return result;
      }

      // Check if the process is still alive (#3734: by the resolved @N target).
      result.processAlive = await tmux.isWindowAlive(winTarget);
      if (!result.processAlive) {
        // Kill the orphan tmux window — process is dead but window lingers.
        // #3734/#4218: kill only a window this session OWNS, by its @N. An
        // identity-less legacy window with a dead process cannot prove
        // ownership, so it is NOT killed here — and no other reaper takes it
        // (reconcileOrphanWindows skips dead panes; #4453 tracks the leak).
        const owned = await resolveOwnedWindow(
          tmux,
          winTarget,
          session.hapiSessionId
        );
        if (owned.kind === "owned") {
          await tmux.killWindow(owned.target);
          logger.info(
            `[RecoveryService] Killed orphan tmux window "${session.tmuxWindow}" (${winTarget}) for session ${session.hapiSessionId}`
          );
        } else {
          logger.warn(
            `[RecoveryService] Window "${session.tmuxWindow}" (${winTarget}) is not provably ${session.hapiSessionId}'s (${describeOwnershipFailure(
              owned
            )}) — not killing`
          );
        }
        result.error =
          owned.kind === "owned"
            ? "Process in tmux window is not alive (window cleaned up)"
            : "Process in tmux window is not alive (window not provably this session's — left in place)";
        await store.updateStatus(session.hapiSessionId, "error");
        return result;
      }

      // Check if session CWD still exists on disk — a deleted worktree
      // means this session can never be reconnected successfully. (#956)
      if (session.cwd) {
        try {
          await fs.access(session.cwd);
        } catch {
          // expected: non-existent CWD is the trigger condition for marking
          // the session as error and cleaning up the orphan tmux window (#956).
          logger.warn(
            `[RecoveryService] Session ${session.hapiSessionId} has non-existent CWD: ${session.cwd} — marking as error`
          );
          result.error = `Session working directory no longer exists: ${session.cwd}`;
          await store.updateStatus(session.hapiSessionId, "error");
          return result;
        }
      }

      // Resume-time .claude/ re-sync (#1320; source-branch-aware since #1399).
      // Existing worktrees created before #1076 (the env-var-paths fix) may
      // still carry pre-fix settings.json content baked in from a stale local
      // source branch. Bring them up to date with `origin/<source-branch>` on
      // resume (default `origin/main` if `.worktree-meta.json` is missing or
      // malformed). Fire-and-forget so a slow network does not block session
      // start — the SessionStart settings validator hook is the fail-fast
      // surface.
      //
      // Disable by setting HAPI_SYNC_CONFIG_ON_RESUME=0 (default ON).
      if (session.cwd && process.env.HAPI_SYNC_CONFIG_ON_RESUME !== "0") {
        const worktreePath = session.cwd;
        const recoverySessionId = session.hapiSessionId;
        void (async () => {
          try {
            // Issue #1328: scope to hapimatic-private worktrees. Skip the
            // sync for sessions whose cwd belongs to a different repo
            // (rp1-home, rp1-home worktrees, other projects) so we don't
            // issue `git fetch` against unrelated origins on every daemon
            // recovery.
            if (!(await isHapimaticPrivateCwd(worktreePath))) {
              logger.debug(
                `[RecoveryService] Resume-time .claude/ re-sync: skipping non-hapimatic-private cwd ${worktreePath} (${recoverySessionId})`
              );
              return;
            }

            const syncResult = await syncConfigFromMain({ worktreePath });
            if (syncResult.ok) {
              // Issue #1327: surface fetch failure even when sync overall
              // succeeded — without this, a hung/failed fetch followed by a
              // successful diff/checkout against the (potentially stale) local
              // origin/<source-branch> ref would log nothing, recreating the
              // silent-failure mode that #1320 was meant to close.
              if (!syncResult.fetchSucceeded) {
                logger.warn(
                  `[RecoveryService] Resume-time .claude/ re-sync: fetch failed, used local origin/<source-branch> ref (${syncResult.filesUpdated} files updated) (${recoverySessionId})`
                );
              } else if (syncResult.filesUpdated > 0) {
                logger.info(
                  `[RecoveryService] Resume-time .claude/ re-sync: ${syncResult.filesUpdated} files updated (${recoverySessionId})`
                );
              }
            } else {
              logger.warn(
                `[RecoveryService] Resume-time .claude/ re-sync failed (non-fatal): ${syncResult.error} (${recoverySessionId})`
              );
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.warn(
              `[RecoveryService] Resume-time .claude/ re-sync threw (non-fatal): ${message} (${recoverySessionId})`
            );
          }
        })();
      }

      // Verify the alive process is actually a HAPI session, not a zombie
      // shell from tmux-resurrect. tmux-resurrect spawns fresh bash shells
      // in recovered windows — these pass isWindowAlive() but aren't HAPI
      // sessions (no HAPI_SESSION_ID in process environment, no Socket.IO
      // connection, no heartbeats).
      const windowHapiId = await tmux.getWindowHapiSessionId(winTarget);
      if (!windowHapiId) {
        // #2245 [2245-1]: an archived-for-reconnect window (#2683) is
        // deliberately kept alive but carries NO live HAPI process — only the
        // outer `exec bash` of the launch script — so getWindowHapiSessionId()
        // returns null and this window reaches the zombie branch. Left
        // unchecked it becomes "needs-reconnect" → autoReconnectZombieSessions
        // KILLS the preserved window and respawns `hapi claude --resume`, whose
        // heartbeat flips the session back to active: the exact restart
        // resurrection this issue reports. Consult the durable archive signal —
        // the `@hapi_archive` window tag (surfaced as `archiveTag` on
        // listWindows(), #2683 field-7) — BEFORE classifying as a zombie. This
        // check sits inside the null-windowHapiId branch, so a genuinely running
        // session (windowHapiId === session.hapiSessionId) never reaches it and
        // always wins to "active". An archived window is preserved (window NOT
        // killed), kept archived (status "offline"), and NEVER needs-reconnect.
        // #3734: read the archive tag on the RESOLVED window by its @N
        // (isArchiveTagged(winTarget)) rather than a name-matched listWindows()
        // row, so a same-title collision cannot read another session's tag.
        // #2245's ordering is preserved — this check stays inside the
        // null-windowHapiId branch, AFTER the live-process match.
        if (await tmux.isArchiveTagged(winTarget)) {
          logger.info(
            `[RecoveryService] Window "${session.tmuxWindow}" is archive-tagged (@hapi_archive) — preserving as archived, NOT reconnecting: ${session.hapiSessionId}`
          );
          await store.updateStatus(session.hapiSessionId, "offline");
          result.success = true;
          result.needsReconnect = false;
          return result;
        }

        // Window has a live process but no HAPI_SESSION_ID — zombie shell.
        // Mark for auto-reconnect so the daemon can kill it and spawn a
        // real hapi session with --resume.
        logger.info(
          `[RecoveryService] Window "${session.tmuxWindow}" is alive but has no HAPI_SESSION_ID — marking for reconnect: ${session.hapiSessionId}`
        );
        await store.updateStatus(session.hapiSessionId, "needs-reconnect");
        result.success = true;
        result.needsReconnect = true;
        return result;
      }

      // HAPI_SESSION_ID found — verify it matches the expected session
      if (windowHapiId !== session.hapiSessionId) {
        logger.warn(
          `[RecoveryService] Window "${session.tmuxWindow}" has mismatched HAPI_SESSION_ID: expected ${session.hapiSessionId}, found ${windowHapiId}`
        );
        await store.updateStatus(session.hapiSessionId, "error");
        result.error = `HAPI_SESSION_ID mismatch: expected ${session.hapiSessionId}, found ${windowHapiId}`;
        return result;
      }

      // Success! Real HAPI session running in this window.
      await store.updateStatus(session.hapiSessionId, "active");
      result.success = true;

      logger.info(
        `[RecoveryService] Successfully recovered session: ${session.hapiSessionId}`
      );
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      await store.updateStatus(session.hapiSessionId, "error");
      logger.warn(
        `[RecoveryService] Failed to recover session ${session.hapiSessionId}: ${result.error}`
      );
      logger.reportCaught(error, {
        category: "recovery-session-fail",
        severity: "error",
        sessionId: session.hapiSessionId,
      });
    }

    return result;
  }

  /**
   * Get current recovery status
   */
  getStatus(): RecoveryStatus {
    return { ...this.status };
  }

  /**
   * Get all sessions with their current status
   */
  async getSessions(): Promise<PersistedSession[]> {
    const store = createSessionStore(this.hapiHome);
    return store.getAll();
  }

  /**
   * Get only active (recovered) sessions
   */
  async getActiveSessions(): Promise<PersistedSession[]> {
    const sessions = await this.getSessions();
    return sessions.filter(s => s.status === "active");
  }

  /**
   * Get sessions that need reconnection (zombie shells from tmux-resurrect).
   * These have live tmux windows but no HAPI process running inside.
   */
  async getNeedsReconnectSessions(): Promise<PersistedSession[]> {
    const sessions = await this.getSessions();
    return sessions.filter(s => s.status === "needs-reconnect");
  }

  /**
   * Retry recovery for a failed session
   */
  async retryRecovery(hapiSessionId: string): Promise<RecoveryResult> {
    const store = createSessionStore(this.hapiHome);
    const tmux = new TmuxManager({
      sessionName: this.tmuxSessionName,
      socketName: this.tmuxSessionName,
    });

    const session = await store.get(hapiSessionId);
    if (!session) {
      return {
        hapiSessionId,
        success: false,
        error: "Session not found",
        tmuxWindowExists: false,
        processAlive: false,
        needsReconnect: false,
      };
    }

    await store.updateStatus(hapiSessionId, "recovering");
    return this.recoverSession(session, tmux, store);
  }
}

/**
 * Create a RecoveryService with default settings
 */
export function createRecoveryService(
  hapiHome: string,
  tmuxSessionName: string
): RecoveryService {
  return new RecoveryService({
    hapiHome,
    autoRecover: true,
    tmuxSessionName,
  });
}
