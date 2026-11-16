// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorLogger, ErrorLogOptions } from "../logging/errorLogger";
import {
  errorMessage,
  isSqliteBusy,
  sqliteErrorContext,
} from "../socket/handlers/cli/messageWriteRetryQueue";
import type {
  CloseIntervalInput,
  CloseIntervalResult,
  LegacyStretchRow,
  OpenIntervalRow,
} from "../store/billable/intervalStore";
import { newUuidV7 } from "../store/turns/ids";

/**
 * The interval write service (issue #6586, R21): one FIFO queue between the
 * session cache and the interval store, so interval writes run off the socket
 * listener path and never throw into it.
 *
 * Unlike `TurnWriteService` and `MessageWriteRetryQueue`, which drop an op after
 * three attempts, these rows are not rebuildable from transcripts, so an open, a
 * close or a stretch row is never dropped for a busy or full store or by the cap.
 * Three retry classes, from the error the store call throws:
 * 1. a busy or full store: retried with capped backoff, without limit;
 * 2. an error every op would hit (a missing table or column, an I/O, corrupt,
 *    read-only or unopenable database): the whole queue is kept, the head retried,
 *    and ONE persisted alarm raised (again only after an op has landed);
 * 3. an error of this op alone: three attempts, then the op is set aside with one
 *    persisted error and never replayed, so it cannot block the ops behind it.
 *
 * Touches are the only ops the cap drops. Every persisted log is raised from the
 * drainer, never from an `enqueue*` call, which runs on the socket listener path
 * where a persisted log can wait up to `busy_timeout`.
 */

const CATEGORY = "billable-intervals";
const DEFAULT_QUEUE_CAP = 50_000;
const DEFAULT_BACKOFF_BASE_MS = 50;
const DEFAULT_BACKOFF_CAP_MS = 30_000;
const DEFAULT_OP_MAX_ATTEMPTS = 3;
const DEFAULT_FLUSH_BUDGET_MS = 10_000;
const SLOW_WRITE_MS = 250;
const BUSY_LOG_INTERVAL_MS = 60_000;

const TABLE_WIDE_CODE_PREFIXES = [
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_READONLY",
  "SQLITE_CANTOPEN",
];

/** The store methods the service calls (structural, so tests can pass a fake). */
export interface IntervalWriteStore {
  openInterval(
    row: OpenIntervalRow,
    options: { recomputeTimer: boolean }
  ): unknown;
  closeInterval(input: CloseIntervalInput): CloseIntervalResult;
  touchLastSeen(id: string, ms: number): void;
  recordLegacyStretch(row: LegacyStretchRow): void;
  /** Add to the stored lost-write totals (#6670); a direct call, never queued. */
  addLostWrites(input: {
    setAside: number;
    leftAtStop: number;
    nowMs: number;
  }): void;
  /** The interval change counter (#6670 X1); optional so a fake store need not have it. */
  readChangeSeq?(): number;
}

export type IntervalWriteLogger = Pick<ErrorLogger, "error" | "warn">;

export interface CloseLandedReport {
  sessionId: string;
  sessionTotalMs: number;
  /** True while another close of the same session is still queued. */
  laterCloseQueued: boolean;
}

export interface IntervalWriteServiceOptions {
  onCloseLanded?: (report: CloseLandedReport) => void;
  queueCap?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  opMaxAttempts?: number;
  flushBudgetMs?: number;
  getNow?: () => number;
}

export interface IntervalWriteCounters {
  opensEnqueued: number;
  opensLanded: number;
  closesEnqueued: number;
  closesLanded: number;
  depth: number;
  oldestOpAgeMs: number;
  setAsideCount: number;
  /** Fixed when this service is built, once per server process (#6670). */
  bootId: string;
  /** Fixed when this service is built, once per server process (#6670). */
  bootStartedAtMs: number;
  /**
   * The interval change counter when this process started (#6670 X1): a row
   * whose `change_seq` is at or below it was closed by an earlier process. Null
   * when the store cannot read it.
   */
  bootChangeSeq: number | null;
  /** Set-asides counted in memory whose stored-total write has not landed yet (#6670). */
  pendingSetAside: number;
}

