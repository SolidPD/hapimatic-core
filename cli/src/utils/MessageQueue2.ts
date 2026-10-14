// SPDX-License-Identifier: MIT AND AGPL-3.0-only
import { logger } from "@/ui/logger";

interface QueueItem<T> {
  message: string;
  mode: T;
  modeHash: string;
  isolate?: boolean; // If true, this message must be processed alone
}

/**
 * A mode-aware message queue that stores messages with their modes.
 * Returns consistent batches of messages with the same mode.
 */
export class MessageQueue2<T> {
  public queue: QueueItem<T>[] = []; // Made public for testing
  private waiter: ((hasMessages: boolean) => void) | null = null;
  private closed = false;
  private onMessageHandler: ((message: string, mode: T) => void) | null = null;
  modeHasher: (mode: T) => string;

  constructor(
    modeHasher: (mode: T) => string,
    onMessageHandler: ((message: string, mode: T) => void) | null = null
  ) {
    this.modeHasher = modeHasher;
    this.onMessageHandler = onMessageHandler;
    logger.debug(`[MessageQueue2] Initialized`);
  }

  /**
   * Set a handler that will be called when a message arrives
   */
  setOnMessage(handler: ((message: string, mode: T) => void) | null): void {
    this.onMessageHandler = handler;
  }

