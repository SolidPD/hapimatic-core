// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorLogger } from "../../../logging/errorLogger";
import type { StoredMessage } from "../../../store";

/** ErrorLogger category for every log line the `message` write path emits (#3631). */
export const MESSAGE_WRITE_CATEGORY = "socket-message-write";

/** Tunable knobs (test seam) — mirrors `TurnWriteServiceOptions`. */
export interface MessageWriteRetryQueueOptions {
  /** Deferred attempts per message before it is dropped (default 5). */
  maxAttempts?: number;
  /** Bounded FIFO capacity; overflow drops the oldest op (default 10_000). */
  queueCap?: number;
  /** Base backoff before/between deferred attempts; doubles per attempt (default 50ms). */
  backoffBaseMs?: number;
  /** Injectable clock for deterministic test timestamps (mirrors ErrorLogger). */
  getNow?: () => number;
}

/** One deferred message write handed over by the `socket.on("message")` guard. */
export type DeferredMessageWrite = {
  /** Session the message belongs to — error attribution only. */
  sid: string;
  /** Client idempotency key; `addMessage` dedups on `(session_id, local_id)`. */
  localId: string | null;
  /** Re-invokes `store.messages.addMessage` with the ORIGINAL arguments. */
  write: () => StoredMessage;
  /** Emits the `update` broadcast + `message-received` event for the LANDED row. */
  publish: (msg: StoredMessage) => void;
};

type QueuedOp = DeferredMessageWrite & { attempts: number; enqueuedAt: number };

// 3 mirrors TurnWriteService and bounds the worst-case event-loop hold: every
// deferred attempt can itself sleep up to busy_timeout (5 s) on the single JS
// thread, so 3 attempts = ≤15 s of tolerance for a persistently held lock.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_QUEUE_CAP = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 50;

/**
 * True when `error` is SQLite's SQLITE_BUSY — primary result code 5, "the database
 * file is locked" by a SEPARATE connection (a same-connection conflict would be
 * SQLITE_LOCKED, 6). Matches bun:sqlite's `SQLiteError` shape (`code`) AND the
 * message, because the repo's existing simulation idiom throws a plain
 * `Error("SQLITE_BUSY: database is locked")` (syncEngine.fileClaims.test.ts).
 */
