// SPDX-License-Identifier: AGPL-3.0-only
/**
 * System Events Queue
 *
 * In-memory FIFO queue for cross-cutting events that should be included
 * in the next heartbeat prompt. Events are ephemeral — consumed on drain,
 * lost on server restart. This is by design: sources (cron, webhooks) will
 * re-fire on their schedule.
 *
 * Integration point for #310 (Scheduled Task Execution Engine):
 *   systemEvents.enqueue({ source: "cron", description: "..." })
 */

import type { SystemEvent } from "./types";

const DEFAULT_MAX_SIZE = 100;

export class SystemEventQueue {
  private readonly queue: SystemEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /** Add an event to the queue. Oldest events are discarded on overflow. */
  enqueue(event: SystemEvent): void {
    if (this.queue.length >= this.maxSize) {
      this.queue.shift();
    }
    this.queue.push(event);
  }

  /** Remove and return all events (FIFO order). Queue is empty after this call. */
  drain(): SystemEvent[] {
    return this.queue.splice(0);
  }

  /** Peek at queued events without consuming them. */
  peek(): readonly SystemEvent[] {
    return this.queue;
  }

  /** Current number of queued events. */
  size(): number {
    return this.queue.length;
  }

  /** Discard all queued events. */
  clear(): void {
    this.queue.length = 0;
  }
}
