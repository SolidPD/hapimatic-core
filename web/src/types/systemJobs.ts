// SPDX-License-Identifier: AGPL-3.0-only
import type { SystemJob, JobStatus } from "@hapi/protocol";

/**
 * Web-side view types for the System Jobs admin section (issue #1538, Sub-Issue D
 * of epic #1534).
 *
 * The registry entry shape (`SystemJob`) is the shared, single-source-of-truth
 * type from `@hapi/protocol` (`shared/src/systemJobs.ts`, issue #1535). The
 * live-state, merged-view, and aggregate-response shapes live in the SERVER
 * package (`server/src/systemJobs/service.ts` + `server/src/web/routes/systemJobs.ts`,
 * issues #1536/#1537) which `web` cannot import — so they are mirrored here as
 * plain type aliases (the client casts JSON via `request<T>()`, the same
 * convention used by `SchedulesResponse` / `FederationAllSessionsResponse`).
 *
 * Bound to the #1537 node-scoped surface (epic #1534 ruling D1):
 *   GET  /api/system-jobs/all                      → SystemJobsAllResponse
 *   GET  /api/nodes/:nodeId/system-jobs            → { ok, jobs: SystemJobView[] }
 *   POST /api/nodes/:nodeId/system-jobs/:name/...  → SystemJobMutateResult
 */

export type { SystemJob, JobStatus };

/**
 * Live runtime state of a job's systemd timer, or `unsupported` on a
 * non-systemd host. `nextRun`/`lastRun` are MICROSECONDS since epoch (systemd
 * convention) — divide by 1000 before constructing a JS `Date`.
 */
export type SystemJobLiveState =
  | {
      code: "ok";
      enabled: boolean;
      active: boolean;
      nextRun: number | null;
      lastRun: number | null;
      journalTail: string;
    }
  | { code: "unsupported" };

/** A systemd-timer registry entry merged with its live timer state. */
export type SystemdTimerJobView = {
  kind: "systemd-timer";
  job: SystemJob;
  liveState: SystemJobLiveState;
};

/**
 * An in-process supervised-loop row, sourced from Sub-Issue C's (#1963) runtime
 * job registry (`JobStatus`). `loop.lastTickAt` is MILLISECONDS (NOT the systemd
 * microseconds of `SystemJobLiveState.lastRun`) — render with a ms formatter
 * (`new Date(ms)`), not the micros divide-by-1000.
 */
export type InProcessLoopJobView = {
  kind: "in-process-loop";
  loop: JobStatus;
};

/** An OS-cron discovery row (#1964 PR3) — mirrors the server `OsCronRow`. */
export type OsCronRow = {
  schedule: string;
  command: string;
  line: string;
};

/** A read-only OS-cron row (#1964 PR3). */
export type OsCronJobView = {
  kind: "os-cron";
  cron: OsCronRow;
};

/**
 * Loop-cron badge/summary state (issue #2453, R1). Mirrors the server
 * `LoopCronState` — `worstState` in the summary is exactly these three.
 */
export type LoopCronState = "live" | "paused" | "stalled";

/**
 * The widened Run-now / run-history verdict (issue #2453, R4/D2). Mirrors the
 * server `LoopCronVerdict`: the script emits six DECISION values + eleven tick
 * outcomes, so a 4-member enum could not represent a failed send, an auth
 * failure, or a self-terminated loop. `unknown` is the honest catch-all — never
 * a success fallback.
 */
export type LoopCronVerdict =
  | "sent"
  | "send-failed"
  | "skipped:paused"
  | "skipped:gate"
  | "skipped:backoff"
  | "skipped:concurrent"
  | "done"
  | "error:token"
  | "error:auth"
  | "error:session-state"
  | "error:action-empty"
  | "unknown";

/** One parsed recent tick.log terminal outcome (newest first in `runHistory`). */
export type LoopCronRunEntry = {
  atMs: number | null;
  verdict: LoopCronVerdict;
  message: string;
};

/**
 * Normalized loop-cron record (issue #2453) — MIRRORS the server `LoopCronInfo`
 * in `server/src/systemJobs/loopCronReader.ts`. All timestamps are ms numbers
 * (NOT ISO strings — the union already carries systemd µs + in-process-loop ms;
 * a third unit is forbidden). Every config-derived field is optional/nullable
 * per the server's optionality warning (older state dirs lack half the fields).
 * Next-fire, state derivation, ms conversion, and `instanceLabel` are all
 * computed server-side, so the web renders precomputed values.
 */
