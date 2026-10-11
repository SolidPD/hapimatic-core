// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/**
 * Runtime job registry — the read-shape contract for in-process looping
 * services (issue #1963, epic #1960, Sub-Issue C).
 *
 * A "job" here is an in-process `setInterval`/`setTimeout` loop running inside a
 * Hapimatic process (server or daemon). Each supervised loop registers a
 * {@link JobStatus} row at startup and updates `lastTickAt`/`status`/`lastError`
 * as it ticks or stalls. This registry is the PRODUCER side of the contract that
 * Sub-Issue D (#1964, the System Jobs portal) CONSUMES — keep the `JobStatus`
 * shape stable.
 *
 * Lives in `shared/` (not `server/`) because BOTH the server AND the daemon
 * (cli) host in-process loops, and a `server/`-local module would strand the
 * daemon loops. Like `systemJobs.ts`, this module is PURE — no filesystem, no
 * env, no exec. {@link SupervisedLoop} (the loop wrapper that drives a registry)
 * injects its clock + event sink, so even the scheduling primitive imports
 * nothing runtime-specific.
 *
 * Consumed by:
 * - server/src/index.ts — constructs one registry, injects it into each loop,
 *   exposes it via `getJobRegistry()` (the Sub-D contract surface)
 * - cli/src/daemon/run.ts — a daemon-local registry for the daemon's loops
 * - Sub-Issue D (#1964) — reads `list()` and maps each row into a System Jobs
 *   `kind: "in-process-loop"` row
 */

/**
 * Health status of a supervised loop.
 * - `ok` — ticking normally.
 * - `stalled` — the watchdog detected no tick within `stallFactor × intervalMs`
 *   (the exact Bug-2 / #1962 failure mode); the loop is being auto-restarted.
 * - `dead` — a crash loop: the tick threw on `failureThreshold` (default 3)
 *   consecutive cycles with no success in between. Actively emitted by
 *   {@link SupervisedLoop} and the daemon's `tokenRefreshService` (issue #2035,
 *   the perpetual-throw-masking case) so a silently-failing loop goes red and
 *   alerts instead of staying green. Distinct from `stalled` (a hung tick that
 *   never completes); the loop keeps ticking, so a later successful tick
 *   auto-recovers it to `ok`.
 * - `stopped` — `stop()` was called, or the loop is config-disabled.
 */
export type JobHealthStatus = "ok" | "stalled" | "dead" | "stopped";

/**
 * The single LOCKED `kind` value for in-process-loop registry rows. Matches
 * Sub-Issue D's (#1964) system-jobs `kind` discriminator exactly, so D consumes
 * a registry row without a translation step.
 */
export const JOB_KIND_IN_PROCESS_LOOP = "in-process-loop" as const;

/**
 * One registry row. `.passthrough()` lets Sub-Issue D (#1964) add fields without
 * breaking this producer (mirrors the `SystemJobSchema` convention).
 */
export const JobStatusSchema = z
  .object({
    /** Stable job name (e.g. `"usage-sampler"`). Unique per registry. */
    name: z.string().min(1),
    /** Federation nodeId this loop runs on (`federationConfig.nodeId` ?? `"standalone"`). */
    node: z.string().min(1),
    /** LOCKED discriminator — see {@link JOB_KIND_IN_PROCESS_LOOP}. */
    kind: z.literal(JOB_KIND_IN_PROCESS_LOOP),
    /** Nominal cadence in milliseconds. */
    intervalMs: z.number(),
    /**
     * Wall-clock MILLISECONDS of the last completed tick, or `null` before the
     * first tick. NOTE: this is MILLISECONDS, not the systemd microseconds that
     * Sub-Issue D's `SystemJobLiveState.lastRun` uses — D maps ms → its row.
     */
    lastTickAt: z.number().nullable(),
    /** Current health — see {@link JobHealthStatus}. */
    status: z.enum(["ok", "stalled", "dead", "stopped"]),
    /** Last error message (tick throw or stall), or `null` when healthy. */
    lastError: z.string().nullable(),
  })
  .passthrough();

export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * Structured failure event emitted on stall/death. Routed by the server to
 * `ErrorLogger.warn` (and by Sub-Issue D #1964 to a durable, non-Toast alert
 * channel). The PRODUCER emits these; the durable alert routing is Sub-D's.
 */
export interface JobFailureEvent {
  /** The job's stable name. */
  name: string;
  /** The federation nodeId. */
  node: string;
  /**
   * The status that triggered the event: `"stalled"` for a hung tick, or
   * `"dead"` for a crash loop (N consecutive caught throws — issue #2035).
   */
  status: JobHealthStatus;
  /** Human-readable error/cause, or `null`. */
  error: string | null;
  /** Wall-clock ms when the event fired. */
  at: number;
}

/**
 * In-memory registry of supervised-loop status rows. One instance per process.
 *
 * Pure data structure — no I/O, no timers. {@link SupervisedLoop} drives it;
 * read surfaces (the server's `getJobRegistry()` getter) call {@link list}.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobStatus>();
  private eventSink: ((event: JobFailureEvent) => void) | null = null;

  /** Register (or replace) a job row, keyed by `status.name`. Idempotent. */
  register(status: JobStatus): void {
    this.jobs.set(status.name, status);
  }

  /**
   * Patch an existing job row. No-op if the name is unknown (a loop must
   * `register()` before `update()`). Never throws on an unknown name so a
   * stray update from an in-flight tick after `unregister()` cannot crash the
   * caller.
   */
  update(name: string, patch: Partial<JobStatus>): void {
    const current = this.jobs.get(name);
    if (!current) return;
    this.jobs.set(name, { ...current, ...patch });
  }

  /** Remove a job row. Idempotent. */
  unregister(name: string): void {
    this.jobs.delete(name);
  }

  /** Read one job row, or `undefined` if unregistered. */
  get(name: string): JobStatus | undefined {
    return this.jobs.get(name);
  }

  /**
   * Snapshot of all registered job rows — the read surface Sub-Issue D (#1964)
   * consumes. Returns a fresh array (callers cannot mutate internal state).
   */
  list(): JobStatus[] {
    return [...this.jobs.values()];
  }

  /**
   * Set the single failure-event sink. The server routes it to ErrorLogger
   * (#1963 R6 — the producer side of Sub-D's durable non-Toast alert). One
   * sink per registry; a SupervisedLoop with no explicit onEvent falls back
   * to this, so the sink is wired once in index.ts rather than per service.
   */
  setEventSink(sink: (event: JobFailureEvent) => void): void {
    this.eventSink = sink;
  }

  /** Emit a failure event to the sink (if any). Never throws. */
  emitEvent(event: JobFailureEvent): void {
    if (!this.eventSink) return;
    try {
      this.eventSink(event);
    } catch {
      // The event sink must never crash the registry or its loops.
    }
  }
}