type QueuedOp =
  | {
      kind: "open";
      sessionId: string;
      intervalId: string;
      row: OpenIntervalRow;
      recomputeTimer: boolean;
    }
  | {
      kind: "close";
      sessionId: string;
      intervalId: string;
      input: CloseIntervalInput;
    }
  | {
      kind: "stretch";
      sessionId: string;
      intervalId: null;
      row: LegacyStretchRow;
    }
  | { kind: "touch"; sessionId: null; intervalId: string; ms: number };

type Queued = QueuedOp & {
  enqueuedAt: number;
  ownAttempts: number;
  busyAttempts: number;
};

type ErrorClass = "busy" | "table" | "own";

function classify(error: unknown): ErrorClass {
  if (isSqliteBusy(error)) return "busy";
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === "SQLITE_FULL") return "busy";
  const message = errorMessage(error);
  if (/no such table|no such column/i.test(message)) return "table";
  if (
    typeof code === "string" &&
    TABLE_WIDE_CODE_PREFIXES.some(prefix => code.startsWith(prefix))
  ) {
    return "table";
  }
  return "own";
}

/** A write the queue could not take: logged to the console, never thrown. */
function reportNotQueued(method: string, error: unknown): void {
  try {
    console.error(`[billable-intervals] ${method}: write not queued`, error);
  } catch {
    // The console itself failed; there is nothing left to report to.
  }
}

/**
 * The fields of a set-aside op kept on its persisted log row (#6670 X3, R19), so
 * the amount behind a counted loss can be read later.
 */
function lostOpFields(op: QueuedOp): {
  namespace: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  endCause: string | null;
} {
  switch (op.kind) {
    case "open":
      return {
        namespace: op.row.namespace,
        startedAtMs: op.row.started_at_ms,
        endedAtMs: null,
        endCause: null,
      };
    case "close":
      return {
        namespace: op.input.namespace,
        startedAtMs: op.input.started_at_ms,
        endedAtMs: op.input.endedAtMs,
        endCause: op.input.endCause,
      };
    case "stretch":
      return {
        namespace: op.row.namespace,
        startedAtMs: op.row.stretch_started_at_ms,
        endedAtMs: op.row.legacy_ended_at_ms,
        endCause: null,
      };
    case "touch":
      return {
        namespace: null,
        startedAtMs: null,
        endedAtMs: null,
        endCause: null,
      };
  }
}

export class IntervalWriteService {
  private readonly queue: Queued[] = [];
  /** Queued touches by interval id, so a later touch raises the queued one. */
  private readonly queuedTouches = new Map<string, Queued>();
  /** Queued opens, closes and stretch rows per session. */
  private readonly queuedPerSession = new Map<string, number>();
  /** Queued closes per session, for `laterCloseQueued`. */
  private readonly queuedClosesPerSession = new Map<string, number>();

  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private flushing = false;

  private opensEnqueued = 0;
  private opensLanded = 0;
  private closesEnqueued = 0;
  private closesLanded = 0;
  private setAsideCount = 0;

  // #6670 (D2-4, D6-1): the stored lost-write totals. A set-aside is counted in
  // `pendingSetAside` until its direct store write lands; a failed write is
  // retried by its own timer, never by the drain timer.
  private pendingSetAside = 0;
  private lostWriteWarned = false;
  private lostWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private lostWriteAttempts = 0;
  private leftAtStopStored = false;
  private readonly bootId: string;
  private readonly bootStartedAtMs: number;
  private readonly bootChangeSeq: number | null;

  private depthAlarmRaised = false;
  private depthAlarmPending = false;
  private tableAlarmRaised = false;
  private slowWriteWarned = false;
  private lastBusyLogAt: number | null = null;

