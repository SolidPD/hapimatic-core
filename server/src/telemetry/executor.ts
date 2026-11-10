// SPDX-License-Identifier: AGPL-3.0-only
import type { ErrorLogger } from "../logging/errorLogger";
import type { ErrorLogSeverity } from "../store/types";
import { TELEMETRY_EVENT_RETENTION_DAYS } from "../store/telemetryRetention";
import type { TelemetryStore } from "../store/telemetryStore";
import type { TurnAnalyticsCounts } from "../store/turns/analyticsCounts";
import {
  EVENTS_SCAN_KINDS,
  runTelemetryQuery,
  type TelemetryQueryKind,
  type TelemetryQueryParams,
  type TelemetryQueryResult,
} from "./queries";
import type {
  WorkerInitMessage,
  WorkerJobKind,
  WorkerJobMessage,
  WorkerReply,
} from "./queryWorker";
import { telemetryWorkerSpecifier } from "./workerSpecifier";

/**
 * Runs the Analytics telemetry reads off the server's main thread (issue
 * #6516). Design: `docs/internal/architecture/telemetry-query-executor.md`.
 *
 * - `WorkerTelemetryExecutor` (default): one serial Bun Worker with read-only
 *   connections. A FIFO queue with single-flight per (kind, params), bounded
 *   in size and in wait time; a per-job timeout; crash respawn with backoff;
 *   and degraded mode when the worker is unusable (D1 = option 1).
 * - `InlineTelemetryExecutor`: today's in-thread execution. It is what the
 *   kill switch `HAPI_TELEMETRY_EXECUTOR=inline` selects, the default of the
 *   route factory when no executor is passed (tests), and what degraded mode
 *   uses for the four cheap reads.
 */

/** Distinct queued (not yet running) jobs before `telemetry_busy`. */
export const TELEMETRY_QUEUE_MAX = 32;
/** A posted job older than this is answered `telemetry_timeout` (3× the prod cold `summary`). */
export const TELEMETRY_JOB_TIMEOUT_MS = 300_000;
/** A queued job older than this is answered `telemetry_busy`, so every request settles. */
export const TELEMETRY_QUEUE_WAIT_MAX_MS = 600_000;
/**
 * The Bun idle timeout (`server.timeout(req, seconds)`) each executor-backed
 * telemetry request gets: `0`, which turns the idle timeout off for that
 * request. Without it the hub's `idleTimeout` (50 s: the socket.io engine's
 * `2 × pingInterval`, `web/server.ts`) resets a request that waits on the
 * executor (Premise P3).
 *
 * Why not a large number: Bun 1.4.4 caps a per-request idle timeout at about
 * 255 s, so the earlier `1800` reset the connection
 * at 256 s, before `telemetry_timeout` (300 s) or `telemetry_busy` (600 s)
 * could answer (#6516 A-1, measured on worktree port 3011). An unbounded
 * request is safe here because every executor promise settles by its own
 * bounds, and a refresh route runs at most two of them: the queue wait
 * ({@link TELEMETRY_QUEUE_WAIT_MAX_MS}) plus the job timeout
 * ({@link TELEMETRY_JOB_TIMEOUT_MS}) each. `POST /telemetry/aggregate {}`
 * runs one job per missing day, so its length grows with the number of days.
 * The route tests use a stub server and cannot see the cap; keep this `0`.
 */
export const TELEMETRY_REQUEST_TIMEOUT_S = 0;

/**
 * Turn off one request's Bun idle timeout ({@link TELEMETRY_REQUEST_TIMEOUT_S}).
 * `env` is Hono's `c.env`, the Bun server in production
 * (`web/server.ts` passes it to `app.fetch`). It is absent under
 * `app.request()` in tests and for an in-process `getApp().fetch()` re-entry,
 * where this is a no-op; the capability-call route extends the OUTER request
 * instead.
 */
export function extendTelemetryRequestTimeout(
  env: unknown,
  request: Request
): void {
  const server = env as
    | { timeout?: (request: Request, seconds: number) => void }
    | null
    | undefined;
  if (typeof server?.timeout === "function") {
    server.timeout(request, TELEMETRY_REQUEST_TIMEOUT_S);
  }
}
/** The startup self-test (`ping`) must answer within this. */
export const TELEMETRY_SELFTEST_TIMEOUT_MS = 30_000;
/** If the old worker has not closed this long after `terminate()`, go degraded. */
export const TELEMETRY_DRAIN_MAX_MS = 600_000;

const FAILURE_WINDOW_MS = 600_000;
const FAILURES_BEFORE_UNUSABLE = 3;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export const TELEMETRY_EXECUTOR_LOG_CATEGORY = "telemetry-executor";
export const TELEMETRY_AGGREGATE_LOG_CATEGORY = "telemetry-aggregate";

export type TelemetryExecutorErrorCode =
  | "telemetry_busy"
  | "telemetry_timeout"
  | "telemetry_unavailable";

/** A rejection the routes answer with `503 {error, code}` and `Retry-After`. */
export class TelemetryExecutorError extends Error {
  constructor(
    readonly code: TelemetryExecutorErrorCode,
    message: string
  ) {
    super(message);
    this.name = "TelemetryExecutorError";
  }
}