  /**
   * Push a message to the queue with a mode.
   */
  push(message: string, mode: T): void {
    if (this.closed) {
      throw new Error("Cannot push to closed queue");
    }

    const modeHash = this.modeHasher(mode);
    logger.debug(`[MessageQueue2] push() called with mode hash: ${modeHash}`);

    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: false,
    });

    // Trigger message handler if set
    if (this.onMessageHandler) {
      this.onMessageHandler(message, mode);
    }

    // Notify waiter if any
    if (this.waiter) {
      logger.debug(`[MessageQueue2] Notifying waiter`);
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }

    logger.debug(
      `[MessageQueue2] push() completed. Queue size: ${this.queue.length}`
    );
  }

  /**
   * Push a message immediately without batching delay.
   * Does not clear the queue or enforce isolation.
   */
  pushImmediate(message: string, mode: T): void {
    if (this.closed) {
      throw new Error("Cannot push to closed queue");
    }

    const modeHash = this.modeHasher(mode);
    logger.debug(
      `[MessageQueue2] pushImmediate() called with mode hash: ${modeHash}`
    );

    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: false,
    });

    // Trigger message handler if set
    if (this.onMessageHandler) {
      this.onMessageHandler(message, mode);
    }

    // Notify waiter if any
    if (this.waiter) {
      logger.debug(`[MessageQueue2] Notifying waiter for immediate message`);
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }

    logger.debug(
      `[MessageQueue2] pushImmediate() completed. Queue size: ${this.queue.length}`
    );
  }

  /**
   * Push a message that must be processed in complete isolation.
   * Clears any pending messages and ensures this message is never batched with others.
   * Used for special commands that require dedicated processing.
   */
  pushIsolateAndClear(message: string, mode: T): void {
    if (this.closed) {
      throw new Error("Cannot push to closed queue");
    }

    const modeHash = this.modeHasher(mode);
    logger.debug(
      `[MessageQueue2] pushIsolateAndClear() called with mode hash: ${modeHash} - clearing ${this.queue.length} pending messages`
    );

    // Clear any pending messages to ensure this message is processed in complete isolation
    this.queue = [];

    this.queue.push({
      message,
      mode,
      modeHash,
      isolate: true,
    });

    // Trigger message handler if set
    if (this.onMessageHandler) {
      this.onMessageHandler(message, mode);
    }

    // Notify waiter if any
    if (this.waiter) {
      logger.debug(`[MessageQueue2] Notifying waiter for isolated message`);
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }

    logger.debug(
      `[MessageQueue2] pushIsolateAndClear() completed. Queue size: ${this.queue.length}`
    );
  }

  /**
   * Push a message to the beginning of the queue with a mode.
   *
   * Issue #2346: `opts.isolate` (default false) marks the message as an isolate
   * boundary — the relaunch fence (`claudeRemoteLauncher.ts`,
   * `... || msg.isolate`) always re-spawns the query for it, independent of the
   * mode hash. PLAN_FAKE_RESTART uses this so the ExitPlanMode approve→execute
   * flow keeps relaunching out of plan mode after `isPlan` was dropped from the
   * mode hasher (removing the hasher's isPlan flip that previously forced it).
   */
  unshift(message: string, mode: T, opts?: { isolate?: boolean }): void {
    if (this.closed) {
      throw new Error("Cannot unshift to closed queue");
    }

    const modeHash = this.modeHasher(mode);
    logger.debug(
      `[MessageQueue2] unshift() called with mode hash: ${modeHash}`
    );

    this.queue.unshift({
      message,
      mode,
      modeHash,
      isolate: opts?.isolate ?? false,
    });

    // Trigger message handler if set
    if (this.onMessageHandler) {
      this.onMessageHandler(message, mode);
    }

    // Notify waiter if any
    if (this.waiter) {
      logger.debug(`[MessageQueue2] Notifying waiter`);
      const waiter = this.waiter;
      this.waiter = null;
      waiter(true);
    }

    logger.debug(
      `[MessageQueue2] unshift() completed. Queue size: ${this.queue.length}`
    );
  }

  /**
   * Reset the queue - clears all messages and resets to empty state
   */
  reset(): void {
    logger.debug(
      `[MessageQueue2] reset() called. Clearing ${this.queue.length} messages`
    );
    this.queue = [];
    this.closed = false;

    // Resolve any in-flight waiter to prevent zombie promises
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(false);
    }
  }

  /**
   * Close the queue - no more messages can be pushed
   */
  close(): void {
    logger.debug(`[MessageQueue2] close() called`);
    this.closed = true;

    // Notify any waiting caller
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(false);
    }
  }

  /**
   * Check if the queue is closed
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Get the current queue size
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * #1701: Remove and return ALL currently-queued items in FIFO order, leaving
   * the queue empty. Used by the push-driven launchers (tmux/pty) to flush
   * messages buffered before Claude's TUI became ready — the readiness gate
   * holds delivery until SessionStart, then drains here. Synchronous and
   * non-blocking (distinct from the waitFor* pull methods, which block for a
   * batch). Does NOT fire the onMessage handler — the caller submits each item.
   */
  drainAll(): { message: string; mode: T }[] {
    const items = this.queue.map(i => ({ message: i.message, mode: i.mode }));
    this.queue = [];
    return items;
  }

  /**
   * Wait for messages and return all messages with the same mode as a single string
   * Returns { message: string, mode: T } or null if aborted/closed
   * @deprecated Use waitForSingleMessage() instead — batching violates queue semantics
   */
  async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{
    message: string;
    mode: T;
    isolate: boolean;
    hash: string;
  } | null> {
    // If we have messages, return them immediately
    if (this.queue.length > 0) {
      return this.collectBatch();
    }

    // If closed or already aborted, return null
    if (this.closed || abortSignal?.aborted) {
      return null;
    }

    // Wait for messages to arrive
    const hasMessages = await this.waitForMessages(abortSignal);

    if (!hasMessages) {
      return null;
    }

    return this.collectBatch();
  }

  /**
   * Wait for a single message and return it without batching.
   * Each queued message becomes its own Claude turn, preserving queue semantics.
   * Returns { message: string, mode: T } or null if aborted/closed
   */
  async waitForSingleMessage(
    abortSignal?: AbortSignal,
    onWaitStarted?: () => void
  ): Promise<{
    message: string;
    mode: T;
    isolate: boolean;
    hash: string;
  } | null> {
    // If we have messages, return the first one immediately
    if (this.queue.length > 0) {
      return this.shiftOne();
    }

    // If closed or already aborted, return null
    if (this.closed || abortSignal?.aborted) {
      return null;
    }

    // Queue is empty — notify caller that we're about to block
    if (onWaitStarted) {
      onWaitStarted();
    }

    // Wait for messages to arrive
    const hasMessages = await this.waitForMessages(abortSignal);

    if (!hasMessages) {
      return null;
    }

    return this.shiftOne();
  }

  /**
   * Shift exactly one message from the front of the queue
   */
  private shiftOne(): {
    message: string;
    mode: T;
    hash: string;
    isolate: boolean;
  } | null {
    if (this.queue.length === 0) {
      return null;
    }

    const item = this.queue.shift()!;
    logger.debug(
      `[MessageQueue2] shiftOne() returned 1 message with mode hash: ${item.modeHash}, remaining: ${this.queue.length}`
    );

    return {
      message: item.message,
      mode: item.mode,
      hash: item.modeHash,
      isolate: item.isolate ?? false,
    };
  }

  /**
   * Collect a batch of messages with the same mode, respecting isolation requirements
   */
  private collectBatch(): {
    message: string;
    mode: T;
    hash: string;
    isolate: boolean;
  } | null {
    if (this.queue.length === 0) {
      return null;
    }

    const firstItem = this.queue[0];
    const sameModeMessages: string[] = [];
    let mode = firstItem.mode;
    let isolate = firstItem.isolate ?? false;
    const targetModeHash = firstItem.modeHash;

    // If the first message requires isolation, only process it alone
    if (firstItem.isolate) {
      const item = this.queue.shift()!;
      sameModeMessages.push(item.message);
      logger.debug(
        `[MessageQueue2] Collected isolated message with mode hash: ${targetModeHash}`
      );
    } else {
      // Collect all messages with the same mode until we hit an isolated message
      while (
        this.queue.length > 0 &&
        this.queue[0].modeHash === targetModeHash &&
        !this.queue[0].isolate
      ) {
        const item = this.queue.shift()!;
        sameModeMessages.push(item.message);
      }
      logger.debug(
        `[MessageQueue2] Collected batch of ${sameModeMessages.length} messages with mode hash: ${targetModeHash}`
      );
    }

    // Join all messages with newlines
    const combinedMessage = sameModeMessages.join("\n");

    return {
      message: combinedMessage,
      mode,
      hash: targetModeHash,
      isolate,
    };
  }

  /**
   * Wait for messages to arrive
   */
  private waitForMessages(abortSignal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;
      let abortHandler: (() => void) | null = null;
      let waiterFunc: (hasMessages: boolean) => void;

      const finish = (hasMessages: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (this.waiter === waiterFunc) {
          this.waiter = null;
        }
        // Clean up abort handler
        if (abortHandler && abortSignal) {
          abortSignal.removeEventListener("abort", abortHandler);
        }
        resolve(hasMessages);
      };

      waiterFunc = (hasMessages: boolean) => {
        finish(hasMessages);
      };

      // Set up abort handler
      if (abortSignal) {
        abortHandler = () => {
          logger.debug("[MessageQueue2] Wait aborted");
          finish(false);
        };
        abortSignal.addEventListener("abort", abortHandler);
      }

      // Set the waiter before checking the queue to avoid missed notifications
      this.waiter = waiterFunc;

      // Check again in case messages arrived or queue closed while setting up
      if (this.queue.length > 0) {
        finish(true);
        return;
      }

      if (this.closed || abortSignal?.aborted) {
        finish(false);
        return;
      }

      logger.debug("[MessageQueue2] Waiting for messages...");
    });
  }
}