export function isSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown };
  if (e.code === "SQLITE_BUSY") return true;
  const message = typeof e.message === "string" ? e.message : "";
  return /SQLITE_BUSY|database is locked/i.test(message);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Structured fields worth persisting for attribution (#3631 Task 1): the next
 * SQLITE_BUSY must leave `code`/`errno` in `error_logs` instead of a process exit.
 */
export function sqliteErrorContext(error: unknown): Record<string, unknown> {
  const e = (error && typeof error === "object" ? error : {}) as {
    code?: unknown;
    errno?: unknown;
  };
  return {
    error: errorMessage(error),
    code: typeof e.code === "string" ? e.code : null,
    errno: typeof e.errno === "number" ? e.errno : null,
  };
}

/**
 * Deferred re-attempt queue for a `socket.on("message")` store write that hit
 * SQLITE_BUSY (issue #3631, ruling D1). Modelled on `TurnWriteService`
 * (`store/turns/turnWriteService.ts`), the house deferral pattern.
 *
 * Why a queue and not a synchronous retry loop: `addMessage` runs BEGIN IMMEDIATE on
 * a connection with `busy_timeout = 5000`, so every blocking attempt can sleep the
 * single Bun JS thread for up to 5 s. The listener is allowed exactly ONE such
 * attempt; anything further runs here on a `setTimeout`-scheduled drainer, off the
 * socket path, with exponential backoff.
 *
 * Why the broadcast lives here: `addMessage` returns the persisted `seq`/`id`/
 * `createdAt` that the `update` broadcast and the `message-received` event carry.
 * A deferred write therefore publishes FROM THE DRAINER, with the real row — never a
 * fabricated seq — and the client-supplied `localId` makes the re-attempt idempotent
 * (`messages.ts` dedups on `(session_id, local_id)`).
 *
 * Guarantees:
 *   - `enqueue` is SYNCHRONOUS and NEVER throws.
 *   - FIFO per process; bounded capacity drops the OLDEST op and logs once.
 *   - Only SQLITE_BUSY is retried; any other write error drops immediately (it is
 *     not transient) and is logged with `code`/`errno`.
 *   - Every drop/failure is logged through `ErrorLogger.error` under
 *     `MESSAGE_WRITE_CATEGORY` (rate-limited per category, #1141) — never silently.
 *   - `flush()` drains synchronously at shutdown (ONE attempt per op); `stop()`
 *     refuses further work.
 *   - Ordering: a deferred message lands AFTER any same-session message that
 *     arrived during the hold (seq is assigned by the landed write). When it
 *     carries `meta.generatedAt`, the #952 late-arrival branch re-seqs it and
 *     bumps the later row; that bump is not re-broadcast (pre-existing #952
 *     behaviour; clients converge on their next fetch).
 *   - Each deferred attempt still runs on the single JS thread and can sleep up
 *     to busy_timeout — "off the socket path" means off the listener callback,
 *     not off the thread. Attempts are bounded (maxAttempts) for that reason.
 */
export class MessageWriteRetryQueue {
  private readonly queue: QueuedOp[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Set during flush(): one attempt per op, any failure drops (shutdown budget). */
  private flushing = false;

  private readonly maxAttempts: number;
  private readonly queueCap: number;
  private readonly backoffBaseMs: number;
  private readonly getNow: () => number;

  constructor(
    private readonly errorLogger: ErrorLogger | null,
    options?: MessageWriteRetryQueueOptions
  ) {
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.queueCap = options?.queueCap ?? DEFAULT_QUEUE_CAP;
    this.backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.getNow = options?.getNow ?? Date.now;
  }

  /** Synchronous, never-throwing: push the op and schedule the first deferred attempt. */
  enqueue(op: DeferredMessageWrite): void {
    try {
      if (this.stopped) {
        // Shutdown: console-only — a persisted row could block the exit path.
        this.safeLog(
          "error",
          "message write retry refused — queue stopped (shutdown)",
          op,
          { localId: op.localId },
          false
        );
        return;
      }
      if (this.queue.length >= this.queueCap) {
        const dropped = this.queue.shift();
        this.safeLog(
          "error",
          "message write retry queue overflow — dropped oldest message",
          dropped,
          { queueCap: this.queueCap, localId: dropped?.localId ?? null }
        );
      }
      this.queue.push({ ...op, attempts: 0, enqueuedAt: this.getNow() });
      // The lock was observed held a moment ago — wait one backoff step before the
      // first re-attempt rather than re-blocking the event loop immediately.
      this.scheduleDrain(this.backoffBaseMs);
    } catch {
      // enqueue MUST NOT throw — the calling socket listener is never affected.
    }
  }

  /**
   * Drain the queue synchronously — for SIGINT/SIGTERM. ONE attempt per op: a lock
   * that was held moments ago is unlikely to be free now, each attempt can sleep
   * up to busy_timeout, and systemd's stop timeout is finite — blocking shutdown
   * on retries gains nothing. A failed op is dropped and logged (console-only).
   */
  flush(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        this.processHeadOp(); // never "retry" while flushing — always shifts
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Cancel the scheduled drain and refuse further enqueues. */
  stop(): void {
    this.stopped = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }

  /** Current queue depth (introspection / tests / log context). */
  get queueDepth(): number {
    return this.queue.length;
  }

  private scheduleDrain(delayMs: number): void {
    if (this.stopped) return;
    if (this.drainTimer) return; // a drain is already pending
    this.drainTimer = setTimeout(() => this.drainTick(), delayMs);
  }

  /**
   * Scheduled drain: ONE op per tick, then yield. Each attempt can sleep the JS
   * thread up to busy_timeout and each publish fans out to every client, so the
   * event loop gets a turn between ops instead of the whole backlog running in
   * one synchronous burst. A busy write backs off; anything else re-arms at 0.
   */
  private drainTick(): void {
    this.drainTimer = null;
    const outcome = this.processHeadOp();
    if (this.queue.length === 0) return;
    if (outcome === "retry") {
      const head = this.queue[0];
      const attempts = head?.attempts ?? 1;
      const backoff = this.backoffBaseMs * Math.pow(2, attempts - 1);
      this.scheduleDrain(backoff);
      return; // resume after backoff
    }
    this.scheduleDrain(0); // yield, then continue with the next op
  }

  /** Apply the head op once. Shifts the op on apply/drop; leaves it on retry. */
  private processHeadOp(): "applied" | "dropped" | "retry" {
    const op = this.queue[0];
    if (!op) return "applied";
    let msg: StoredMessage;
    try {
      msg = op.write();
    } catch (error) {
      op.attempts += 1;
      const busy = isSqliteBusy(error);
      if (busy && op.attempts < this.maxAttempts && !this.flushing) {
        return "retry";
      }
      this.queue.shift();
      // Terminal drop = user-visible data loss: persist the row (bounded: if the
      // lock is still held this INSERT waits up to busy_timeout once more) —
      // except during shutdown flush, where the exit path must not block.
      this.safeLog(
        "error",
        `message write dropped after ${op.attempts} deferred attempt(s): ${errorMessage(error)}`,
        op,
        {
          ...sqliteErrorContext(error),
          attempts: op.attempts,
          retryable: busy,
          flushing: this.flushing,
          localId: op.localId,
          enqueuedAt: op.enqueuedAt,
          droppedAt: this.getNow(),
        },
        !this.flushing
      );
      return "dropped";
    }
    this.queue.shift();
    // Every queued op exists because the listener's blocking attempt failed.
    // The write just succeeded, so the lock is free: this is the moment to
    // persist the durable record of the contention event (the listener's own
    // deferral log was console-only because the lock was still held).
    this.safeLog(
      "warn",
      `deferred message write landed with seq ${msg.seq} after ${op.attempts} failed deferred attempt(s)`,
      op,
      {
        attempts: op.attempts,
        localId: op.localId,
        messageId: msg.id,
        seq: msg.seq,
        enqueuedAt: op.enqueuedAt,
        landedAt: this.getNow(),
      }
    );
    try {
      op.publish(msg);
    } catch (error) {
      // The row is persisted; a publish failure (e.g. an ancillary index write) must
      // not re-queue the message — clients converge on their next fetch/poll.
      this.safeLog(
        "warn",
        `deferred message write landed (seq ${msg.seq}) but publish failed: ${errorMessage(error)}`,
        op,
        { ...sqliteErrorContext(error), messageId: msg.id, seq: msg.seq }
      );
    }
    return "applied";
  }

  /** errorLogger is non-throwing by contract, but wrap defensively. */
  private safeLog(
    severity: "error" | "warn",
    message: string,
    op: DeferredMessageWrite | undefined,
    context: Record<string, unknown>,
    persist = true
  ): void {
    try {
      this.errorLogger?.[severity](message, {
        category: MESSAGE_WRITE_CATEGORY,
        sessionId: op?.sid ?? null,
        context,
        persist,
      });
    } catch {
      // never let a logging failure surface to the drain path
    }
  }
}