/** The caller's request was aborted while its job was still queued. */
export class TelemetryRequestAbortedError extends Error {
  constructor() {
    super("telemetry request aborted by the client");
    this.name = "TelemetryRequestAbortedError";
  }
}

export type TelemetryExecutorMode = "worker" | "degraded" | "inline";
export type TelemetrySelftestState =
  | "pending"
  | "ok"
  | "failed"
  | "not-applicable";

export interface TelemetryExecutorStatus {
  mode: TelemetryExecutorMode;
  selftest: TelemetrySelftestState;
  /** Dates in `daily_aggregate_debt` (skipped today-refreshes awaiting recompute). */
  aggregateDebtDays: number;
  /** Why the worker is unusable, or why the executor is inline; null when healthy. */
  cause: string | null;
}

export interface TelemetrySelftestResult {
  ok: boolean;
  cause?: string;
}

export type TelemetryRefreshOutcome = "refreshed" | "skipped";

export interface TelemetryExecutor {
  readonly kind: "worker" | "inline";
  /** Run one read. Every returned promise settles (result, rejection or timeout). */
  run<K extends TelemetryQueryKind>(
    kind: K,
    params: TelemetryQueryParams<K>,
    signal?: AbortSignal
  ): Promise<TelemetryQueryResult<K>>;
  /**
   * Recompute one day's aggregates: compute through the executor, write with
   * `TelemetryStore.replaceDayAggregates` on the main connection. While the
   * worker is unusable this records aggregate debt instead (R12).
   */
  refreshDay(
    date: string,
    store: TelemetryStore
  ): Promise<TelemetryRefreshOutcome>;
  /** Aggregate every day with events but no aggregates (`POST /telemetry/aggregate {}`). */
  aggregateMissing(
    store: TelemetryStore,
    signal?: AbortSignal
  ): Promise<number>;
  /**
   * Recompute every debt date plus today and clear their debt rows (R12). A
   * debt date past the event retention is not recomputed: its debt is cleared
   * and its stored rows are kept (IR-1). Returns the dates recomputed.
   */
  recoverAggregateDebt(store: TelemetryStore): Promise<string[]>;
  /** Start the worker if needed and confirm it answers. */
  selftest(): Promise<TelemetrySelftestResult>;
  status(): TelemetryExecutorStatus;
  /** Reject pending work and terminate the worker without waiting for it. */
  stop(): void;
}

