// SPDX-License-Identifier: MIT AND AGPL-3.0-only
/**
 * Outgoing Message Queue with strict ordering using incremental IDs
 *
 * Ensures messages are always sent in the order they were received,
 * while allowing delayed messages to be released early when needed.
 *
 * Issue #922: Removed AsyncLock — all operations are synchronous.
 * JavaScript is single-threaded, so no concurrent mutations are possible
 * within a single event loop turn. The previous async lock caused a
 * fire-and-forget race in enqueue() where items were pushed AFTER
 * processQueue() had already run.
 */

import type { RawJSONLines } from "@/claude/types";
import { logger } from "@/ui/logger";

/** Maximum time (ms) an unreleased item can block the queue head. */
const SAFETY_VALVE_TIMEOUT_MS = 2000;

interface QueueItem {
  id: number; // Incremental ID for ordering
  logMessage: RawJSONLines;
  delayed: boolean; // Whether this message should be delayed
  delayMs: number; // Delay duration (e.g., 250ms)
  toolCallIds?: string[]; // Tool calls to track for early release
  released: boolean; // Whether delay has been released
  sent: boolean; // Whether message has been sent
  enqueuedAt: number; // Timestamp for safety valve timeout
}

export class OutgoingMessageQueue {
  private queue: QueueItem[] = [];
  private nextId = 1;
  private processTimer?: NodeJS.Timeout;
  private safetyValveTimer?: NodeJS.Timeout;
  private delayTimers = new Map<number, NodeJS.Timeout>();

  constructor(private sendFunction: (message: RawJSONLines) => void) {}

  /**
   * Add message to queue (synchronous — no lock needed)
   */
  enqueue(
    logMessage: RawJSONLines,
    options?: {
      delay?: number;
      toolCallIds?: string[];
    }
  ): void {
    const item: QueueItem = {
      id: this.nextId++,
      logMessage,
      delayed: !!options?.delay,
      delayMs: options?.delay || 0,
      toolCallIds: options?.toolCallIds,
      released: !options?.delay, // Not delayed = already released
      sent: false,
      enqueuedAt: Date.now(),
    };

    this.queue.push(item);

    // If delayed, set timer to release it
    if (item.delayed) {
      const timer = setTimeout(() => {
        this.releaseItem(item.id);
      }, item.delayMs);
      this.delayTimers.set(item.id, timer);
    }

    // Try to process queue
    this.scheduleProcessing();
  }

  /**
   * Release specific item by ID (synchronous)
   */
  private releaseItem(itemId: number): void {
    const item = this.queue.find(i => i.id === itemId);
    if (item && !item.released) {
      item.released = true;
      logger.debug(
        `[OutgoingMessageQueue] releaseItem: id=${itemId} found=true`
      );

      // Clear timer if exists
      const timer = this.delayTimers.get(itemId);
      if (timer) {
        clearTimeout(timer);
        this.delayTimers.delete(itemId);
      }
    } else {
      logger.debug(
        `[OutgoingMessageQueue] releaseItem: id=${itemId} ` +
          `found=${!!item} alreadyReleased=${item?.released ?? "N/A"}`
      );
    }

    this.scheduleProcessing();
  }

  /**
   * Release all messages with specific tool call ID (synchronous)
   */
  releaseToolCall(toolCallId: string): void {
    let releasedCount = 0;
    for (const item of this.queue) {
      if (item.toolCallIds?.includes(toolCallId) && !item.released) {
        item.released = true;
        releasedCount++;

        // Clear timer if exists
        const timer = this.delayTimers.get(item.id);
        if (timer) {
          clearTimeout(timer);
          this.delayTimers.delete(item.id);
        }
      }
    }

    logger.debug(
      `[OutgoingMessageQueue] releaseToolCall: toolCallId=${toolCallId} ` +
        `released=${releasedCount} queueLen=${this.queue.length}`
    );

    this.scheduleProcessing();
  }

  /**
   * Process queue - send messages in ID order that are released
   */
  private processQueueInternal(): void {
    // Sort by ID to ensure order
    this.queue.sort((a, b) => a.id - b.id);

    // Process from front of queue
    while (this.queue.length > 0) {
      const item = this.queue[0];

      // If not released yet, check safety valve before blocking
      if (!item.released) {
        const age = Date.now() - item.enqueuedAt;
        if (age > SAFETY_VALVE_TIMEOUT_MS) {
          logger.warn(
            `[OutgoingMessageQueue] Force-releasing stuck item id=${item.id} ` +
              `age=${age}ms delayed=${item.delayed} ` +
              `toolCallIds=${item.toolCallIds?.join(",") ?? "none"}`
          );
          item.released = true;
        } else {
          // Schedule a re-check when the safety valve would fire
          if (!this.safetyValveTimer) {
            const remaining = SAFETY_VALVE_TIMEOUT_MS - age + 1;
            this.safetyValveTimer = setTimeout(() => {
              this.safetyValveTimer = undefined;
              this.processQueue();
            }, remaining);
          }
          logger.debug(
            `[OutgoingMessageQueue] Head-of-line block: id=${item.id} ` +
              `age=${age}ms queueLen=${this.queue.length}`
          );
          break;
        }
      }

      // Send if not already sent
      if (!item.sent) {
        const sendMsg = item.logMessage as Record<string, unknown>;
        const isRelayableSystem =
          sendMsg.type === "system" && sendMsg.subtype === "result";
        if (sendMsg.type !== "system" || isRelayableSystem) {
          const dwellMs = Date.now() - item.enqueuedAt;
          if (dwellMs > 500) {
            logger.warn(
              `[OutgoingMessageQueue] Slow send: id=${item.id} ` +
                `type=${sendMsg.type} dwellMs=${dwellMs} ` +
                `delayed=${item.delayed}`
            );
          }
          this.sendFunction(item.logMessage);
        }
        item.sent = true;
      }

      // Remove from queue
      this.queue.shift();
    }
  }

  /**
   * Process queue (synchronous wrapper)
   */
  private processQueue(): void {
    this.processQueueInternal();
  }

  /**
   * Flush all messages immediately (for cleanup — synchronous)
   */
  flush(): void {
    // Clear processTimer to prevent double-send (Issue #952 code review finding)
    if (this.processTimer) {
      clearTimeout(this.processTimer);
      this.processTimer = undefined;
    }

    // Clear all delay timers and safety valve
    for (const timer of this.delayTimers.values()) {
      clearTimeout(timer);
    }
    this.delayTimers.clear();
    if (this.safetyValveTimer) {
      clearTimeout(this.safetyValveTimer);
      this.safetyValveTimer = undefined;
    }

    // Mark all as released
    for (const item of this.queue) {
      item.released = true;
    }

    logger.debug(
      `[OutgoingMessageQueue] flush: releasing ${this.queue.length} items`
    );

    // Process everything
    this.processQueueInternal();
  }

  /**
   * Schedule processing on next tick
   */
  private scheduleProcessing(): void {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }

    this.processTimer = setTimeout(() => {
      this.processQueue();
    }, 0);
  }

  /**
   * Cleanup timers and resources
   */
  destroy(): void {
    if (this.processTimer) {
      clearTimeout(this.processTimer);
    }
    if (this.safetyValveTimer) {
      clearTimeout(this.safetyValveTimer);
      this.safetyValveTimer = undefined;
    }

    for (const timer of this.delayTimers.values()) {
      clearTimeout(timer);
    }
    this.delayTimers.clear();
  }
}
