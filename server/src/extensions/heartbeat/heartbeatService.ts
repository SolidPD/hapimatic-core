// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Heartbeat Service — Core Lifecycle
 *
 * Orchestrates the periodic heartbeat loop:
 *   tick → pre-checks → ensureActive → buildPrompt → sendMessage →
 *   monitorResponse → evaluate → notify/suppress → scheduleNext
 *
 * Uses setTimeout-based timer (not setInterval) for drift-free scheduling
 * and to prevent overlapping ticks.
 *
 * Response detection uses the `ready` event — NOT `thinking→false`
 * (which fires on every tool-use boundary during multi-step responses).
 */

import { existsSync } from "node:fs";
import type { SyncEngine, SyncEvent } from "../../sync/syncEngine";
import type { NotificationHub } from "../../notifications/notificationHub";
import type { PushService } from "../../push/pushService";
import { extractMessageEventType } from "../../notifications/eventParsing";
import { configuration } from "../../configuration";
import { loadHeartbeatConfig } from "../../config/heartbeatConfig";
import { HeartbeatSessionManager } from "./sessionManager";
import { SystemEventQueue } from "../../heartbeat/systemEvents";
import type {
  HeartbeatConfig,
  HeartbeatHistoryEntry,
  HeartbeatStatus,
  HeartbeatTickResult,
} from "../../heartbeat/types";
import type { ErrorLogger } from "../../logging/errorLogger";
import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";

/** Max time for a single tick (reconnect + response + processing) */
const TICK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Backoff multiplier after consecutive failures */
const BACKOFF_THRESHOLD = 3;
/** Max history entries kept in circular buffer */
const MAX_HISTORY = 50;

