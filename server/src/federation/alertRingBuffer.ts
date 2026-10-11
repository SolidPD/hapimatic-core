// SPDX-License-Identifier: AGPL-3.0-only
// Bounded in-memory federation alert store (issue #1445, Task 4).
//
// Pure, in-memory, no I/O — mirrors the `FixedWindowCounter` primitive style
// in `server/src/utils/rateLimitCounter.ts`. Retains at most `capacity` of the
// most recent alerts (default 1000), evicting oldest-first, and exposes
// cursor-paginated, newest-first reads with an optional nodeId filter.
//
// `seq` is a monotonic per-buffer counter assigned at push time; it is the
// stable cursor ordering key (timestamps can collide, seq cannot). The
// AlertGenerator (Task 6) supplies every field except `seq`.
import type { FederationAlert, FederationAlertsResponse } from "@hapi/protocol";

export const DEFAULT_ALERT_BUFFER_CAPACITY = 1000;
export const DEFAULT_ALERT_QUERY_LIMIT = 50;
export const MAX_ALERT_QUERY_LIMIT = 200;

export interface AlertQuery {
  /** Max alerts to return. Default 50, hard-capped at 200. */
  limit?: number;
  /** Numeric `seq` (as string). Returns alerts strictly older than this (seq < cursor). */
  cursor?: string;
  /** Restrict to a single node. */
  nodeId?: string;
}

function clampLimit(limit: number | undefined): number {
  const n =
    limit == null || !Number.isFinite(limit)
      ? DEFAULT_ALERT_QUERY_LIMIT
      : Math.floor(limit);
  return Math.max(1, Math.min(MAX_ALERT_QUERY_LIMIT, n));
}

export class AlertRingBuffer {
  private readonly capacity: number;
  /** Insertion order: index 0 = oldest, last = newest. */
  private readonly alerts: FederationAlert[] = [];
  private nextSeq = 1;

  constructor(capacity: number = DEFAULT_ALERT_BUFFER_CAPACITY) {
    this.capacity =
      Number.isFinite(capacity) && capacity > 0
        ? Math.floor(capacity)
        : DEFAULT_ALERT_BUFFER_CAPACITY;
  }

  /**
   * Append a new alert, assigning the next monotonic `seq`. Evicts the oldest
   * entry when capacity is exceeded. Returns the stored alert (with `seq`).
   */
  push(alert: Omit<FederationAlert, "seq">): FederationAlert {
    const stored: FederationAlert = { ...alert, seq: this.nextSeq++ };
    this.alerts.push(stored);
    if (this.alerts.length > this.capacity) {
      this.alerts.shift(); // evict oldest-first
    }
    return stored;
  }

  /**
   * Newest-first page. `cursor` (a prior `nextCursor`) returns alerts strictly
   * older than that seq. `nextCursor` is the oldest returned alert's seq when
   * more (older) alerts remain, else null.
   */
  query(opts: AlertQuery = {}): FederationAlertsResponse {
    const limit = clampLimit(opts.limit);

    const cursorSeq =
      opts.cursor != null && opts.cursor !== "" ? Number(opts.cursor) : null;
    const hasCursor = cursorSeq != null && Number.isFinite(cursorSeq);

    // Newest-first.
    let candidates = this.alerts.slice().reverse();
    if (opts.nodeId) {
      candidates = candidates.filter(a => a.nodeId === opts.nodeId);
    }
    if (hasCursor) {
      candidates = candidates.filter(a => a.seq < (cursorSeq as number));
    }

    const page = candidates.slice(0, limit);
    // More (older) alerts remain beyond this page → expose the oldest returned
    // seq as the next cursor; otherwise null.
    const nextCursor =
      candidates.length > page.length && page.length > 0
        ? String(page[page.length - 1].seq)
        : null;

    return { alerts: page, nextCursor };
  }

  /** Number of retained alerts. */
  get size(): number {
    return this.alerts.length;
  }

  /** Test/diagnostic helper — drop all retained alerts. */
  clear(): void {
    this.alerts.length = 0;
  }
}
