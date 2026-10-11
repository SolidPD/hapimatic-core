// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Heartbeat Session Manager
 *
 * Manages the lifecycle of the dedicated heartbeat session:
 * - Ensures session is active (reconnects if inactive, spawns if none exists)
 * - Handles session rotation to prevent context bloat
 * - Tracks beat count and rotation timing
 *
 * Uses the reconnect-on-demand pattern confirmed by spike analysis:
 *   reconnectSession() → poll for active → 1s buffer → ready to send
 */

import type { SyncEngine } from "../../sync/syncEngine";
import type { HeartbeatConfig, HeartbeatState } from "../../heartbeat/types";

/** Activation polling: 500ms interval, 60 attempts = 30s timeout */
const ACTIVATION_POLL_INTERVAL_MS = 500;
const ACTIVATION_MAX_ATTEMPTS = 60;
/** Buffer after activation for socket room stabilization */
const POST_ACTIVATION_BUFFER_MS = 1_000;

export class HeartbeatSessionManager {
  private state: HeartbeatState;

  constructor(private readonly syncEngine: SyncEngine) {
    this.state = {
      sessionId: null,
      beatsSinceRotation: 0,
      lastRotationAt: Date.now(),
      consecutiveFailures: 0,
      currentInterval: 0, // Set by HeartbeatService from config
      lastTickAt: null,
      tickInProgress: false,
    };
  }

  getState(): HeartbeatState {
    return { ...this.state };
  }

  getSessionId(): string | null {
    return this.state.sessionId;
  }

  /** Set the session ID (used when loading persisted state or after spawn) */
  setSessionId(sessionId: string): void {
    this.state.sessionId = sessionId;
  }

  incrementBeats(): void {
    this.state.beatsSinceRotation++;
  }

  getBeats(): number {
    return this.state.beatsSinceRotation;
  }

  recordFailure(): void {
    this.state.consecutiveFailures++;
  }

  resetFailures(): void {
    this.state.consecutiveFailures = 0;
  }

  getConsecutiveFailures(): number {
    return this.state.consecutiveFailures;
  }

  setTickInProgress(value: boolean): void {
    this.state.tickInProgress = value;
  }

  isTickInProgress(): boolean {
    return this.state.tickInProgress;
  }

  recordTick(): void {
    this.state.lastTickAt = Date.now();
  }

  getLastTickAt(): number | null {
    return this.state.lastTickAt;
  }

  setCurrentInterval(interval: number): void {
    this.state.currentInterval = interval;
  }

  getCurrentInterval(): number {
    return this.state.currentInterval;
  }

  /**
   * Check if the session should be rotated based on beat count and age.
   */
  shouldRotate(config: HeartbeatConfig): boolean {
    if (!this.state.sessionId) return false;

    if (this.state.beatsSinceRotation >= config.rotateAfterBeats) {
      return true;
    }

    const age = Date.now() - this.state.lastRotationAt;
    if (age >= config.maxSessionAgeMs) {
      return true;
    }

    return false;
  }

  /**
   * Ensure the heartbeat session is active and ready to receive messages.
   *
   * Flow:
   * 1. If no session exists → spawn a fresh one
   * 2. If session exists but inactive → reconnect via --resume
   * 3. If session is already active → skip reconnect (benign case)
   * 4. Poll for activation (500ms × 60 = 30s timeout)
   * 5. Wait 1s post-activation buffer for socket room stabilization
   */
  async ensureActive(
    config: HeartbeatConfig
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // No session yet — need to spawn fresh
    if (!this.state.sessionId) {
      return this.spawnFreshSession(config);
    }

    // Check current session state
    const session = this.syncEngine.getSession(this.state.sessionId);

    if (!session) {
      // Session was deleted or expired from cache — spawn fresh
      console.log(
        `[HeartbeatSession] Session ${this.state.sessionId} not found in cache, spawning fresh`
      );
      return this.spawnFreshSession(config);
    }

    if (session.active) {
      // Already active — skip reconnect (failure mode #4: benign)
      console.log(
        `[HeartbeatSession] Session ${this.state.sessionId} already active, skipping reconnect`
      );
      return { ok: true };
    }

    // Session exists but inactive — reconnect
    console.log(
      `[HeartbeatSession] Reconnecting session ${this.state.sessionId}`
    );
    const result = await this.syncEngine.reconnectSession(this.state.sessionId);

    if (result.type === "error") {
      // If reconnect fails, try spawning fresh
      console.error(
        `[HeartbeatSession] Reconnect failed: ${result.message}. Trying fresh spawn.`
      );
      return this.spawnFreshSession(config);
    }

    // Poll for activation
    return this.waitForActivation(this.state.sessionId);
  }