interface ExecutorLogSink {
  errorLogger?: ErrorLogger | null;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const MS_PER_DAY = 86_400_000;

/**
 * True when `date` (YYYY-MM-DD) starts before the event retention cutoff. The
 * prune runs at every boot, so some or all of its events may be gone, and a
 * recompute could replace the stored `daily_aggregates` with fewer rows or
 * none (issue #6516 IR-1). The test errs safe: on a server up for more than 90
 * days such a day may still hold all its events and is left as stored.
 */
function isPastEventRetention(date: string, nowMs: number): boolean {
  const start = Date.parse(`${date}T00:00:00Z`);
  return start < nowMs - TELEMETRY_EVENT_RETENTION_DAYS * MS_PER_DAY;
}

interface RecoveryPlan {
  /** Every debt date still inside the retention, plus today: sorted, once each. */
  recompute: string[];
  /** Debt dates past the retention: their debt is cleared, their rows kept. */
  expired: string[];
}

/** Split a recovery pass's dates by {@link isPastEventRetention}. */
function recoveryPlan(
  debtDates: readonly string[],
  nowMs: number
): RecoveryPlan {
  const unique = [...new Set(debtDates)];
  const expired = unique.filter(d => isPastEventRetention(d, nowMs)).sort();
  const recompute = [
    ...new Set([...unique.filter(d => !expired.includes(d)), utcDate(nowMs)]),
  ].sort();
  return { recompute, expired };
}

/**
 * Clear the debt of dates past the event retention without recomputing them,
 * keeping whatever aggregates they hold, and say so in one line.
 */
function settleExpiredDebt(
  sink: ExecutorLogSink,
  store: TelemetryStore,
  expired: readonly string[]
): void {
  if (expired.length === 0) return;
  store.clearAggregateDebt(expired);
  logTelemetryEvent(
    sink,
    "warn",
    TELEMETRY_AGGREGATE_LOG_CATEGORY,
    `recovery pass kept the stored aggregates of ${expired.length} skipped day(s) past the ${TELEMETRY_EVENT_RETENTION_DAYS}-day event retention, whose events the boot prune may have removed, and cleared their debt: ${expired.join(", ")}`
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One line for a worker `error` event. Bun's `ErrorEvent.message` carries the
 * worker's code frame across several lines; the health reason and the log
 * want the error itself.
 */
function describeErrorEvent(event: Event): string {
  const e = event as ErrorEvent;
  const raw =
    e.error instanceof Error ? e.error.message : e.message || "unknown error";
  // "<code frame>\nerror: <message>\n    at ..." -> "<message>"
  const thrown = /(?:^|\n)error: ([^\n]+)/.exec(raw)?.[1];
  const line = (thrown ?? raw).replace(/\s+/g, " ").trim();
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * Log one telemetry event under its category. `ErrorLogger` prints
 * `[<category>]` itself, so the message carries no prefix of its own; only the
 * console fallback adds one. The routes use it too (issue #6516).
 */
export function logTelemetryEvent(
  sink: ExecutorLogSink,
  severity: ErrorLogSeverity,
  category: string,
  message: string
): void {
  if (sink.errorLogger) {
    // ErrorLogger prints "[<category>] <message>" itself.
    sink.errorLogger.log(severity, message, { category });
    return;
  }
  const line = `[${category}] ${message}`;
  if (severity === "error" || severity === "fatal") console.error(line);
  else console.warn(line);
}

// ── Inline ─────────────────────────────────────────────────

export interface InlineTelemetryExecutorOptions {
  getTelemetryStore: () => TelemetryStore | null;
  getTurnAnalytics?: (() => TurnAnalyticsCounts | null) | null;
  errorLogger?: ErrorLogger | null;
  /** Why the executor is inline (shown on `/api/health`), e.g. `env`. */
  reason?: string | null;
  now?: () => number;
}

/**
 * Today's behaviour: every read runs synchronously on the main connections.
 * With the kill switch on, an Analytics load stalls the whole hub again; this
 * is the preserved old path, never an automatic fallback for the scan reads.
 */
export class InlineTelemetryExecutor implements TelemetryExecutor {
  readonly kind = "inline" as const;

  constructor(private readonly options: InlineTelemetryExecutorOptions) {}

  private requireStore(): TelemetryStore {
    const store = this.options.getTelemetryStore();
    if (!store) {
      throw new TelemetryExecutorError(
        "telemetry_unavailable",
        "Telemetry store not available"
      );
    }
    return store;
  }

  /** The synchronous read, for callers that must not yield (degraded mode). */
  runNow<K extends TelemetryQueryKind>(
    kind: K,
    params: TelemetryQueryParams<K>
  ): TelemetryQueryResult<K> {
    const store = this.requireStore();
    return runTelemetryQuery(kind, params, {
      legacy: store.queries,
      turns: this.options.getTurnAnalytics?.() ?? null,
    });
  }

  async run<K extends TelemetryQueryKind>(
    kind: K,
    params: TelemetryQueryParams<K>,
    signal?: AbortSignal
  ): Promise<TelemetryQueryResult<K>> {
    if (signal?.aborted) throw new TelemetryRequestAbortedError();
    return this.runNow(kind, params);
  }

  async refreshDay(
    date: string,
    store: TelemetryStore
  ): Promise<TelemetryRefreshOutcome> {
    store.aggregateDay(date);
    return "refreshed";
  }

  async aggregateMissing(store: TelemetryStore): Promise<number> {
    return store.aggregateMissing();
  }

  async recoverAggregateDebt(store: TelemetryStore): Promise<string[]> {
    const { recompute, expired } = recoveryPlan(
      store.listAggregateDebt().map(d => d.date),
      (this.options.now ?? Date.now)()
    );
    settleExpiredDebt(this.options, store, expired);
    for (const date of recompute) {
      store.replaceDayAggregates(
        date,
        store.queries.computeDayAggregates(date),
        {
          clearDebt: true,
        }
      );
    }
    return recompute;
  }

  async selftest(): Promise<TelemetrySelftestResult> {
    return { ok: true };
  }

  status(): TelemetryExecutorStatus {
    return {
      mode: "inline",
      selftest: "not-applicable",
      aggregateDebtDays:
        this.options.getTelemetryStore()?.listAggregateDebt().length ?? 0,
      cause: this.options.reason ?? null,
    };
  }

  stop(): void {}
}

// ── Worker ─────────────────────────────────────────────────

export interface WorkerTelemetryExecutorOptions {
  telemetryPath: string;
  /** `hapi.db`; null runs the reads without the turns source (pure legacy). */
  hapiPath: string | null;
  getTelemetryStore: () => TelemetryStore | null;
  getTurnAnalytics?: (() => TurnAnalyticsCounts | null) | null;
  errorLogger?: ErrorLogger | null;
  /**
   * Test seam; default `telemetryWorkerSpecifier()`. A function is read at
   * every spawn, so a test can make the worker fail and then recover.
   */
  specifier?: string | URL | (() => string | URL);
  /** Enables the worker's test-only kinds. Tests only. */
  testKinds?: boolean;
  queueMax?: number;
  jobTimeoutMs?: number;
  queueWaitMaxMs?: number;
  selftestTimeoutMs?: number;
  drainMaxMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
}

type Phase = "idle" | "starting" | "ready" | "draining" | "backoff" | "stopped";

interface Waiter {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface Job {
  id: number;
  key: string;
  kind: WorkerJobKind;
  params: unknown;
  waiters: Set<Waiter>;
  enqueuedAt: number;
  waitTimer: ReturnType<typeof setTimeout> | null;
  runTimer: ReturnType<typeof setTimeout> | null;
}

/** Counters for tests and diagnostics. */
export interface WorkerExecutorStats {
  jobsPosted: number;
  abandonedDropped: number;
  spawns: number;
  failuresInWindow: number;
  queued: number;
  inFlight: boolean;
}

export class WorkerTelemetryExecutor implements TelemetryExecutor {
  readonly kind = "worker" as const;

  private readonly inline: InlineTelemetryExecutor;
  private readonly specifier: string | URL | (() => string | URL);
  private readonly queueMax: number;
  private readonly jobTimeoutMs: number;
  private readonly queueWaitMaxMs: number;
  private readonly selftestTimeoutMs: number;
  private readonly drainMaxMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly now: () => number;

  private phase: Phase = "idle";
  private worker: Worker | null = null;
  private usable = true;
  private everReady = false;
  private cause: string | null = null;
  private selftestState: TelemetrySelftestState = "pending";
  private failures: number[] = [];
  private respawnDelayMs = 0;
  private respawnTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private startWaiters: Array<(r: TelemetrySelftestResult) => void> = [];
  private lastStart: TelemetrySelftestResult | null = null;

  private readonly queue: Job[] = [];
  private readonly byKey = new Map<string, Job>();
  private inflight: Job | null = null;
  private pingJob: Job | null = null;
  private nextId = 0;

  private readonly refreshes = new Map<
    string,
    Promise<TelemetryRefreshOutcome>
  >();
  private recovering: Promise<void> | null = null;
  private recoverAgain = false;

  private readonly counters = {
    jobsPosted: 0,
    abandonedDropped: 0,
    spawns: 0,
  };

  constructor(private readonly options: WorkerTelemetryExecutorOptions) {
    this.inline = new InlineTelemetryExecutor({
      getTelemetryStore: options.getTelemetryStore,
      getTurnAnalytics: options.getTurnAnalytics,
      errorLogger: options.errorLogger,
      now: options.now,
    });
    this.specifier = options.specifier ?? telemetryWorkerSpecifier();
    this.queueMax = options.queueMax ?? TELEMETRY_QUEUE_MAX;
    this.jobTimeoutMs = options.jobTimeoutMs ?? TELEMETRY_JOB_TIMEOUT_MS;
    this.queueWaitMaxMs = options.queueWaitMaxMs ?? TELEMETRY_QUEUE_WAIT_MAX_MS;
    this.selftestTimeoutMs =
      options.selftestTimeoutMs ?? TELEMETRY_SELFTEST_TIMEOUT_MS;
    this.drainMaxMs = options.drainMaxMs ?? TELEMETRY_DRAIN_MAX_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.now = options.now ?? Date.now;
  }

  // ── Public API ──────────────────────────────────────────

  run<K extends TelemetryQueryKind>(
    kind: K,
    params: TelemetryQueryParams<K>,
    signal?: AbortSignal
  ): Promise<TelemetryQueryResult<K>> {
    if (this.phase === "stopped") {
      return Promise.reject(this.unavailable("the server is shutting down"));
    }
    if (signal?.aborted) {
      return Promise.reject(new TelemetryRequestAbortedError());
    }
    if (!this.usable) {
      if (!EVENTS_SCAN_KINDS.has(kind)) {
        // Degraded mode: the four cheap reads run in-thread (D1 = option 1).
        try {
          return Promise.resolve(this.inline.runNow(kind, params));
        } catch (err) {
          return Promise.reject(err);
        }
      }
      return Promise.reject(this.unavailableNow());
    }
    return this.enqueue(kind, params, signal) as Promise<
      TelemetryQueryResult<K>
    >;
  }

  /**
   * Run any worker job kind, including `ping` and the test-only kinds, through
   * the normal queue. Tests and the self-test use it; routes use `run`.
   */
  runWorkerJob(
    kind: WorkerJobKind,
    params: unknown,
    signal?: AbortSignal
  ): Promise<unknown> {
    if (this.phase === "stopped") {
      return Promise.reject(this.unavailable("the server is shutting down"));
    }
    if (!this.usable) return Promise.reject(this.unavailableNow());
    return this.enqueue(kind, params, signal);
  }

  refreshDay(
    date: string,
    store: TelemetryStore
  ): Promise<TelemetryRefreshOutcome> {
    // Single-flight per date: the page's three refreshing routes share one
    // compute and one write.
    const pending = this.refreshes.get(date);
    if (pending) return pending;
    const refresh = this.refreshDayOnce(date, store).finally(() => {
      this.refreshes.delete(date);
    });
    this.refreshes.set(date, refresh);
    return refresh;
  }

  private async refreshDayOnce(
    date: string,
    store: TelemetryStore
  ): Promise<TelemetryRefreshOutcome> {
    if (this.phase === "stopped") {
      throw this.unavailable("the server is shutting down");
    }
    if (!this.usable) {
      this.recordSkip(date, store);
      return "skipped";
    }
    let rows: TelemetryQueryResult<"computeDay">;
    try {
      rows = await this.run("computeDay", { date });
    } catch (err) {
      if (
        err instanceof TelemetryExecutorError &&
        err.code === "telemetry_unavailable" &&
        !this.usable &&
        !this.isStopped()
      ) {
        this.recordSkip(date, store);
        return "skipped";
      }
      throw err;
    }
    store.replaceDayAggregates(date, rows);
    return "refreshed";
  }

  async aggregateMissing(
    store: TelemetryStore,
    signal?: AbortSignal
  ): Promise<number> {
    const days = await this.run("missingDays", {}, signal);
    for (const date of days) {
      const rows = await this.run("computeDay", { date }, signal);
      store.replaceDayAggregates(date, rows);
    }
    return days.length;
  }

  async recoverAggregateDebt(store: TelemetryStore): Promise<string[]> {
    const debt = store.listAggregateDebt().map(d => d.date);
    const { recompute, expired } = recoveryPlan(debt, this.now());
    settleExpiredDebt(this.options, store, expired);
    const recovered: string[] = [];
    for (const date of recompute) {
      try {
        const rows = await this.run("computeDay", { date });
        store.replaceDayAggregates(date, rows, { clearDebt: true });
        recovered.push(date);
      } catch (err) {
        logTelemetryEvent(
          this.options,
          "warn",
          TELEMETRY_AGGREGATE_LOG_CATEGORY,
          `recovery pass could not recompute ${date}: ${messageOf(err)}; its debt stays recorded`
        );
      }
    }
    const cleared = recovered.filter(d => debt.includes(d));
    if (cleared.length > 0) {
      console.log(
        `[telemetry-executor] recovery pass recomputed ${cleared.length} skipped day(s): ${cleared.join(", ")}`
      );
    }
    return recovered;
  }

  selftest(): Promise<TelemetrySelftestResult> {
    switch (this.phase) {
      case "stopped":
        return Promise.resolve({ ok: false, cause: "executor stopped" });
      case "idle":
      case "starting": {
        const result = new Promise<TelemetrySelftestResult>(resolve =>
          this.startWaiters.push(resolve)
        );
        if (this.phase === "idle") this.spawn();
        return result;
      }
      case "ready":
        return this.runWorkerJob("ping", {}).then(
          () => ({ ok: true }),
          err => ({ ok: false, cause: messageOf(err) })
        );
      default:
        return Promise.resolve(
          this.lastStart && !this.lastStart.ok
            ? this.lastStart
            : { ok: false, cause: this.cause ?? `worker ${this.phase}` }
        );
    }
  }

  status(): TelemetryExecutorStatus {
    let aggregateDebtDays = 0;
    try {
      aggregateDebtDays =
        this.options.getTelemetryStore()?.listAggregateDebt().length ?? 0;
    } catch {
      // A health read must never throw.
    }
    return {
      mode: this.usable ? "worker" : "degraded",
      selftest: this.selftestState,
      aggregateDebtDays,
      cause: this.usable ? null : this.cause,
    };
  }

  stop(): void {
    if (this.phase === "stopped") return;
    this.phase = "stopped";
    this.clearTimer("respawnTimer");
    this.clearTimer("drainTimer");
    const err = this.unavailable("the server is shutting down");
    for (const job of [...this.queue, this.inflight, this.pingJob]) {
      if (job) this.settleJob(job, err);
    }
    this.queue.length = 0;
    this.byKey.clear();
    this.inflight = null;
    this.pingJob = null;
    this.resolveStart({ ok: false, cause: "executor stopped" });
    // A running statement holds the worker until it returns (P9); never wait.
    this.worker?.terminate();
  }

  /** Counters for tests and diagnostics. */
  stats(): WorkerExecutorStats {
    return {
      ...this.counters,
      failuresInWindow: this.failuresInWindow(),
      queued: this.queue.length,
      inFlight: this.inflight !== null,
    };
  }

  // ── Queue ───────────────────────────────────────────────

  private enqueue(
    kind: WorkerJobKind,
    params: unknown,
    signal: AbortSignal | undefined
  ): Promise<unknown> {
    const key = `${kind}:${JSON.stringify(params ?? {})}`;
    let job = this.byKey.get(key);
    if (!job) {
      if (this.queue.length >= this.queueMax) {
        return Promise.reject(
          new TelemetryExecutorError(
            "telemetry_busy",
            `the Analytics query queue is full (${this.queueMax} queries waiting)`
          )
        );
      }
      const created = this.newJob(key, kind, params);
      created.waitTimer = setTimeout(
        () => this.expireQueued(created),
        this.queueWaitMaxMs
      );
      this.queue.push(created);
      this.byKey.set(key, created);
      job = created;
    }
    const target = job;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => this.onWaiterAbort(target, waiter);
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      target.waiters.add(waiter);
      this.pump();
    });
  }

  /** A fresh job with no waiters and no timers armed. */
  private newJob(key: string, kind: WorkerJobKind, params: unknown): Job {
    return {
      id: ++this.nextId,
      key,
      kind,
      params,
      waiters: new Set(),
      enqueuedAt: this.now(),
      waitTimer: null,
      runTimer: null,
    };
  }

  private pump(): void {
    if (this.phase === "idle") {
      this.spawn();
      return;
    }
    if (this.phase !== "ready" || this.inflight || this.queue.length === 0) {
      return;
    }
    const job = this.queue.shift() as Job;
    if (job.waitTimer) clearTimeout(job.waitTimer);
    job.waitTimer = null;
    this.inflight = job;
    this.post(job, this.jobTimeoutMs);
  }

  private post(job: Job, timeoutMs: number): void {
    const message: WorkerJobMessage = {
      type: "job",
      id: job.id,
      kind: job.kind,
      params: job.params,
    };
    job.runTimer = setTimeout(() => this.onJobTimeout(job), timeoutMs);
    this.counters.jobsPosted++;
    try {
      this.worker?.postMessage(message);
    } catch (err) {
      this.onWorkerFault(`could not post to the worker: ${messageOf(err)}`);
    }
  }

  private onWaiterAbort(job: Job, waiter: Waiter): void {
    if (!job.waiters.delete(waiter)) return;
    waiter.reject(new TelemetryRequestAbortedError());
    // A running statement cannot be interrupted (P9), so only a job still in
    // the queue is dropped, and only once every waiter has gone.
    const index = this.queue.indexOf(job);
    if (job.waiters.size === 0 && index !== -1) {
      this.queue.splice(index, 1);
      this.byKey.delete(job.key);
      if (job.waitTimer) clearTimeout(job.waitTimer);
      this.counters.abandonedDropped++;
    }
  }

  private expireQueued(job: Job): void {
    const index = this.queue.indexOf(job);
    if (index === -1) return;
    this.queue.splice(index, 1);
    this.settleJob(
      job,
      new TelemetryExecutorError(
        "telemetry_busy",
        `the query waited ${Math.round(this.queueWaitMaxMs / 1000)} s in the Analytics queue`
      ),
      true
    );
  }

  /** Reject or resolve every waiter of a job and forget the job. */
  private settleJob(job: Job, outcome: unknown, isError = true): void {
    if (job.waitTimer) clearTimeout(job.waitTimer);
    if (job.runTimer) clearTimeout(job.runTimer);
    job.waitTimer = null;
    job.runTimer = null;
    if (this.byKey.get(job.key) === job) this.byKey.delete(job.key);
    for (const waiter of job.waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      if (isError) waiter.reject(outcome);
      else waiter.resolve(outcome);
    }
    job.waiters.clear();
  }

  // ── Worker lifecycle ────────────────────────────────────

  private spawn(): void {
    this.respawnTimer = null;
    if (this.phase === "stopped") return;
    this.phase = "starting";
    this.selftestState = "pending";
    this.counters.spawns++;
    let worker: Worker;
    try {
      const specifier =
        typeof this.specifier === "function"
          ? this.specifier()
          : this.specifier;
      worker = new Worker(specifier);
    } catch (err) {
      this.worker = null;
      this.onStartFailed(`could not create the worker: ${messageOf(err)}`);
      return;
    }
    this.worker = worker;
    worker.addEventListener("message", event => this.onMessage(worker, event));
    worker.addEventListener("error", event =>
      this.onWorkerEvent(worker, `worker error: ${describeErrorEvent(event)}`)
    );
    worker.addEventListener("messageerror", () =>
      this.onWorkerEvent(worker, "worker message could not be deserialized")
    );
    worker.addEventListener("close", () => this.onWorkerClose(worker));
    const init: WorkerInitMessage = {
      type: "init",
      telemetryPath: this.options.telemetryPath,
      hapiPath: this.options.hapiPath,
      testKinds: this.options.testKinds === true,
    };
    worker.postMessage(init);
    const ping = this.newJob("ping:startup", "ping", {});
    this.pingJob = ping;
    this.post(ping, this.selftestTimeoutMs);
  }

  private onMessage(worker: Worker, event: MessageEvent): void {
    if (worker !== this.worker) return;
    const reply = event.data as WorkerReply;
    if (!reply || reply.type !== "result") return;

    if (this.pingJob && reply.id === this.pingJob.id) {
      const ping = this.pingJob;
      this.pingJob = null;
      if (ping.runTimer) clearTimeout(ping.runTimer);
      if (reply.ok) this.onReady();
      else this.onStartFailed(reply.error);
      return;
    }

    const job = this.inflight;
    if (!job || reply.id !== job.id) return;
    this.inflight = null;
    if (reply.ok) this.settleJob(job, reply.result, false);
    else this.settleJob(job, new Error(reply.error), true);
    this.pump();
  }

  private onReady(): void {
    const wasUnusable = !this.usable || !this.everReady;
    this.phase = "ready";
    this.selftestState = "ok";
    this.everReady = true;
    if (!this.usable) {
      console.log(
        "[telemetry-executor] query worker usable again; leaving degraded mode"
      );
    }
    this.usable = true;
    this.cause = null;
    this.resolveStart({ ok: true });
    if (wasUnusable) this.scheduleRecovery();
    this.pump();
  }

  private onStartFailed(cause: string): void {
    this.selftestState = "failed";
    this.recordFailure();
    this.markUnusable(`selftest failed: ${cause}`);
    this.resolveStart({ ok: false, cause });
    if (this.pingJob) {
      if (this.pingJob.runTimer) clearTimeout(this.pingJob.runTimer);
      this.pingJob = null;
    }
    this.retire(this.backoffDelay());
  }

  private onJobTimeout(job: Job): void {
    if (this.phase === "stopped") return;
    if (job === this.pingJob) {
      this.onStartFailed(
        `the worker did not answer its self-test within ${this.selftestTimeoutMs} ms`
      );
      return;
    }
    if (job !== this.inflight) return;
    this.inflight = null;
    this.settleJob(
      job,
      new TelemetryExecutorError(
        "telemetry_timeout",
        `the Analytics query ran longer than ${Math.round(this.jobTimeoutMs / 1000)} s`
      )
    );
    logTelemetryEvent(
      this.options,
      "error",
      TELEMETRY_EXECUTOR_LOG_CATEGORY,
      `${job.kind} timed out after ${this.jobTimeoutMs} ms; replacing the worker once the running statement returns`
    );
    // A timeout is not a crash: replace the worker as soon as it has closed.
    this.retire(0);
  }

  /** An `error`/`messageerror` from the current worker. */
  private onWorkerEvent(worker: Worker, cause: string): void {
    if (worker !== this.worker) return;
    if (this.phase === "draining" || this.phase === "stopped") return;
    this.onWorkerFault(cause);
  }

  private onWorkerFault(cause: string, alreadyClosed = false): void {
    if (this.phase === "starting") {
      if (alreadyClosed) this.worker = null;
      this.onStartFailed(cause);
      return;
    }
    if (this.phase !== "ready") return;
    const job = this.inflight;
    this.inflight = null;
    if (job) {
      this.settleJob(
        job,
        this.unavailable(`the query worker failed: ${cause}`)
      );
    }
    this.recordFailure();
    logTelemetryEvent(
      this.options,
      "error",
      TELEMETRY_EXECUTOR_LOG_CATEGORY,
      `query worker failed (${this.failuresInWindow()} failure(s) in 10 min): ${cause}`
    );
    if (this.failuresInWindow() >= FAILURES_BEFORE_UNUSABLE) {
      this.markUnusable(
        `the worker failed ${this.failuresInWindow()} times in 10 minutes: ${cause}`
      );
    }
    if (alreadyClosed) {
      this.worker = null;
      this.phase = "draining";
      this.respawnDelayMs = this.backoffDelay();
      this.afterClose();
      return;
    }
    this.retire(this.backoffDelay());
  }

  /** Terminate the current worker and respawn `delayMs` after its `close`. */
  private retire(delayMs: number): void {
    this.respawnDelayMs = delayMs;
    this.phase = "draining";
    const worker = this.worker;
    if (!worker) {
      this.afterClose();
      return;
    }
    this.clearTimer("drainTimer");
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (this.phase === "draining" && this.worker === worker) {
        this.markUnusable(
          `the old worker had not exited ${Math.round(this.drainMaxMs / 1000)} s after terminate()`
        );
      }
    }, this.drainMaxMs);
    // terminate() takes effect only when a running statement returns (P9);
    // nothing new is posted until `close`, so two scans never run at once.
    worker.terminate();
  }

  private onWorkerClose(worker: Worker): void {
    if (worker !== this.worker) return;
    if (this.phase === "stopped") {
      this.worker = null;
      return;
    }
    if (this.phase === "ready" || this.phase === "starting") {
      this.onWorkerFault("the worker exited unexpectedly", true);
      return;
    }
    this.worker = null;
    this.afterClose();
  }

  private afterClose(): void {
    this.clearTimer("drainTimer");
    if (this.phase === "stopped") return;
    this.phase = "backoff";
    this.clearTimer("respawnTimer");
    this.respawnTimer = setTimeout(() => this.spawn(), this.respawnDelayMs);
  }

  private markUnusable(cause: string): void {
    const wasUsable = this.usable;
    this.usable = false;
    this.cause = cause;
    logTelemetryEvent(
      this.options,
      "error",
      TELEMETRY_EXECUTOR_LOG_CATEGORY,
      `query worker unusable, Analytics degraded: ${cause}`
    );
    if (!wasUsable) return;
    // Queued work cannot wait for a worker that may not come back: the cheap
    // reads run in-thread, the scans answer 503 (D1 = option 1).
    const queued = this.queue.splice(0);
    for (const job of queued) {
      if (
        job.kind !== "ping" &&
        job.kind !== "test-spin" &&
        job.kind !== "test-crash" &&
        !EVENTS_SCAN_KINDS.has(job.kind)
      ) {
        try {
          this.settleJob(
            job,
            this.inline.runNow(
              job.kind,
              job.params as TelemetryQueryParams<typeof job.kind>
            ),
            false
          );
        } catch (err) {
          this.settleJob(job, err);
        }
      } else {
        this.settleJob(job, this.unavailableNow());
      }
    }
  }

  private recordSkip(date: string, store: TelemetryStore): void {
    try {
      store.recordAggregateDebt(date);
    } catch (err) {
      logTelemetryEvent(
        this.options,
        "error",
        TELEMETRY_AGGREGATE_LOG_CATEGORY,
        `could not record aggregate debt for ${date}: ${messageOf(err)}`
      );
      return;
    }
    logTelemetryEvent(
      this.options,
      "warn",
      TELEMETRY_AGGREGATE_LOG_CATEGORY,
      `today refresh of ${date} skipped (query worker unavailable); recorded as aggregate debt for the recovery pass`
    );
  }

  private scheduleRecovery(): void {
    const store = this.options.getTelemetryStore();
    if (!store) return;
    if (this.recovering) {
      this.recoverAgain = true;
      return;
    }
    this.recovering = (async () => {
      do {
        this.recoverAgain = false;
        try {
          await this.recoverAggregateDebt(store);
        } catch (err) {
          logTelemetryEvent(
            this.options,
            "warn",
            TELEMETRY_AGGREGATE_LOG_CATEGORY,
            `recovery pass failed: ${messageOf(err)}`
          );
        }
      } while (this.recoverAgain && this.usable && this.phase !== "stopped");
    })().finally(() => {
      this.recovering = null;
    });
  }

  /** Resolves once any recovery pass in progress has finished (tests). */
  async idle(): Promise<void> {
    while (this.recovering) await this.recovering;
  }

  // ── Helpers ─────────────────────────────────────────────

  /** Read fresh: the phase can change while a caller awaits. */
  private isStopped(): boolean {
    return this.phase === "stopped";
  }

  private resolveStart(result: TelemetrySelftestResult): void {
    this.lastStart = result;
    const waiters = this.startWaiters.splice(0);
    for (const resolve of waiters) resolve(result);
  }

  private recordFailure(): void {
    const now = this.now();
    this.failures = this.failures.filter(t => now - t < FAILURE_WINDOW_MS);
    this.failures.push(now);
  }

  private failuresInWindow(): number {
    const now = this.now();
    return this.failures.filter(t => now - t < FAILURE_WINDOW_MS).length;
  }

  private backoffDelay(): number {
    const n = Math.max(1, this.failuresInWindow());
    return Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (n - 1));
  }

  private clearTimer(name: "respawnTimer" | "drainTimer"): void {
    const timer = this[name];
    if (timer) clearTimeout(timer);
    this[name] = null;
  }

  private unavailable(reason: string): TelemetryExecutorError {
    return new TelemetryExecutorError(
      "telemetry_unavailable",
      `the Analytics query worker is unavailable: ${reason}`
    );
  }

  private unavailableNow(): TelemetryExecutorError {
    return this.unavailable(this.cause ?? "worker not running");
  }
}

// ── Boot ───────────────────────────────────────────────────

/**
 * The kill switch. `inline` restores today's in-thread execution for every
 * route, with today's cost: one Analytics load stalls the whole server again.
 * It is the only way back to the old path; nothing selects it automatically.
 */
export const TELEMETRY_EXECUTOR_ENV = "HAPI_TELEMETRY_EXECUTOR";

export interface TelemetryExecutorBootOptions {
  telemetryPath: string;
  hapiPath: string | null;
  telemetryStore: TelemetryStore;
  getTurnAnalytics?: (() => TurnAnalyticsCounts | null) | null;
  errorLogger?: ErrorLogger | null;
  env?: Record<string, string | undefined>;
}

/**
 * Build the server's executor from `HAPI_TELEMETRY_EXECUTOR` (read once) and
 * start it. Worker mode starts the worker at once and logs the self-test
 * result, `[telemetry-executor] mode=worker selftest ok` or `... selftest
 * FAILED: <cause>`, which with `/api/health` is this change's deployment check.
 */
export function createTelemetryExecutorFromEnv(
  options: TelemetryExecutorBootOptions
): TelemetryExecutor {
  const env = options.env ?? process.env;
  const raw = (env[TELEMETRY_EXECUTOR_ENV] ?? "").trim().toLowerCase();
  const store = options.telemetryStore;

  if (raw === "inline") {
    console.warn(
      `[telemetry-executor] mode=inline (env): ${TELEMETRY_EXECUTOR_ENV}=inline runs the Analytics queries on the main thread, so one Analytics load stalls the whole server again`
    );
    const inline = new InlineTelemetryExecutor({
      getTelemetryStore: () => store,
      getTurnAnalytics: options.getTurnAnalytics,
      errorLogger: options.errorLogger,
      reason: `${TELEMETRY_EXECUTOR_ENV}=inline`,
    });
    // Debt left by an earlier degraded run: recompute it here, in-thread.
    if (store.listAggregateDebt().length > 0) {
      void inline
        .recoverAggregateDebt(store)
        .catch(err =>
          logTelemetryEvent(
            options,
            "warn",
            TELEMETRY_AGGREGATE_LOG_CATEGORY,
            `inline recovery pass failed: ${messageOf(err)}`
          )
        );
    }
    return inline;
  }
  if (raw !== "" && raw !== "worker") {
    console.warn(
      `[telemetry-executor] ignoring ${TELEMETRY_EXECUTOR_ENV}=${JSON.stringify(raw)} (expected "worker" or "inline"); using the worker`
    );
  }

  const worker = new WorkerTelemetryExecutor({
    telemetryPath: options.telemetryPath,
    hapiPath: options.hapiPath,
    getTelemetryStore: () => store,
    getTurnAnalytics: options.getTurnAnalytics,
    errorLogger: options.errorLogger,
  });
  void worker.selftest().then(result => {
    if (result.ok) {
      console.log("[telemetry-executor] mode=worker selftest ok");
    } else {
      console.error(
        `[telemetry-executor] mode=worker selftest FAILED: ${result.cause ?? "unknown"} (Analytics degraded: the five scan routes answer 503 until a worker starts)`
      );
    }
  });
  return worker;
}