export class HeartbeatService {
  private readonly syncEngine: SyncEngine;
  private readonly notificationHub: NotificationHub;
  private readonly pushService: PushService;
  private readonly sessionManager: HeartbeatSessionManager;
  readonly systemEvents: SystemEventQueue;
  private config: HeartbeatConfig;
  private readonly loop: SupervisedLoop;
  private running = false;
  private history: HeartbeatHistoryEntry[] = [];
  private beatCounter = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    syncEngine: SyncEngine,
    notificationHub: NotificationHub,
    pushService: PushService,
    config: HeartbeatConfig,
    systemEvents: SystemEventQueue,
    private readonly errorLogger?: ErrorLogger | null,
    jobOpts?: { node?: string; jobRegistry?: JobRegistry | null }
  ) {
    this.syncEngine = syncEngine;
    this.notificationHub = notificationHub;
    this.pushService = pushService;
    this.config = config;
    this.sessionManager = new HeartbeatSessionManager(syncEngine);
    this.systemEvents = systemEvents;
    // #1963: supervised-loop wrapper. getIntervalMs reads the sessionManager's
    // CURRENT interval each reschedule (backoff/active-hours adjust it at
    // runtime), preserving the dynamic cadence. executeTick keeps its own
    // overlap guard + 5-min timeout race.
    this.loop = new SupervisedLoop({
      name: "heartbeat",
      node: jobOpts?.node ?? "standalone",
      intervalMs: config.every,
      getIntervalMs: () => this.sessionManager.getCurrentInterval(),
      immediate: false,
      registry: jobOpts?.jobRegistry ?? undefined,
      tick: () => this.runHeartbeatTick(),
    });
  }

  /** Start the heartbeat loop if enabled */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.errorLogger?.info("Disabled in config, not starting", {
        category: "heartbeat",
      });
      return;
    }

    this.running = true;
    this.sessionManager.setCurrentInterval(this.config.every);

    this.errorLogger?.info(
      `Starting with ${this.config.every / 1000}s interval, ` +
        `active hours ${this.config.activeHours.start}:00-${this.config.activeHours.end}:00 ${this.config.activeHours.timezone}`,
      { category: "heartbeat" }
    );

    this.loop.start();
  }

  /** Stop the heartbeat loop */
  stop(): void {
    this.running = false;
    this.loop.stop();
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // Unregister managed session from NotificationHub
    const sid = this.sessionManager.getSessionId();
    if (sid) {
      this.notificationHub.unregisterManagedSession(sid);
    }

    this.errorLogger?.info("Stopped", { category: "heartbeat" });
  }

  /** Fire an immediate out-of-cycle heartbeat */
  async triggerNow(): Promise<HeartbeatTickResult> {
    if (this.sessionManager.isTickInProgress()) {
      return {
        timestamp: Date.now(),
        success: false,
        skipped: true,
        skipReason: "Tick already in progress",
        durationMs: 0,
      };
    }

    // Run an out-of-cycle tick directly. The supervised loop keeps its own
    // cadence; executeTick's isTickInProgress guard serializes against it.
    return this.executeTick();
  }

  /** Update config at runtime (called by PUT /api/heartbeat/config) */
  async updateConfig(_updates: Partial<HeartbeatConfig>): Promise<void> {
    // Reload full config from disk (saveHeartbeatConfig already persisted)
    this.config = await loadHeartbeatConfig(configuration.dataDir);
    this.sessionManager.setCurrentInterval(this.config.every);

    // Handle enable/disable transitions
    if (this.config.enabled && !this.running) {
      await this.start();
    } else if (!this.config.enabled && this.running) {
      this.stop();
    }
  }

  /** Get current status */
  getStatus(): HeartbeatStatus {
    const state = this.sessionManager.getState();
    return {
      enabled: this.config.enabled,
      running: this.running,
      lastTickAt: state.lastTickAt,
      nextTickAt: this.running ? Date.now() + state.currentInterval : null,
      sessionId: state.sessionId,
      beatsSinceRotation: state.beatsSinceRotation,
      consecutiveFailures: state.consecutiveFailures,
      currentInterval: state.currentInterval,
      activeHoursActive: this.isWithinActiveHours(),
    };
  }

  /** Get recent heartbeat history */
  getHistory(): HeartbeatHistoryEntry[] {
    return [...this.history];
  }

  /** Get the underlying config */
  getConfig(): HeartbeatConfig {
    return { ...this.config };
  }

  // ---------- Private: Tick Loop ----------

  /**
   * One supervised tick: run executeTick (which owns the overlap guard +
   * 5-min timeout race + recordResult). The SupervisedLoop owns rescheduling
   * at the dynamic getCurrentInterval cadence.
   */
  private async runHeartbeatTick(): Promise<void> {
    await this.executeTick();
  }

  private async executeTick(): Promise<HeartbeatTickResult> {
    const start = Date.now();

    // Guard: prevent overlapping ticks
    if (this.sessionManager.isTickInProgress()) {
      return {
        timestamp: start,
        success: false,
        skipped: true,
        skipReason: "Previous tick still running",
        durationMs: 0,
      };
    }

    this.sessionManager.setTickInProgress(true);

    try {
      const result = await this.executeTickWithTimeout();
      this.recordResult(result);
      return result;
    } finally {
      this.sessionManager.setTickInProgress(false);
    }
  }

  private async executeTickWithTimeout(): Promise<HeartbeatTickResult> {
    const start = Date.now();

    return Promise.race([
      this.doTick(start),
      new Promise<HeartbeatTickResult>(resolve =>
        setTimeout(
          () =>
            resolve({
              timestamp: start,
              success: false,
              skipped: false,
              durationMs: TICK_TIMEOUT_MS,
              error: "Tick timed out after 5 minutes",
            }),
          TICK_TIMEOUT_MS
        )
      ),
    ]);
  }

  private async doTick(start: number): Promise<HeartbeatTickResult> {
    // Pre-check 1: Active hours
    if (!this.isWithinActiveHours()) {
      return {
        timestamp: start,
        success: true,
        skipped: true,
        skipReason: "Outside active hours",
        durationMs: Date.now() - start,
      };
    }

    // Pre-check 2: Instructions file exists
    if (!existsSync(this.config.instructionsFile)) {
      return {
        timestamp: start,
        success: true,
        skipped: true,
        skipReason: `Instructions file not found: ${this.config.instructionsFile}`,
        durationMs: Date.now() - start,
      };
    }

    // Pre-check 3: At least one machine is online
    if (this.syncEngine.getOnlineMachines().length === 0) {
      return {
        timestamp: start,
        success: false,
        skipped: true,
        skipReason: "No online machines",
        durationMs: Date.now() - start,
      };
    }

    // Session rotation check
    if (this.sessionManager.shouldRotate(this.config)) {
      this.errorLogger?.info("Session rotation triggered", {
        category: "heartbeat",
      });
      const rotateResult = await this.sessionManager.rotate(this.config);
      if (!rotateResult.ok) {
        this.sessionManager.recordFailure();
        return {
          timestamp: start,
          success: false,
          skipped: false,
          durationMs: Date.now() - start,
          error: `Rotation failed: ${rotateResult.error}`,
        };
      }
    }

    // Ensure session is active
    const activationResult = await this.sessionManager.ensureActive(
      this.config
    );
    if (!activationResult.ok) {
      this.sessionManager.recordFailure();
      this.applyBackoff();
      return {
        timestamp: start,
        success: false,
        skipped: false,
        durationMs: Date.now() - start,
        error: `Activation failed: ${activationResult.error}`,
      };
    }

    const sessionId = this.sessionManager.getSessionId()!;

    // Register managed session to suppress default notifications
    this.notificationHub.registerManagedSession(sessionId);

    // Build and send prompt
    const prompt = await this.buildPrompt();

    // Get current message seq before sending (for reading response later)
    const sentSeq = await this.sendAndGetSeq(sessionId, prompt);
    if (sentSeq === null) {
      this.sessionManager.recordFailure();
      return {
        timestamp: start,
        success: false,
        skipped: false,
        durationMs: Date.now() - start,
        error: "Failed to send message",
      };
    }

    // Wait for response (ready event)
    const response = await this.waitForResponse(sessionId, sentSeq);

    this.sessionManager.recordTick();
    this.sessionManager.incrementBeats();
    this.sessionManager.resetFailures();
    this.sessionManager.setCurrentInterval(this.config.every); // Reset backoff

    // Evaluate response for suppression
    const isSuppressed = this.shouldSuppress(response);

    if (!isSuppressed && response) {
      // Substantive response — send push notification
      const session = this.syncEngine.getSession(sessionId);
      const namespace = session?.namespace;
      if (namespace) {
        await this.pushService.sendToNamespace(namespace, {
          title: "Heartbeat",
          body:
            response.length > 200
              ? response.substring(0, 197) + "..."
              : response,
          tag: "heartbeat-response",
          data: {
            type: "heartbeat",
            sessionId,
            url: configuration.miniAppUrl,
          },
        });
      }
    }

    return {
      timestamp: start,
      success: true,
      skipped: false,
      responseLength: response?.length ?? 0,
      suppressed: isSuppressed,
      durationMs: Date.now() - start,
    };
  }

  // ---------- Private: Prompt Construction ----------

  private async buildPrompt(): Promise<string> {
    const parts: string[] = [];

    // Drain system events
    const events = this.systemEvents.drain();
    for (const event of events) {
      const ts = new Date(event.timestamp).toISOString();
      parts.push(`System: [${ts}] ${event.description} (from ${event.source})`);
    }

    // Add standing orders reference
    parts.push("");
    parts.push(
      `Read your standing orders file at ${this.config.instructionsFile}.`
    );
    parts.push(
      "Follow the instructions strictly. Do not repeat old tasks from prior heartbeats."
    );
    parts.push("If nothing needs attention, reply HEARTBEAT_OK.");

    return parts.join("\n");
  }

  // ---------- Private: Message Send + Response ----------

  private async sendAndGetSeq(
    sessionId: string,
    text: string
  ): Promise<number | null> {
    try {
      // Get messages before sending to determine the seq boundary
      const beforeMessages = this.syncEngine.getMessagesAfter(sessionId, {
        afterSeq: 0,
        limit: 1,
      });
      // The seq of the last message before our send (or 0 if none)
      const beforeSeq =
        beforeMessages.length > 0
          ? (beforeMessages[beforeMessages.length - 1].seq ?? 0)
          : 0;

      await this.syncEngine.sendMessage(sessionId, {
        text,
        // #2205: stamp the programmatic heartbeat as "heartbeat" (not "webapp")
        // so it is distinguishable from real user input and does NOT abort a
        // pending auto-recovery (AutoRecoveryService R3).
        sentFrom: "heartbeat",
      });

      // Return the seq we sent after — responses will have seq > this
      // We use a slightly different approach: get the seq of our just-sent message
      const afterMessages = this.syncEngine.getMessagesAfter(sessionId, {
        afterSeq: beforeSeq,
        limit: 10,
      });
      const ourMessage = afterMessages.find(
        m => m.role === "user" && m.content === text
      );
      return ourMessage?.seq ?? beforeSeq;
    } catch (error) {
      this.errorLogger?.error("Failed to send message", {
        category: "heartbeat",
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return null;
    }
  }

  private async waitForResponse(
    sessionId: string,
    afterSeq: number
  ): Promise<string | null> {
    return new Promise<string | null>(resolve => {
      let resolved = false;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (this.unsubscribe) {
          this.unsubscribe();
          this.unsubscribe = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      // Subscribe to sync events for the ready signal
      this.unsubscribe = this.syncEngine.subscribe((event: SyncEvent) => {
        if (resolved) return;

        if (
          event.type === "message-received" &&
          event.sessionId === sessionId
        ) {
          const eventType = extractMessageEventType(event);
          if (eventType === "ready") {
            resolved = true;
            cleanup();

            // Read response messages
            const messages = this.syncEngine.getMessagesAfter(sessionId, {
              afterSeq,
              limit: 100,
            });

            // Extract text from Claude Code's nested message format:
            // DecryptedMessage.content = { role, content: { type: "output",
            //   data: { type: "assistant", message: { content: [{ type: "text", text }] } } } }
            const responseText = extractResponseText(messages);

            resolve(responseText || null);
          }
        }
      });

      // Timeout: 4.5 minutes (under the 5-minute tick timeout)
      timer = setTimeout(
        () => {
          if (!resolved) {
            resolved = true;
            cleanup();
            this.errorLogger?.warn(
              `Response timeout for session ${sessionId}`,
              { category: "heartbeat", sessionId }
            );
            resolve(null);
          }
        },
        4.5 * 60 * 1000
      );
    });
  }

  // ---------- Private: Response Evaluation ----------

  private shouldSuppress(response: string | null): boolean {
    if (!response) return true;

    // Suppress if response contains HEARTBEAT_OK
    if (response.includes("HEARTBEAT_OK")) return true;

    // Suppress if response is very short (under threshold)
    if (response.length <= this.config.ackMaxChars) return true;

    return false;
  }

  // ---------- Private: Active Hours ----------

  private isWithinActiveHours(): boolean {
    const { start, end, timezone } = this.config.activeHours;

    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone,
    });
    const currentHour = parseInt(formatter.format(now), 10);

    if (start < end) {
      // Normal range: e.g., 8-22
      return currentHour >= start && currentHour < end;
    } else {
      // Overnight range: e.g., 22-8
      return currentHour >= start || currentHour < end;
    }
  }

  // ---------- Private: Backoff ----------

  private applyBackoff(): void {
    const failures = this.sessionManager.getConsecutiveFailures();
    if (failures >= BACKOFF_THRESHOLD) {
      const backoffInterval = this.config.every * 2;
      this.sessionManager.setCurrentInterval(backoffInterval);
      this.errorLogger?.warn(
        `${failures} consecutive failures — backing off to ${backoffInterval / 1000}s`,
        { category: "heartbeat" }
      );
    }
  }

  // ---------- Private: History ----------

  private recordResult(result: HeartbeatTickResult): void {
    this.beatCounter++;
    const entry: HeartbeatHistoryEntry = {
      ...result,
      sessionId: this.sessionManager.getSessionId(),
      beatNumber: this.beatCounter,
    };

    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) {
      this.history.shift();
    }

    // Log significant events
    if (!result.success && !result.skipped) {
      this.errorLogger?.error(
        `Tick #${this.beatCounter} failed: ${result.error}`,
        { category: "heartbeat" }
      );
    } else if (result.success && !result.skipped) {
      const suppText = result.suppressed ? " (suppressed)" : " (notified)";
      this.errorLogger?.info(
        `Tick #${this.beatCounter} complete in ${result.durationMs}ms, ` +
          `${result.responseLength} chars${suppText}`,
        { category: "heartbeat" }
      );
    }
  }
}

