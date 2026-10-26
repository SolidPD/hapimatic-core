// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Stall Watchdog Service
 *
 * External watchdog that monitors Claude Code sessions for stalls
 * using a dual-signal approach:
 *   1. Primary: session.thinking persists beyond threshold
 *   2. Confirmation: message seq unchanged between polls (no progress)
 *
 * Detection flow:
 *   poll → find thinking sessions past threshold → record as candidate
 *   → next poll: compare seq → if unchanged = confirmed stall → notify
 *   → if seq advanced = active, reset candidate
 *
 * This complements the in-process timeout mechanisms (env vars + hooks)
 * by detecting stalls from outside the Claude process.
 */

import type { Session, SyncEngine } from "../../sync/syncEngine";
import type { PushService } from "../../push/pushService";
import type { Store } from "../../store";
import { buildSessionPushPayloadFromSession } from "../../push/sessionPushPayload";
import { configuration } from "../../configuration";
import { loadStallWatchdogConfig } from "./config";
import type {
  StallWatchdogConfig,
  StallCandidate,
  StallEvent,
  StallWatchdogStatus,
} from "./types";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";

const MAX_RECENT_EVENTS = 20;

export class StallWatchdogService {
  private readonly syncEngine: SyncEngine;
  private readonly pushService: PushService;
  private readonly store: Store;
  private config: StallWatchdogConfig;
  private readonly loop: SupervisedLoop;
  private running = false;
  private lastPollAt: number | null = null;
  private totalEventsDetected = 0;

  /** Sessions under observation (past thinking threshold, awaiting seq confirmation) */
  private readonly candidates = new Map<string, StallCandidate>();
  /** Confirmed stall events (circular buffer) */
  private readonly recentEvents: StallEvent[] = [];
  /** Per-session cooldown timestamps to prevent duplicate alerts */
  private readonly cooldowns = new Map<string, number>();

  constructor(
    syncEngine: SyncEngine,
    pushService: PushService,
    store: Store,
    config: StallWatchdogConfig,
    jobOpts?: { node?: string; jobRegistry?: JobRegistry | null }
  ) {
    this.syncEngine = syncEngine;
    this.pushService = pushService;
    this.store = store;
    this.config = config;
    // #1963: supervised-loop wrapper (finally-reschedule + stall watchdog +
    // job-registry registration). getIntervalMs reads the live config so a
    // runtime pollIntervalMs change (updateConfig) takes effect on restart.
    this.loop = new SupervisedLoop({
      name: "stall-watchdog",
      node: jobOpts?.node ?? "standalone",
      intervalMs: config.pollIntervalMs,
      getIntervalMs: () => this.config.pollIntervalMs,
      immediate: false,
      registry: jobOpts?.jobRegistry ?? undefined,
      tick: () => this.runPollTick(),
    });
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[StallWatchdog] Disabled in config, not starting");
      return;
    }