  /**
   * Rotate the heartbeat session: archive the old one and spawn fresh.
   * The fresh session has no --resume, starting a clean conversation.
   */
  async rotate(
    config: HeartbeatConfig
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // Archive old session if it exists
    if (this.state.sessionId) {
      try {
        // #1627: reap the old tag's `hapimatic-remote` window B (the real
        // `claude` under HAPI_CLAUDE_LAUNCHER=tmux) at rotation time —
        // closes the leak previously left to the `hapi launcher reap`
        // backstop (#1428). Tag isolation makes this safe: spawnFreshSession
        // below spawns with NO hapiSessionId (brand-new tag, no --resume),
        // so the same-tag respawn race (#1581/#1585 — the reason
        // switchAccount/tokenRefreshRestart must NOT reap) cannot match the
        // new session's window. Decision record: #1603 Open Question 1.
        await this.syncEngine.archiveSession(this.state.sessionId, {
          reapRemoteWindow: true,
          // #2453 (Task 7): rotation is a respawn class (fresh tag). Do NOT
          // auto-pause the old session's loops — they belong to a session that
          // is gone, so they surface as orphaned cards (the R6 surface) rather
          // than pausing forever (the old uuid never reconnects).
          isRespawn: true,
        });
        console.log(
          `[HeartbeatSession] Archived old session ${this.state.sessionId}`
        );
      } catch (error) {
        console.warn(
          `[HeartbeatSession] Failed to archive old session: ${error}`
        );
        // Non-blocking: proceed with spawn even if archive fails
      }
    }

    // Reset rotation tracking
    this.state.beatsSinceRotation = 0;
    this.state.lastRotationAt = Date.now();
    this.state.sessionId = null;

    return this.spawnFreshSession(config);
  }

  /**
   * Spawn a brand new session (no --resume) for the heartbeat.
   */
  private async spawnFreshSession(
    config: HeartbeatConfig
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    // Find an online machine — prefer configured machine, fall back to first online
    const machines = this.syncEngine.getOnlineMachines();
    if (machines.length === 0) {
      return { ok: false, error: "No online machines available" };
    }
    const preferred = config.machine
      ? machines.find(m => m.id === config.machine)
      : null;
    const machineId = preferred?.id ?? machines[0].id;

    const sessionType = config.sessionType ?? "simple";
    const worktreeName =
      sessionType === "worktree"
        ? (config.worktreeBranchName ?? "heartbeat")
        : undefined;

    console.log(
      `[HeartbeatSession] Spawning fresh session on machine ${machineId} in ${config.sessionDirectory} (type: ${sessionType})`
    );

    // Issue #1262: heartbeat is a keepalive — it does not serve a
    // Hapimatic instance, so it never needs a 3010-3019 port. Explicit
    // `claimPort: false` makes that intent visible and avoids burning
    // a port slot every rotation.
    const result = await this.syncEngine.spawnSession({
      machineId,
      directory: config.sessionDirectory,
      yolo: true,
      claimPort: false,
      sessionType,
      worktreeName,
    });

    if (result.type === "error") {
      return { ok: false, error: `Spawn failed: ${result.message}` };
    }

    this.state.sessionId = result.sessionId;
    this.state.beatsSinceRotation = 0;
    this.state.lastRotationAt = Date.now();

    // Set session identity post-creation (emoji not part of spawn options)
    const sessionName = config.sessionName ?? "HEARTBEAT";
    const sessionEmoji = config.sessionEmoji ?? "💓";
    try {
      await this.syncEngine.renameSession(result.sessionId, sessionName);
      await this.syncEngine.updateSessionSource(result.sessionId, "heartbeat");
      await this.syncEngine.updateSessionEmoji(result.sessionId, sessionEmoji);
    } catch (err) {
      console.warn(`[HeartbeatSession] Failed to set session identity: ${err}`);
    }

    console.log(
      `[HeartbeatSession] Fresh session spawned: ${result.sessionId} (${sessionEmoji} ${sessionName})`
    );

    return this.waitForActivation(result.sessionId);
  }

  /**
   * Poll getSession() until active === true, then wait for post-activation buffer.
   */
  private async waitForActivation(
    sessionId: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    for (let i = 0; i < ACTIVATION_MAX_ATTEMPTS; i++) {
      const session = this.syncEngine.getSession(sessionId);
      if (session?.active) {
        // Post-activation buffer: socket room stabilization
        await sleep(POST_ACTIVATION_BUFFER_MS);
        return { ok: true };
      }
      await sleep(ACTIVATION_POLL_INTERVAL_MS);
    }

    return {
      ok: false,
      error: `Session ${sessionId} did not become active within ${(ACTIVATION_POLL_INTERVAL_MS * ACTIVATION_MAX_ATTEMPTS) / 1000}s`,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