// ---------- Helpers ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Extract text from Claude Code's nested message format.
 *
 * Messages from getMessagesAfter() have this structure:
 *   DecryptedMessage.content = {
 *     role: "agent",
 *     content: {
 *       type: "output",
 *       data: {
 *         type: "assistant",
 *         message: { content: string | Array<{ type: "text", text: string }> }
 *       }
 *     }
 *   }
 *
 * Mirrors the extraction logic in web/src/chat/normalizeAgent.ts.
 */
function extractResponseText(messages: Array<{ content: unknown }>): string {
  const parts: string[] = [];

  for (const m of messages) {
    const wrapper = m.content;
    if (!isObj(wrapper)) continue;

    // Top-level: { role, content: { type, data } }
    const inner = wrapper.content;
    if (!isObj(inner) || inner.type !== "output") continue;

    const data = isObj(inner.data) ? inner.data : null;
    if (!data || data.type !== "assistant") continue;

    // data.message.content holds the Anthropic-format response
    const message = isObj(data.message) ? data.message : null;
    if (!message) continue;

    const modelContent = message.content;
    if (typeof modelContent === "string") {
      parts.push(modelContent);
    } else if (Array.isArray(modelContent)) {
      for (const block of modelContent) {
        if (
          isObj(block) &&
          block.type === "text" &&
          typeof block.text === "string"
        ) {
          parts.push(block.text);
        }
      }
    }
  }

  return parts.filter(Boolean).join("\n");
}
