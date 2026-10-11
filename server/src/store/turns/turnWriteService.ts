// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorLogger } from "../../logging/errorLogger";
import type { TurnStore } from "./turnStore";
import type {
  AppendEventsInput,
  FinalizeTurnInput,
  OpenTurnInput,
} from "./types";

/** Tunable knobs (test seam). */
export interface TurnWriteServiceOptions {
  /** Attempts per op before it is dropped (default 3). */
  maxAttempts?: number;
  /** Bounded FIFO capacity; overflow drops the oldest op (default 10_000). */
  queueCap?: number;
  /** Base backoff between async retries; doubles per attempt (default 50ms). */
  backoffBaseMs?: number;
  /** Injectable clock for deterministic test timestamps (mirrors ErrorLogger). */
  getNow?: () => number;
}

type QueuedOp =
  | { kind: "open"; input: OpenTurnInput; attempts: number }
  | { kind: "finalize"; input: FinalizeTurnInput; attempts: number }
  | { kind: "appendEvents"; input: AppendEventsInput; attempts: number };

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_QUEUE_CAP = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 50;

/**
 * Fail-open write service for the per-turn telemetry tables (issue #1663).
 *
 * This is the published daemon-side write API that Sub B/C/D/E call. It exists to
 * uphold the core fail-open guarantee (R6): **a telemetry write failure never
 * blocks or crashes a session, and surfaces in the error log.**
 *
 * Why a queue rather than a synchronous try/catch (R6 rationale): the Store opens
 * with `busy_timeout=5000`, so a synchronous write could block the caller up to 5s
 * on WAL contention — unacceptable on a session request path. The bounded FIFO
 * decouples the session from the DB entirely; the actual `TurnStore` write runs on
 * a `setTimeout`-scheduled drainer off the caller's path.
 *
 * Guarantees:
 *   - Public `enqueue*` methods are SYNCHRONOUS and NEVER throw (R8).
 *   - FIFO ordering → `open` applies before `finalize` for the same turn; the
 *     partial unique index (R3) defends against replay double-insert.
 *   - Per-op bounded retry with exponential backoff; on exhaustion the op is
 *     dropped and a single attributing `turns-write` error is logged (R7). The DB
 *     is a rebuildable index (Sub F backfill), so dropping is safe.
 *   - Backpressure: a full queue drops the OLDEST op and surfaces one error
 *     (rate-limited by ErrorLogger's per-category limiter, #1141).
 *
 * In Sub A this service is constructed-but-idle (no callers enqueue yet); Sub B
 * wires the turn-open/finalize lifecycle. A graceful `flush()` runs at shutdown.
 */
export class TurnWriteService {
  private readonly queue: QueuedOp[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  private readonly maxAttempts: number;
  private readonly queueCap: number;
  private readonly backoffBaseMs: number;
  private readonly getNow: () => number;

  constructor(
    private readonly turnStore: TurnStore,
    private readonly errorLogger: ErrorLogger,
    options?: TurnWriteServiceOptions
  ) {
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.queueCap = options?.queueCap ?? DEFAULT_QUEUE_CAP;
    this.backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.getNow = options?.getNow ?? Date.now;
  }

  // ───────────────────────── public enqueue API (R8) ─────────────────────────
  // Synchronous, never-throwing. Each pushes an op and schedules a drain.

  enqueueOpenTurn(input: OpenTurnInput): void {
    this.enqueue({ kind: "open", input, attempts: 0 });
  }

  enqueueFinalizeTurn(input: FinalizeTurnInput): void {
    this.enqueue({ kind: "finalize", input, attempts: 0 });
  }

  enqueueAppendEvents(input: AppendEventsInput): void {
    this.enqueue({ kind: "appendEvents", input, attempts: 0 });
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Drain the queue synchronously (no backoff delays) — for SIGINT/SIGTERM. */
  flush(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    while (this.queue.length > 0) {
      // "retry" loops again immediately (synchronous retry, no delay); each
      // processHeadOp increments attempts, so a permanent failure drops after
      // maxAttempts and the loop always makes progress.
      this.processHeadOp();
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

  /** Current queue depth (introspection / tests). */
  get queueDepth(): number {
    return this.queue.length;
  }

  // ───────────────────────── internals ─────────────────────────

  private enqueue(op: QueuedOp): void {
    try {
      if (this.stopped) return;
      if (this.queue.length >= this.queueCap) {
        const dropped = this.queue.shift();
        this.safeLog(
          "turn write queue overflow — dropped oldest op",
          { queueCap: this.queueCap, droppedOp: dropped?.kind },
          dropped
        );
      }
      this.queue.push(op);
      this.scheduleDrain(0);
    } catch {
      // enqueue MUST NOT throw (R8) — swallow any unexpected error so the
      // calling session path is never affected.
    }
  }

  private scheduleDrain(delayMs: number): void {
    if (this.stopped) return;
    if (this.drainTimer) return; // a drain is already pending
    this.drainTimer = setTimeout(() => this.drainTick(), delayMs);
  }

  /** Scheduled drain: process ops in order; back off on a transient failure. */
  private drainTick(): void {
    this.drainTimer = null;
    while (this.queue.length > 0) {
      const outcome = this.processHeadOp();
      if (outcome === "retry") {
        const head = this.queue[0];
        const attempts = head?.attempts ?? 1;
        const backoff = this.backoffBaseMs * Math.pow(2, attempts - 1);
        this.scheduleDrain(backoff);
        return; // resume after backoff
      }
    }
  }

  /** Apply the head op once. Returns the outcome; shifts the op on apply/drop. */
  private processHeadOp(): "applied" | "dropped" | "retry" {
    const op = this.queue[0];
    if (!op) return "applied";
    try {
      this.applyOp(op);
      this.queue.shift();
      return "applied";
    } catch (error) {
      op.attempts += 1;
      if (op.attempts >= this.maxAttempts) {
        this.queue.shift();
        this.logDrop(op, error);
        return "dropped";
      }
      return "retry";
    }
  }

  private applyOp(op: QueuedOp): void {
    switch (op.kind) {
      case "open":
        this.turnStore.insertOpenTurn(op.input);
        return;
      case "finalize":
        this.turnStore.finalizeTurn(op.input);
        return;
      case "appendEvents":
        this.turnStore.appendEvents(op.input);
        return;
    }
  }

  private logDrop(op: QueuedOp, error: unknown): void {
    this.safeLog(
      `turn write dropped after ${op.attempts} attempts`,
      {
        op: op.kind,
        attempts: op.attempts,
        error: errorMessage(error),
        droppedAt: this.getNow(),
      },
      op
    );
  }

  /** errorLogger is non-throwing by contract, but wrap defensively (R8). */
  private safeLog(
    message: string,
    context: Record<string, unknown>,
    op: QueuedOp | undefined
  ): void {
    try {
      this.errorLogger.error(message, {
        category: "turns-write",
        sessionId: op ? opSessionId(op) : null,
        context,
      });
    } catch {
      // never let a logging failure surface to the drain path
    }
  }
}

/** Best-effort session id for error attribution. */
function opSessionId(op: QueuedOp): string | null {
  switch (op.kind) {
    case "open":
    case "finalize":
      return op.input.hapiSessionId;
    case "appendEvents":
      return op.input.turnId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