  private readonly onCloseLanded?: (report: CloseLandedReport) => void;
  private readonly queueCap: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly opMaxAttempts: number;
  private readonly flushBudgetMs: number;
  private readonly getNow: () => number;

  constructor(
    private readonly store: IntervalWriteStore,
    private readonly errorLogger: IntervalWriteLogger | null,
    options?: IntervalWriteServiceOptions
  ) {
    this.onCloseLanded = options?.onCloseLanded;
    this.queueCap = options?.queueCap ?? DEFAULT_QUEUE_CAP;
    this.backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = options?.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    this.opMaxAttempts = options?.opMaxAttempts ?? DEFAULT_OP_MAX_ATTEMPTS;
    this.flushBudgetMs = options?.flushBudgetMs ?? DEFAULT_FLUSH_BUDGET_MS;
    this.getNow = options?.getNow ?? Date.now;
    this.bootId = newUuidV7();
    this.bootStartedAtMs = this.getNow();
    let bootChangeSeq: number | null = null;
    try {
      bootChangeSeq = this.store.readChangeSeq?.() ?? null;
    } catch {
      bootChangeSeq = null;
    }
    this.bootChangeSeq = bootChangeSeq;
  }

  // ───────────── public enqueue API: synchronous, never throws ─────────────

  enqueueOpen(
    row: OpenIntervalRow,
    options: { recomputeTimer: boolean }
  ): void {
    // The op is built inside the guard: an `enqueue*` call never throws into the
    // socket listener path, whatever it is handed.
    try {
      this.push({
        kind: "open",
        sessionId: row.hapi_session_id,
        intervalId: row.id,
        row,
        recomputeTimer: options.recomputeTimer,
      });
    } catch (error) {
      // Never throw into the socket listener path, and never lose a write
      // without a trace (a console line only: no store write, nothing blocks).
      reportNotQueued("enqueueOpen", error);
    }
  }

  enqueueClose(input: CloseIntervalInput): void {
    try {
      this.push({
        kind: "close",
        sessionId: input.sessionId,
        intervalId: input.id,
        input,
      });
    } catch (error) {
      // Never throw into the socket listener path, and never lose a write
      // without a trace (a console line only: no store write, nothing blocks).
      reportNotQueued("enqueueClose", error);
    }
  }

  enqueueTouch(id: string, ms: number): void {
    try {
      if (this.stopped) return;
      const queued = this.queuedTouches.get(id);
      if (queued !== undefined && queued.kind === "touch") {
        if (ms > queued.ms) queued.ms = ms;
        return;
      }
      // The cap drops touches only: a touch is rebuildable by the next one.
      if (this.queue.length >= this.queueCap) return;
      this.push({ kind: "touch", sessionId: null, intervalId: id, ms });
    } catch (error) {
      // Never throw into the socket listener path, and never lose a write
      // without a trace (a console line only: no store write, nothing blocks).
      reportNotQueued("enqueueTouch", error);
    }
  }

  enqueueLegacyStretch(row: LegacyStretchRow): void {
    try {
      this.push({
        kind: "stretch",
        sessionId: row.hapi_session_id,
        intervalId: null,
        row,
      });
    } catch (error) {
      // Never throw into the socket listener path, and never lose a write
      // without a trace (a console line only: no store write, nothing blocks).
      reportNotQueued("enqueueLegacyStretch", error);
    }
  }

  // ───────────── readers for the daily check ─────────────

  getCounters(): IntervalWriteCounters {
    const head = this.queue[0];
    return {
      opensEnqueued: this.opensEnqueued,
      opensLanded: this.opensLanded,
      closesEnqueued: this.closesEnqueued,
      closesLanded: this.closesLanded,
      depth: this.queue.length,
      oldestOpAgeMs:
        head === undefined ? 0 : Math.max(0, this.getNow() - head.enqueuedAt),
      setAsideCount: this.setAsideCount,
      bootId: this.bootId,
      bootStartedAtMs: this.bootStartedAtMs,
      bootChangeSeq: this.bootChangeSeq,
      pendingSetAside: this.pendingSetAside,
    };
  }