export type LoopCronInfo = {
  id: string;
  label: string;
  sessionUuid: string | null;
  sessionTag: string | null;
  apiBase: string | null;
  apiBasePort: number | null;
  instanceLabel: string;
  settings: string | null;
  intervalHuman: string | null;
  intervalCron: string | null;
  gateCommand: string | null;
  heartbeatTicks: number | null;
  consecutiveNoops: number | null;
  userBackoffWindowS: number | null;
  effectiveBackoffS: number;
  modelWatch: string | null;
  doneSentinel: string | null;
  paused: boolean;
  ticks: number | null;
  /** The full nine-value last_status vocabulary (armed/paused/resumed/stopped/done/user-backoff/gate-noop/sent/send-failed). */
  lastStatus: string | null;
  createdAtMs: number | null;
  lastTickAtMs: number | null;
  pausedAtMs: number | null;
  doneAtMs: number | null;
  lastUserActivityAtMs: number | null;
  newestTickLogAtMs: number | null;
  nextFireAtMs: number | null;
  state: LoopCronState;
  degraded: boolean;
  done: boolean;
  hasCrontabLine: boolean;
  action: string | null;
  runHistory: LoopCronRunEntry[];
};

/** A first-class loop-cron row (issue #2453) — mirrors the server `LoopCronJobView`. */
export type LoopCronJobView = {
  kind: "loop-cron";
  loop: LoopCronInfo;
};

/**
 * A System Jobs row (issue #1964, #2453) — discriminated on `kind`. Mirrors the
 * server union in `server/src/systemJobs/service.ts` (web cannot import server).
 */
export type SystemJobView =
  | SystemdTimerJobView
  | InProcessLoopJobView
  | OsCronJobView
  | LoopCronJobView;

/** Per-loop row inside a `SessionLoopSummary` (issue #2453, R2/R8). */
export type SessionLoopSummaryRow = {
  id: string;
  label: string;
  state: LoopCronState;
  scheduleHuman: string;
  nextFireAtMs: number | null;
  apiBase: string;
  instanceLabel: string;
};

/**
 * One session's own-instance loop summary (issue #2453, R8) — the header badge's
 * per-session slice. `worstState` drives the badge color.
 */
export type SessionLoopSummary = {
  sessionId: string;
  worstState: LoopCronState;
  count: number;
  loops: SessionLoopSummaryRow[];
};

/** Response of `GET /api/nodes/:nodeId/system-jobs/session-loop-summary`. */
export type SessionLoopSummaryResponse = {
  ok: true;
  summaries: SessionLoopSummary[];
};

/** One node's slice of the aggregate session-loop summary. */
export type SessionLoopSummaryNode = {
  nodeId: string;
  nodeLabel: string;
  status: string;
  summaries: SessionLoopSummary[];
};

/** Response of `GET /api/system-jobs/session-loop-summary/all`. */
export type SessionLoopSummaryAllResponse = {
  ok: true;
  nodes: SessionLoopSummaryNode[];
};

/** The verdict envelope a loop-cron `run` returns (issue #2453, R4). */
export type LoopCronRunResult = {
  ok: true;
  action: "run";
  result: {
    verdict: LoopCronVerdict;
    decision: string | null;
    exitCode: number;
    timedOut: boolean;
  };
};

/** The echo envelope a loop-cron pause/resume/delete returns. */
export type LoopCronMutationResult = {
  ok: true;
  action: "pause" | "resume" | "delete";
  result: {
    ok: boolean;
    id: string;
    label: string | null;
    sessionTag: string | null;
    verb: "paused" | "resumed" | "stopped" | "purged";
  };
};

/** The envelope a loop-cron reschedule returns. */
export type LoopCronRescheduleResult = {
  ok: true;
  action: "reschedule";
  result: { ok: boolean; id: string; interval: string; firstTickNote?: string };
};

/** The envelope a loop-cron action/prompt edit returns (#3293). */
export type LoopCronUpdateActionResult = {
  ok: true;
  action: "edit-action";
  result: { ok: boolean; id: string; actionText: string };
};

/**
 * One node's slice of the cross-node aggregate. A node entry carries EITHER
 * `jobs` (responded OK) OR `error`+`code` (unreachable / errored) — never both.
 * Per-node graceful degradation is built into this shape (#1537 R1/R2).
 */
export type SystemJobsNode = {
  nodeId: string;
  nodeLabel: string;
  status: string;
  jobs?: SystemJobView[];
  error?: string;
  code?: string;
};

/** Response of `GET /api/system-jobs/all` (the cross-node aggregate). */
export type SystemJobsAllResponse = {
  ok: true;
  nodes: SystemJobsNode[];
};

/** Result of any per-node mutation (enable/disable/delete/reschedule/rename/description). */
export type SystemJobMutateResult =
  | { ok: true }
  | { ok: false; error: string; code: string };