    this.running = true;
    console.log(
      `[StallWatchdog] Starting with ${this.config.pollIntervalMs / 1000}s poll, ` +
        `${this.config.thinkingThresholdMs / 1000}s threshold, ` +
        `${this.config.confirmationWindowMs / 1000}s confirmation`
    );
    this.loop.start();
  }

  stop(): void {
    this.running = false;
    this.loop.stop();
    console.log("[StallWatchdog] Stopped");
  }

  getStatus(): StallWatchdogStatus {
    return {
      enabled: this.config.enabled,
      running: this.running,
      pollIntervalMs: this.config.pollIntervalMs,
      thinkingThresholdMs: this.config.thinkingThresholdMs,
      activeCandidates: this.candidates.size,
      totalEventsDetected: this.totalEventsDetected,
      recentEvents: [...this.recentEvents],
      lastPollAt: this.lastPollAt,
    };
  }

  getConfig(): StallWatchdogConfig {
    return { ...this.config };
  }

  /** Run a one-shot poll (for manual triggering via API) */
  async checkNow(): Promise<StallEvent[]> {
    const eventsBefore = this.recentEvents.length;
    await this.poll();
    return this.recentEvents.slice(eventsBefore);
  }

  /** Update config at runtime */
  async updateConfig(_updates: Partial<StallWatchdogConfig>): Promise<void> {
    this.config = await loadStallWatchdogConfig(configuration.dataDir);

    if (this.config.enabled && !this.running) {
      await this.start();
    } else if (!this.config.enabled && this.running) {
      this.stop();
    }
  }

  // ---------- Private: Poll Loop ----------

  /**
   * One supervised poll: run poll(), log any error (preserving the prior
   * "[StallWatchdog] Poll error" log), then rethrow so the SupervisedLoop
   * records lastError + re-arms via its finally.
   */
  private async runPollTick(): Promise<void> {
    try {
      await this.poll();
    } catch (error) {
      console.error("[StallWatchdog] Poll error:", error);
      throw error;
    }
  }

  private async poll(): Promise<void> {
    const now = Date.now();
    this.lastPollAt = now;

    const sessions = this.syncEngine.getSessions();
    const activeSessionIds = new Set<string>();

    for (const session of sessions) {
      // Skip inactive sessions
      if (!session.active) {
        this.candidates.delete(session.id);
        continue;
      }

      // Skip non-thinking sessions — they're waiting for user input, not stalled
      if (!session.thinking) {
        this.candidates.delete(session.id);
        continue;
      }

      activeSessionIds.add(session.id);

      const thinkingDuration = now - session.thinkingAt;

      // Not yet past threshold — too early to consider as candidate
      if (thinkingDuration < this.config.thinkingThresholdMs) continue;

      const existing = this.candidates.get(session.id);

      if (!existing) {
        // New candidate: record current seq for later comparison
        const seq = this.store.messages.getMaxSeq(session.id);
        this.candidates.set(session.id, {
          sessionId: session.id,
          namespace: session.namespace,
          detectedAt: now,
          seqAtDetection: seq,
          thinkingAt: session.thinkingAt,
        });
        console.log(
          `[StallWatchdog] New candidate: session ${session.id.slice(0, 8)}... ` +
            `(thinking for ${Math.round(thinkingDuration / 1000)}s, seq=${seq})`
        );
        continue;
      }

      // Existing candidate: check if confirmation window has elapsed
      const timeSinceDetection = now - existing.detectedAt;
      if (timeSinceDetection < this.config.confirmationWindowMs) continue;

      // Confirmation: compare current seq with seq at detection
      const currentSeq = this.store.messages.getMaxSeq(session.id);

      if (currentSeq > existing.seqAtDetection) {
        // Seq advanced — session is making progress, not stalled
        // Reset candidate with fresh seq baseline
        existing.detectedAt = now;
        existing.seqAtDetection = currentSeq;
        console.log(
          `[StallWatchdog] Candidate cleared (seq advanced): ${session.id.slice(0, 8)}... ` +
            `(seq ${existing.seqAtDetection} → ${currentSeq})`
        );
        continue;
      }

      // Check cooldown — don't re-notify for the same session too soon
      const lastNotified = this.cooldowns.get(session.id);
      if (lastNotified && now - lastNotified < this.config.cooldownMs) continue;

      // Confirmed stall: thinking persists AND seq unchanged after confirmation window
      const event: StallEvent = {
        sessionId: session.id,
        namespace: session.namespace,
        detectedAt: existing.detectedAt,
        confirmedAt: now,
        thinkingDurationMs: now - session.thinkingAt,
        seqAtDetection: existing.seqAtDetection,
        seqAtConfirmation: currentSeq,
        notified: true,
        nudged: false,
      };

      console.warn(
        `[StallWatchdog] STALL CONFIRMED: session ${session.id.slice(0, 8)}... ` +
          `(thinking for ${Math.round(event.thinkingDurationMs / 1000)}s, seq unchanged at ${currentSeq})`
      );

      // Send push notification
      await this.notifyStall(session, event);

      // Optionally nudge the session
      if (this.config.nudgeEnabled) {
        await this.nudgeSession(session.id);
        event.nudged = true;
      }

      // Record event, apply cooldown, remove from candidates
      this.recentEvents.push(event);
      if (this.recentEvents.length > MAX_RECENT_EVENTS) {
        this.recentEvents.shift();
      }
      this.cooldowns.set(session.id, now);
      this.totalEventsDetected++;
      this.candidates.delete(session.id);
    }

    // Clean up candidates for sessions that disappeared (e.g., expired)
    for (const [id] of this.candidates) {
      if (!activeSessionIds.has(id)) {
        this.candidates.delete(id);
      }
    }
  }

  // ---------- Private: Notification ----------

  private async notifyStall(
    session: Session,
    event: StallEvent
  ): Promise<void> {
    const durationMin = Math.round(event.thinkingDurationMs / 60_000);

    try {
      // #4921: titled by the session; the event is the body.
      await this.pushService.sendToNamespace(
        session.namespace,
        buildSessionPushPayloadFromSession(
          session,
          "stall",
          "stall-detected",
          `Stall detected: thinking for ${durationMin}+ min with no progress`
        )
      );
    } catch (error) {
      console.error(
        `[StallWatchdog] Failed to send notification for ${session.id}:`,
        error
      );
    }
  }

  private async nudgeSession(sessionId: string): Promise<void> {
    try {
      await this.syncEngine.sendMessage(sessionId, {
        text: this.config.nudgeMessage,
        // #2205: stamp the programmatic stall-watchdog nudge as "watchdog" (not
        // "webapp") so it is distinguishable from real user input and does NOT
        // abort a pending auto-recovery (AutoRecoveryService R3).
        sentFrom: "watchdog",
      });
      console.log(
        `[StallWatchdog] Nudge sent to session ${sessionId.slice(0, 8)}...`
      );
    } catch (error) {
      console.error(
        `[StallWatchdog] Failed to nudge session ${sessionId}:`,
        error
      );
    }
  }
}