  /** An open, a close or a stretch row of the session is queued (a touch does not count). */
  hasQueuedOp(sessionId: string): boolean {
    return (this.queuedPerSession.get(sessionId) ?? 0) > 0;
  }

  // ───────────── lifecycle ─────────────

  /**
   * One synchronous, bounded pass for shutdown: each op gets one attempt; an op
   * that lands is removed, one that fails stays queued and the pass moves on. The
   * pass ends when every op has had its attempt or `flushBudgetMs` has passed
   * (tested before each attempt). Every log in the pass is `persist: false`, so no
   * row blocks the exit path. What remains is covered by the next boot's repair.
   *
   * #6670 (D6-1): before the pass, one attempt to store a pending set-aside count;
   * after it, what is left queued (each close and stretch row, and each open whose
   * close did not land in this pass) is added to `left_at_stop_total`, once per
   * process, in one attempt. Both calls run while `flushing` is true, so a failure
   * arms no retry timer on the shutdown path.
   */
  flush(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.flushing = true;
    try {
      // The budget covers the first stored-total attempt too (#6670 review F3).
      const startedAt = this.getNow();
      if (this.lostWriteTimer) {
        clearTimeout(this.lostWriteTimer);
        this.lostWriteTimer = null;
      }
      this.persistLostWrites();
      const pending = this.queue.splice(0, this.queue.length);
      const remaining: Queued[] = [];
      const closesLanded = new Set<string>();
      for (let i = 0; i < pending.length; i++) {
        const op = pending[i];
        if (this.getNow() - startedAt >= this.flushBudgetMs) {
          remaining.push(...pending.slice(i));
          break;
        }
        try {
          const result = this.apply(op);
          this.afterRemoved(op);
          if (op.kind === "close") closesLanded.add(op.intervalId);
          this.afterLanded(op, result);
        } catch (error) {
          remaining.push(op);
          this.log(
            "warn",
            `interval ${op.kind} write failed during flush`,
            op,
            error,
            false
          );
        }
      }
      this.queue.push(...remaining);
      let leftAtStop = 0;
      for (const op of remaining) {
        if (op.kind === "close" || op.kind === "stretch") leftAtStop++;
        else if (op.kind === "open" && !closesLanded.has(op.intervalId))
          leftAtStop++;
      }
      this.persistLostWrites(this.leftAtStopStored ? 0 : leftAtStop);
      this.leftAtStopStored = true;
    } catch {
      // flush runs on the shutdown path and must not throw.
    } finally {
      this.flushing = false;
    }
  }

  /** Cancel the drain timer and the lost-write retry, and refuse further enqueues. */
  stop(): void {
    this.stopped = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.lostWriteTimer) {
      clearTimeout(this.lostWriteTimer);
      this.lostWriteTimer = null;
    }
  }

  // ───────────── internals ─────────────

  private push(op: QueuedOp): void {
    try {
      if (this.stopped) return;
      const now = this.getNow();
      const queued: Queued = {
        ...op,
        // #6670 (R18): a stretch row is never queued later than its own
        // `recorded_at_ms`, so a run that ends its period below the oldest queued
        // op ends it below the row's stamp, and the next run reads the row.
        enqueuedAt:
          op.kind === "stretch" ? Math.min(now, op.row.recorded_at_ms) : now,
        ownAttempts: 0,
        busyAttempts: 0,
      } as Queued;
      this.queue.push(queued);
      if (queued.kind === "touch") {
        this.queuedTouches.set(queued.intervalId, queued);
      } else {
        this.bump(this.queuedPerSession, queued.sessionId, 1);
      }
      if (queued.kind === "open") this.opensEnqueued++;
      if (queued.kind === "close") {
        this.closesEnqueued++;
        this.bump(this.queuedClosesPerSession, queued.sessionId, 1);
      }
      if (this.queue.length > this.queueCap && !this.depthAlarmRaised) {
        this.depthAlarmRaised = true;
        this.depthAlarmPending = true;
      }
      this.scheduleDrain(0);
    } catch (error) {
      // Never throw into the socket listener path, and never lose a write
      // without a trace (a console line only: no store write, nothing blocks).
      reportNotQueued("push", error);
    }
  }

  private bump(map: Map<string, number>, key: string, delta: number): void {
    const next = (map.get(key) ?? 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  private scheduleDrain(delayMs: number): void {
    if (this.stopped || this.flushing) return;
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => this.drainTick(), delayMs);
  }

  private backoff(attempts: number): number {
    return Math.min(
      this.backoffCapMs,
      this.backoffBaseMs * Math.pow(2, Math.max(0, attempts - 1))
    );
  }

  private drainTick(): void {
    this.drainTimer = null;
    try {
      if (this.depthAlarmPending) {
        this.depthAlarmPending = false;
        this.log(
          "error",
          `interval write queue above its cap (${this.queueCap}); touches are dropped until it drains`,
          null,
          null,
          true,
          { depth: this.queue.length, queueCap: this.queueCap }
        );
      }
      while (this.queue.length > 0) {
        const op = this.queue[0];
        const waitStart = this.getNow();
        try {
          const result = this.apply(op);
          this.noteWaited(op, this.getNow() - waitStart);
          this.queue.shift();
          this.afterRemoved(op);
          this.tableAlarmRaised = false;
          this.afterLanded(op, result);
          continue;
        } catch (error) {
          const kind = classify(error);
          if (kind === "busy") {
            op.busyAttempts++;
            this.logBusy(op, error);
            this.scheduleDrain(this.backoff(op.busyAttempts));
            return;
          }
          if (kind === "table") {
            op.busyAttempts++;
            if (!this.tableAlarmRaised) {
              this.tableAlarmRaised = true;
              this.log(
                "error",
                "interval writes fail for every op; the queue is kept",
                op,
                error,
                true
              );
            }
            this.scheduleDrain(this.backoff(op.busyAttempts));
            return;
          }
          op.ownAttempts++;
          if (op.ownAttempts >= this.opMaxAttempts) {
            this.queue.shift();
            this.afterRemoved(op);
            this.setAsideCount++;
            // #6670 (D2-4): a touch loses nothing, so it is not counted.
            if (op.kind !== "touch") {
              this.pendingSetAside++;
              this.persistLostWrites();
            }
            const lost = lostOpFields(op);
            this.log(
              "error",
              `interval ${op.kind} write set aside after ${op.ownAttempts} attempts`,
              op,
              error,
              true,
              lost,
              lost.namespace
            );
            continue;
          }
          this.scheduleDrain(this.backoff(op.ownAttempts));
          return;
        }
      }
    } catch {
      // A throw in a setTimeout callback exits the server; contain it.
    } finally {
      if (this.queue.length <= this.queueCap) this.depthAlarmRaised = false;
    }
  }

  /**
   * Add the pending set-aside count (and, from `flush`, the ops left queued) to
   * the stored totals by a direct store call (#6670, D2-4, D6-1). On a throw the
   * pending count is kept and retried by this method's own timer (never the drain
   * timer, so later writes never wait for its backoff), unless the service is
   * stopping. Never throws: it runs from a timer, and a throw there exits the
   * server.
   */
  private persistLostWrites(leftAtStop = 0): void {
    try {
      if (this.pendingSetAside + leftAtStop === 0) return;
      try {
        this.store.addLostWrites({
          setAside: this.pendingSetAside,
          leftAtStop,
          nowMs: this.getNow(),
        });
        this.pendingSetAside = 0;
        this.lostWriteAttempts = 0;
      } catch (error) {
        if (!this.lostWriteWarned) {
          this.lostWriteWarned = true;
          this.log(
            "error",
            "lost-write total not stored; retried by its own timer",
            null,
            error,
            false,
            { pendingSetAside: this.pendingSetAside, leftAtStop }
          );
        }
        if (!this.stopped && !this.flushing && this.lostWriteTimer === null) {
          this.lostWriteTimer = setTimeout(() => {
            this.lostWriteTimer = null;
            this.persistLostWrites();
          }, this.backoff(++this.lostWriteAttempts));
        }
      }
    } catch {
      // Never throw from a timer callback or the drainer.
    }
  }

  private apply(op: Queued): CloseIntervalResult | null {
    switch (op.kind) {
      case "open":
        this.store.openInterval(op.row, { recomputeTimer: op.recomputeTimer });
        return null;
      case "close":
        return this.store.closeInterval(op.input);
      case "touch":
        this.store.touchLastSeen(op.intervalId, op.ms);
        return null;
      case "stretch":
        this.store.recordLegacyStretch(op.row);
        return null;
    }
  }

  /** Bookkeeping for an op that has left the queue (landed or set aside). */
  private afterRemoved(op: Queued): void {
    if (op.kind === "touch") {
      if (this.queuedTouches.get(op.intervalId) === op) {
        this.queuedTouches.delete(op.intervalId);
      }
      return;
    }
    this.bump(this.queuedPerSession, op.sessionId, -1);
    if (op.kind === "close")
      this.bump(this.queuedClosesPerSession, op.sessionId, -1);
  }

  private afterLanded(op: Queued, result: CloseIntervalResult | null): void {
    if (op.kind === "open") this.opensLanded++;
    if (op.kind !== "close") return;
    this.closesLanded++;
    if (result === null || this.onCloseLanded === undefined) return;
    try {
      this.onCloseLanded({
        sessionId: op.sessionId,
        sessionTotalMs: result.sessionTotalMs,
        laterCloseQueued:
          (this.queuedClosesPerSession.get(op.sessionId) ?? 0) > 0,
      });
    } catch (error) {
      this.log(
        "warn",
        "interval close-landed callback threw",
        op,
        error,
        false
      );
    }
  }

  private noteWaited(op: Queued, waitedMs: number): void {
    if (waitedMs < SLOW_WRITE_MS || this.slowWriteWarned) return;
    this.slowWriteWarned = true;
    this.log(
      "warn",
      `interval ${op.kind} write waited ${waitedMs} ms on the store`,
      op,
      null,
      false,
      { waitedMs }
    );
  }

  /** Rate-limited, never persisted: a busy store is not written from its own failure path. */
  private logBusy(op: Queued, error: unknown): void {
    const now = this.getNow();
    if (
      this.lastBusyLogAt !== null &&
      now - this.lastBusyLogAt < BUSY_LOG_INTERVAL_MS
    ) {
      return;
    }
    this.lastBusyLogAt = now;
    this.log(
      "error",
      `interval ${op.kind} write retried: the store is busy or full`,
      op,
      error,
      false,
      { busyAttempts: op.busyAttempts }
    );
  }

  private log(
    level: "error" | "warn",
    message: string,
    op: Queued | null,
    error: unknown,
    persist: boolean,
    extra?: Record<string, unknown>,
    namespace?: string | null
  ): void {
    if (this.errorLogger === null) return;
    try {
      const options: ErrorLogOptions = {
        category: CATEGORY,
        sessionId: op?.sessionId ?? null,
        ...(namespace !== undefined ? { namespace } : {}),
        persist: persist && !this.flushing,
        context: {
          op: op?.kind ?? null,
          sessionId: op?.sessionId ?? null,
          intervalId: op?.intervalId ?? null,
          ...(error !== null && error !== undefined
            ? sqliteErrorContext(error)
            : {}),
          ...extra,
        },
      };
      this.errorLogger[level](message, options);
    } catch {
      // ErrorLogger never throws, but this path must not either.
    }
  }
}
