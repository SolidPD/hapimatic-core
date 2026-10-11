// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";

import {
  SystemJobSchema,
  type SystemJob,
  type JobStatus,
  type JobRegistry,
} from "@hapi/protocol";

import type { ErrorLogger } from "../logging/errorLogger";
import {
  readCurrentState,
  reconcile,
  systemctlAvailable,
  type CurrentUnitState,
  type ReconcileOptions,
  type ReconcilePlan,
} from "./reconciler";
import { SystemJobsStore } from "./store";
import { OsCronReader, type OsCronRow } from "./osCronReader";
import {
  LoopCronReader,
  type LoopCronInfo,
  type LoopCronState,
} from "./loopCronReader";
import {
  LoopCronController,
  LoopCronError,
  type LoopCronMutationResult,
  type RunNowResult,
  type LoopCronArmResult,
  type LoopCronEditActionResult,
} from "./loopCronController";

/**
 * In-process per-node system-jobs engine (issue #1536, epic #1534 ruling D1).
 *
 * Composes the runtime-mutable registry store (`./store`) with the idempotent
 * reconciler (`./reconciler`). Owns LIST (registry merged with live timer
 * state) and the six MUTATE verbs (enable / disable / remove / reschedule /
 * rename / editDescription). `command` is NOT mutable (R9) — there is no verb
 * for it. Consumed in-process by:
 *   - the federation peer receivers (`web/routes/federation/systemJobs.ts`, #1536)
 *   - the #1537 web-client surface (`/api/nodes/:nodeId/system-jobs/*`)
 *
 * Validation is owned by the SHARED schema (ruling D2): every field-bearing
 * mutate verb re-parses the candidate entry through `SystemJobSchema`, so the
 * control-char / length / format rules live in exactly one place.
 *
 * Every mutation runs `validate -> dry-run reconcile (conflict pre-check) ->
 * persist -> apply`. The dry-run BEFORE persisting prevents a name-conflict from
 * leaving the registry and the OS out of sync (a rename onto a foreign unit must
 * fail without having already pruned the old unit).
 *
 * All host interaction is funneled through a single injectable `SystemdBackend`
 * (default = the real reconciler + `systemctl`/`journalctl` queries). Tests pass
 * a fake backend so the suite is hermetic — no real unit files written, no
 * `systemctl enable` run.
 */

/** Structured error codes — the mcp-toggle convention (sessions.ts). */
export type SystemJobsErrorCode =
  | "invalid_request"
  | "validation_failed"
  | "job_not_found"
  | "name_conflict"
  | "reconcile_failed"
  | "unsupported"
  | "unknown";

/** Live runtime state of a job's timer, or `unsupported` on non-systemd hosts. */
export type SystemJobLiveState =
  | {
      code: "ok";
      enabled: boolean;
      active: boolean;
      /** systemd next-elapse (microseconds since epoch), or null if unscheduled. */
      nextRun: number | null;
      /** systemd last-trigger (microseconds since epoch), or null if never run. */
      lastRun: number | null;
      /** Recent `journalctl` tail for `<name>.timer` (best-effort; "" on failure). */
      journalTail: string;
    }
  | { code: "unsupported" };

/** A systemd-timer registry entry merged with its live timer state (R1). */
export interface SystemdTimerJobView {
  kind: "systemd-timer";
  job: SystemJob;
  liveState: SystemJobLiveState;
}

/**
 * An in-process supervised-loop row, sourced from Sub-Issue C's (#1963) runtime
 * job registry. `loop` is the LOCKED `JobStatus` read shape, and `kind` already
 * equals C's `JOB_KIND_IN_PROCESS_LOOP`, so a registry row maps in without
 * translation (issue #1964, Sub-Issue D). NOTE: `loop.lastTickAt` is
 * MILLISECONDS (NOT the systemd microseconds of `SystemJobLiveState.lastRun`) —
 * the web row maps ms → display.
 */
export interface InProcessLoopJobView {
  kind: "in-process-loop";
  loop: JobStatus;
}

/**
 * An OS-cron read-only discovery row (#1964 PR3) — a `crontab -l` entry. Neither
 * managed nor stall-detected; plain discovery so the portal shows every kind.
 */
export interface OsCronJobView {
  kind: "os-cron";
  cron: OsCronRow;
}

/**
 * A first-class loop-cron row (issue #2453) — a `loop-cron.sh` crontab line
 * (`# LOOP-CRON:<id>` marker, Task 1) joined with its `~/.claude/state/loop-cron/
 * <id>/` config/action/tick.log (Task 2). Server-authoritative; the web mirror
 * lives in `web/src/types/systemJobs.ts`.
 */
export interface LoopCronJobView {
  kind: "loop-cron";
  loop: LoopCronInfo;
}

/**
 * A System Jobs row (issue #1964, #2453). Discriminated on `kind`: `systemd-timer`
 * (the existing declarative timer merged with live systemd state),
 * `in-process-loop` (a supervised loop from #1963's runtime registry),
 * `os-cron` (read-only `crontab -l` discovery), or `loop-cron` (a managed
 * `loop-cron.sh` recurring session prompt, #2453).
 */
export type SystemJobView =
  | SystemdTimerJobView
  | InProcessLoopJobView
  | OsCronJobView
  | LoopCronJobView;

/**
 * Per-loop row inside a `SessionLoopSummary` (issue #2453, R2/R8). Required —
 * the badge dropdown needs them and Task 12 forbids N per-session requests, so
 * the batch payload carries them.
 */
export interface SessionLoopSummaryRow {
  id: string;
  label: string;
  state: LoopCronState;
  scheduleHuman: string;
  nextFireAtMs: number | null;
  apiBase: string;
  instanceLabel: string;
}

/**
 * One session's own-instance loop summary (issue #2453, R8). The badge reads its
 * per-session slice from this batch payload; `worstState` drives the badge color
 * (mint=live, amber=paused, red=stalled).
 */
export interface SessionLoopSummary {
  sessionId: string;
  worstState: LoopCronState;
  count: number;
  loops: SessionLoopSummaryRow[];
}

export type ListJobsResult =
  | { ok: true; jobs: SystemJobView[] }
  | { ok: false; error: string; code: SystemJobsErrorCode };

export type MutateResult =
  | { ok: true }
  | { ok: false; error: string; code: SystemJobsErrorCode };

/**
 * The six mutate verbs — single source of truth shared by the federation
 * receiver (`web/routes/federation/systemJobs.ts`), the #1537 web-client route
 * (`web/routes/systemJobs.ts`), and the NodeRegistry proxy wrapper. Keeping the
 * verb set here prevents silent drift if a seventh verb is ever added.
 */
export const SYSTEM_JOB_VERBS = [
  "enable",
  "disable",
  "delete",
  "reschedule",
  "rename",
  "edit-description",
] as const;

export type SystemJobVerb = (typeof SYSTEM_JOB_VERBS)[number];

/**
 * Wire shape of a per-node mutate request body: the web-client route forwards
 * this to `NodeRegistry.mutateSystemJobOnNode`, which POSTs it to the peer
 * receiver. `delete` maps to `service.remove`, `edit-description` to
 * `service.editDescription` (see the receiver's dispatch).
 */
export interface SystemJobMutateBody {
  verb: SystemJobVerb;
  name: string;
  args?: { schedule?: string; newName?: string; description?: string };
}

/**
 * Wire shape of a loop-cron mutation (issue #2453). Deliberately SEPARATE from
 * `SystemJobMutateBody` — loop-cron verbs are out-of-process `loop-cron.sh`
 * subcommands, keyed on the arm-time `<id>` (not a systemd unit name), and `run`
 * returns a verdict. Shared by the web-client route (Task 5) and the federation
 * receiver (Task 6) so the two dispatch identically.
 */
export interface LoopCronMutateBody {
  action: "pause" | "resume" | "run" | "delete" | "reschedule" | "edit-action";
  id: string;
  /** Required for `reschedule` (the new interval, e.g. `6m`). */
  interval?: string;
  /**
   * Required for `edit-action` (#3293) — the new action/prompt text. A SEPARATE
   * key from the `action` discriminator (which is the verb), never overloaded.
   */
  actionText?: string;
}

/** HTTP status a loop-cron mutation can surface (subset of `ContentfulStatusCode`). */
export type LoopCronStatus = 400 | 404 | 500 | 504;

/** The wire result of a dispatched loop-cron mutation. */
export type LoopCronDispatchResult =
  | {
      ok: true;
      action: LoopCronMutateBody["action"];
      result:
        | LoopCronMutationResult
        | RunNowResult
        | LoopCronArmResult
        | LoopCronEditActionResult;
    }
  | { ok: false; error: string; code: string; status: LoopCronStatus };

/** systemd next/last elapse for one timer unit (microseconds since epoch). */
export interface TimerTimes {
  next: number | null;
  last: number | null;
}

/**
 * The host-interaction surface. The real implementation wraps the reconciler
 * plus `systemctl`/`journalctl`; tests inject a fake for hermetic runs.
 */
export interface SystemdBackend {
  available(): boolean;
  reconcile(
    manifest: SystemJob[],
    nodeId: string,
    opts?: ReconcileOptions
  ): ReconcilePlan;
  readCurrentState(nodeId: string): CurrentUnitState[];
  listTimers(): Map<string, TimerTimes>;
  journalTail(name: string): string;
}

export interface SystemJobsServiceDeps {
  /** Data directory rooting the registry JSON (typically `configuration.dataDir`). */
  dataDir: string;
  /** Resolves this node's federation id; null when federation is unconfigured. */
  getLocalNodeId: () => string | null;
  errorLogger?: ErrorLogger | null;
  /**
   * Sub-Issue C's (#1963) runtime job registry getter — the in-process-loop
   * data source for the System Jobs portal (#1964). Optional: a null/absent
   * registry (older peer, early boot, or a process without supervised loops)
   * yields zero in-process-loop rows, never an error.
   */
  getJobRegistry?: () => JobRegistry | null;
  /**
   * #1964 (Sub-D): cached daemon-process job rows (the DaemonJobsMonitor
   * snapshot). Merged into listJobs() as in-process-loop rows; a name present in
   * both the server and daemon registries prefers the server's own row.
   */
  getDaemonJobs?: () => JobStatus[];
  /** Test seam (#1964 PR3) — returns raw `crontab -l` output for OS-cron rows. */
  runCrontab?: () => string;
  /** Test seam — defaults to the real reconciler + systemctl/journalctl. */
  backend?: SystemdBackend;
  /**
   * Issue #2453 — loop-cron reader (state-dir join). Opt-in: injected in
   * production, omitted in most tests (→ zero loop-cron rows, never an error).
   */
  loopCronReader?: LoopCronReader | null;
  /** Issue #2453 — loop-cron mutation controller (the sole write path, R9). */
  loopCronController?: LoopCronController | null;
  /**
   * Issue #2453 (D5) — this server's own listen port, the own-instance
   * discriminator for `sessionLoopSummary()`. Null → no own-instance filtering
   * possible → the badge summary is empty (fail-safe: never a wrong-instance badge).
   */
  getListenPort?: () => number | null;
}

export class SystemJobsService {
  private readonly store: SystemJobsStore;
  private readonly backend: SystemdBackend;
  private readonly osCronReader: OsCronReader | null;
  private readonly loopCronReader: LoopCronReader | null;
  private readonly loopCronController: LoopCronController | null;

  constructor(private readonly deps: SystemJobsServiceDeps) {
    this.store = new SystemJobsStore(deps.dataDir);
    this.backend = deps.backend ?? defaultSystemdBackend();
    // OS-cron is opt-in: only constructed when a runCrontab is wired (the
    // server passes the real readHostCrontab). With none provided — e.g. tests
    // and non-cron hosts — os-cron reading is skipped entirely (hermetic).
    this.osCronReader = deps.runCrontab
      ? new OsCronReader({
          errorLogger: deps.errorLogger,
          runCrontab: deps.runCrontab,
        })
      : null;
    // Loop-cron (#2453) is opt-in via direct injection (reads the fs + shells
    // out to loop-cron.sh) — absent → zero loop-cron rows, never an error.
    this.loopCronReader = deps.loopCronReader ?? null;
    this.loopCronController = deps.loopCronController ?? null;
  }

  /**
   * List this node's registry entries merged with live timer state (R1). On a
   * host without `systemctl --user` (or with no resolvable node id), each entry
   * still returns, with `liveState: {code:"unsupported"}` (R8).
   */
  listJobs(): ListJobsResult {
    const nodeId = this.deps.getLocalNodeId();
    let registry: SystemJob[];
    try {
      registry = this.store.load();
    } catch (e) {
      this.logError("listJobs: failed to load registry", e);
      return {
        ok: false,
        code: "unknown",
        error: `failed to load system-jobs registry: ${errMsg(e)}`,
      };
    }

    const timerJobs = nodeId ? registry.filter(j => j.node === nodeId) : [];

    // In-process supervised-loop rows (#1964 Sub-D) — sourced from Sub-Issue C's
    // (#1963) runtime job registry. INDEPENDENT of systemd availability: these
    // are in-memory JS loops, so they surface even on a non-systemd host where
    // the timers report `unsupported`. `kind` already matches C's locked
    // discriminator, so no per-row translation is needed.
    const localLoops = this.deps.getJobRegistry?.()?.list() ?? [];
    const localNames = new Set(localLoops.map(j => j.name));
    // Merge the daemon process's loops (#1964 Option A — a co-located separate
    // process the server pulls via DaemonJobsMonitor). A name present in both
    // prefers the server's own row.
    const daemonLoops = (this.deps.getDaemonJobs?.() ?? []).filter(
      j => !localNames.has(j.name)
    );
    const loopViews: SystemJobView[] = [...localLoops, ...daemonLoops].map(
      loop => ({ kind: "in-process-loop" as const, loop })
    );
    // OS-cron read-only rows (#1964 PR3) — independent of systemd + the registry.
    // #2453: a loop-cron.sh line carries a `# LOOP-CRON:<id>` marker (Task 1); those
    // rows are lifted OUT of os-cron and rendered as first-class loop-cron cards, so
    // a managed loop never shows twice.
    const osCronRows = this.osCronReader?.read() ?? [];
    const osCronViews: SystemJobView[] = osCronRows
      .filter(row => !row.loopCronId)
      .map(cron => ({ kind: "os-cron" as const, cron }));
    const loopCronViews: SystemJobView[] = this.readLoopCronInfos(
      osCronRows
    ).map(loop => ({ kind: "loop-cron" as const, loop }));

    if (!this.backend.available() || !nodeId) {
      return {
        ok: true,
        jobs: [
          ...timerJobs.map(job => ({
            kind: "systemd-timer" as const,
            job,
            liveState: { code: "unsupported" as const },
          })),
          ...loopViews,
          ...osCronViews,
          ...loopCronViews,
        ],
      };
    }

    const currentByName = new Map<string, CurrentUnitState>(
      this.backend.readCurrentState(nodeId).map(c => [c.name, c])
    );
    const timersByUnit = this.backend.listTimers();

    return {
      ok: true,
      jobs: [
        ...timerJobs.map(job => {
          const cur = currentByName.get(job.name);
          const timer = timersByUnit.get(`${job.name}.timer`);
          return {
            kind: "systemd-timer" as const,
            job,
            liveState: {
              code: "ok" as const,
              enabled: cur?.enabled ?? false,
              active: cur?.active ?? false,
              nextRun: timer?.next ?? null,
              lastRun: timer?.last ?? null,
              journalTail: this.backend.journalTail(job.name),
            },
          };
        }),
        ...loopViews,
        ...osCronViews,
        ...loopCronViews,
      ],
    };
  }

  // ─── loop-cron (issue #2453) ─────────────────────────────────

  /**
   * Read this host's loop-cron rows: the union of crontab-marked ids (Task 1)
   * and on-disk state dirs (Task 2). Best-effort; `[]` when no reader is wired.
   * Accepts the already-read os-cron rows so `listJobs()` does not read twice.
   */
  private readLoopCronInfos(osCronRows?: OsCronRow[]): LoopCronInfo[] {
    if (!this.loopCronReader) return [];
    const rows = osCronRows ?? this.osCronReader?.read() ?? [];
    const ids = rows
      .filter(row => row.loopCronId)
      .map(row => row.loopCronId as string);
    return this.loopCronReader.read(ids);
  }

  /** Ids of every discovered loop (crontab ∪ state) — the controller allowlist. */
  private knownLoopIds(): string[] {
    return this.readLoopCronInfos().map(i => i.id);
  }

  /**
   * Batch session→loop summary for the header badge (R8). Groups own-instance
   * loops by `session_uuid`, computes the worst state, and carries the per-loop
   * rows R2's dropdown needs. Own-instance filter (D5): compare each loop's
   * `api_base` PORT to this server's listen port — NOT full-URL equality (all
   * live configs are `http://localhost:3008`) and NOT `settings` (derived from
   * `api_base`, strictly less independent). A null listen port yields `[]`.
   */
  sessionLoopSummary(): SessionLoopSummary[] {
    const listenPort = this.deps.getListenPort?.() ?? null;
    if (listenPort === null) return [];
    const own = this.readLoopCronInfos().filter(
      i => i.sessionUuid !== null && i.apiBasePort === listenPort
    );
    const bySession = new Map<string, LoopCronInfo[]>();
    for (const loop of own) {
      const key = loop.sessionUuid as string;
      const arr = bySession.get(key);
      if (arr) arr.push(loop);
      else bySession.set(key, [loop]);
    }
    const rank: Record<LoopCronState, number> = {
      live: 0,
      paused: 1,
      stalled: 2,
    };
    const out: SessionLoopSummary[] = [];
    for (const [sessionId, loops] of bySession) {
      const worstState = loops.reduce<LoopCronState>(
        (w, l) => (rank[l.state] > rank[w] ? l.state : w),
        "live"
      );
      out.push({
        sessionId,
        worstState,
        count: loops.length,
        loops: loops.map(l => ({
          id: l.id,
          label: l.label,
          state: l.state,
          scheduleHuman: l.intervalHuman ?? l.intervalCron ?? "",
          nextFireAtMs: l.nextFireAtMs,
          apiBase: l.apiBase ?? "",
          instanceLabel: l.instanceLabel,
        })),
      });
    }
    return out;
  }

  /**
   * Own-instance loops bound to a session (issue #2453, Task 7). Matches
   * `session_uuid` OR `session_tag` (a claim's key may be either) AND own-instance
   * identity (port compare, D5). Used by the lifecycle coupler to auto-pause /
   * resume / purge a session's loops. Best-effort; `[]` when no reader is wired.
   */
  loopsBoundToSession(sessionId: string): LoopCronInfo[] {
    const listenPort = this.deps.getListenPort?.() ?? null;
    return this.readLoopCronInfos().filter(
      l =>
        (l.sessionUuid === sessionId || l.sessionTag === sessionId) &&
        (listenPort === null || l.apiBasePort === listenPort)
    );
  }

  /** Pause a loop (R5 toggle-off). Delegates to the controller (sole write path). */
  loopCronPause(id: string): Promise<LoopCronMutationResult> {
    return this.requireLoopController().pause(id, this.knownLoopIds());
  }

  /** Resume a loop (R5 toggle-on). */
  loopCronResume(id: string): Promise<LoopCronMutationResult> {
    return this.requireLoopController().resume(id, this.knownLoopIds());
  }

  /** Delete a loop = `purge` (D1) — removes the crontab line AND the state dir. */
  loopCronDelete(id: string): Promise<LoopCronMutationResult> {
    return this.requireLoopController().deleteLoop(id, this.knownLoopIds());
  }

  /** Run a real tick now and return its verdict (R4). */
  loopCronRunNow(id: string): Promise<RunNowResult> {
    return this.requireLoopController().runNow(id, this.knownLoopIds());
  }

  /** Edit schedule = stop + `arm --id --no-probe` (R5/D3), identity-preserving. */
  loopCronReschedule(id: string, interval: string): Promise<LoopCronArmResult> {
    return this.requireLoopController().editSchedule(
      id,
      interval,
      this.knownLoopIds()
    );
  }

  /**
   * Edit action/prompt (#3293) = a guarded direct `action.txt` write via the
   * controller (the sole write path). NO crontab re-arm — the content is read at
   * tick time. Empty text is rejected by the controller.
   */
  loopCronUpdateAction(
    id: string,
    actionText: string
  ): Promise<LoopCronEditActionResult> {
    return this.requireLoopController().editAction(
      id,
      actionText,
      this.knownLoopIds()
    );
  }

  private requireLoopController(): LoopCronController {
    if (!this.loopCronController) {
      throw new LoopCronError(
        "loop-cron controller is not configured on this node",
        "exec-failed"
      );
    }
    return this.loopCronController;
  }

  enable(name: string): MutateResult {
    return this.applyMutation((registry, nodeId) =>
      this.setEnabled(registry, nodeId, name, true)
    );
  }

  disable(name: string): MutateResult {
    return this.applyMutation((registry, nodeId) =>
      this.setEnabled(registry, nodeId, name, false)
    );
  }

  remove(name: string): MutateResult {
    return this.applyMutation((registry, nodeId) => {
      const idx = registry.findIndex(j => j.name === name && j.node === nodeId);
      if (idx === -1) return jobNotFound(name, nodeId);
      return registry.filter(j => !(j.name === name && j.node === nodeId));
    });
  }

  reschedule(name: string, schedule: string): MutateResult {
    return this.applyMutation((registry, nodeId) =>
      this.patchField(registry, nodeId, name, { schedule })
    );
  }

  editDescription(name: string, description: string): MutateResult {
    return this.applyMutation((registry, nodeId) =>
      this.patchField(registry, nodeId, name, { description })
    );
  }

  rename(name: string, newName: string): MutateResult {
    return this.applyMutation((registry, nodeId) => {
      const idx = registry.findIndex(j => j.name === name && j.node === nodeId);
      if (idx === -1) return jobNotFound(name, nodeId);
      if (registry.some(j => j.name === newName && j.node === nodeId)) {
        return {
          ok: false,
          code: "name_conflict",
          error: `a job named "${newName}" already exists on node "${nodeId}"`,
        };
      }
      const parsed = SystemJobSchema.safeParse({
        ...registry[idx],
        name: newName,
      });
      if (!parsed.success) {
        return {
          ok: false,
          code: "validation_failed",
          error: parsed.error.message,
        };
      }
      const next = registry.slice();
      next[idx] = parsed.data;
      return next;
    });
  }

  // ─── internals ─────────────────────────────────────────────

  /** Shared enable/disable transform. */
  private setEnabled(
    registry: SystemJob[],
    nodeId: string,
    name: string,
    enabled: boolean
  ): SystemJob[] | MutateResult {
    const idx = registry.findIndex(j => j.name === name && j.node === nodeId);
    if (idx === -1) return jobNotFound(name, nodeId);
    const next = registry.slice();
    next[idx] = { ...next[idx], enabled };
    return next;
  }

  /**
   * Shared single-field patch transform for `schedule` / `description`. Re-parses
   * the candidate through the shared schema so control-char / format rejection
   * (R3) happens BEFORE persistence. `command` is structurally unreachable here.
   */
  private patchField(
    registry: SystemJob[],
    nodeId: string,
    name: string,
    field: Partial<Pick<SystemJob, "schedule" | "description">>
  ): SystemJob[] | MutateResult {
    const idx = registry.findIndex(j => j.name === name && j.node === nodeId);
    if (idx === -1) return jobNotFound(name, nodeId);
    const parsed = SystemJobSchema.safeParse({ ...registry[idx], ...field });
    if (!parsed.success) {
      return {
        ok: false,
        code: "validation_failed",
        error: parsed.error.message,
      };
    }
    const next = registry.slice();
    next[idx] = parsed.data;
    return next;
  }

  /**
   * Run a mutation: resolve node + systemd support, transform the registry,
   * dry-run reconcile to catch foreign-unit conflicts BEFORE persisting, then
   * persist and apply.
   */
  private applyMutation(
    transform: (
      registry: SystemJob[],
      nodeId: string
    ) => SystemJob[] | MutateResult
  ): MutateResult {
    const nodeId = this.deps.getLocalNodeId();
    if (!nodeId) {
      return {
        ok: false,
        code: "unsupported",
        error: "no local federation node id is configured",
      };
    }
    if (!this.backend.available()) {
      return {
        ok: false,
        code: "unsupported",
        error: "systemd user timers are not available on this host",
      };
    }

    let registry: SystemJob[];
    try {
      registry = this.store.load();
    } catch (e) {
      this.logError("mutation: failed to load registry", e);
      return { ok: false, code: "unknown", error: errMsg(e) };
    }

    const outcome = transform(registry, nodeId);
    if (!Array.isArray(outcome)) return outcome; // early error result
    const candidate = outcome;

    // Conflict pre-check via dry-run — abort BEFORE persisting so a name
    // conflict cannot leave the registry and the OS out of sync.
    const conflict = this.detectConflict(candidate, nodeId);
    if (conflict) return conflict;

    try {
      this.store.save(candidate);
    } catch (e) {
      // save() validates; a failure here is a malformed candidate (e.g. a
      // duplicate that slipped past the transform).
      return { ok: false, code: "validation_failed", error: errMsg(e) };
    }

    try {
      const plan = this.backend.reconcile(this.store.load(), nodeId);
      // Rare TOCTOU: a foreign unit appeared between the dry-run and apply.
      const applied = this.conflictResult(plan.conflicts);
      if (applied) return applied;
    } catch (e) {
      this.logError("mutation: reconcile failed", e);
      return { ok: false, code: "reconcile_failed", error: errMsg(e) };
    }

    return { ok: true };
  }

  /** Dry-run reconcile and surface the first conflict, or null if none. */
  private detectConflict(
    candidate: SystemJob[],
    nodeId: string
  ): MutateResult | null {
    try {
      const plan = this.backend.reconcile(candidate, nodeId, { dryRun: true });
      return this.conflictResult(plan.conflicts);
    } catch (e) {
      this.logError("mutation: dry-run reconcile failed", e);
      return { ok: false, code: "reconcile_failed", error: errMsg(e) };
    }
  }

  private conflictResult(
    conflicts: Array<{ name: string; reason: "unmanaged" | "other-node" }>
  ): MutateResult | null {
    if (conflicts.length === 0) return null;
    const c = conflicts[0];
    return {
      ok: false,
      code: "name_conflict",
      error: `unit "${c.name}" collides with a ${c.reason} unit on disk; refusing to overwrite it`,
    };
  }

  private logError(message: string, e: unknown): void {
    this.deps.errorLogger?.error(`${message}: ${errMsg(e)}`, {
      category: "system-jobs",
    });
  }
}

/** Real host backend — the production default. */
function defaultSystemdBackend(): SystemdBackend {
  return {
    available: systemctlAvailable,
    reconcile,
    readCurrentState,
    listTimers: queryListTimers,
    journalTail: queryJournalTail,
  };
}

const JOURNAL_TAIL_LINES = "20";

/** Parse `systemctl --user list-timers --output=json` into a unit→times map. */
function queryListTimers(): Map<string, TimerTimes> {
  const map = new Map<string, TimerTimes>();
  let out: string;
  try {
    out = execFileSync(
      "systemctl",
      ["--user", "list-timers", "--all", "--output=json"],
      { encoding: "utf8" }
    );
  } catch {
    return map;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return map;
  }
  if (!Array.isArray(parsed)) return map;
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const unit = typeof r.unit === "string" ? r.unit : null;
    if (!unit) continue;
    map.set(unit, {
      next: typeof r.next === "number" ? r.next : null,
      last: typeof r.last === "number" ? r.last : null,
    });
  }
  return map;
}

/** Best-effort recent journal tail for a job's timer unit ("" on failure). */
function queryJournalTail(name: string): string {
  try {
    return execFileSync(
      "journalctl",
      ["--user", "-u", `${name}.timer`, "-n", JOURNAL_TAIL_LINES, "--no-pager"],
      { encoding: "utf8" }
    ).trim();
  } catch {
    return "";
  }
}

function jobNotFound(name: string, nodeId: string): MutateResult {
  return {
    ok: false,
    code: "job_not_found",
    error: `no system-job named "${name}" on node "${nodeId}"`,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Map a `LoopCronError.code` to an HTTP status (issue #2453). */
export function loopCronStatus(code: string): LoopCronStatus {
  switch (code) {
    case "invalid-id":
    case "invalid-interval":
    case "invalid-action":
      return 400;
    case "unknown-id":
      return 404;
    case "timeout":
      return 504;
    default:
      return 500; // exec-failed / bad-output / unconfigured
  }
}

/**
 * Dispatch ONE loop-cron mutation against a local `SystemJobsService` (issue
 * #2453). Shared by the web-client route (Task 5) and the federation receiver
 * (Task 6) so both paths map verbs, verdicts, and errors identically. Catches
 * `LoopCronError` and surfaces its code + status; never throws.
 */
export async function dispatchLoopCronMutate(
  service: SystemJobsService,
  body: LoopCronMutateBody
): Promise<LoopCronDispatchResult> {
  try {
    switch (body.action) {
      case "pause":
        return {
          ok: true,
          action: "pause",
          result: await service.loopCronPause(body.id),
        };
      case "resume":
        return {
          ok: true,
          action: "resume",
          result: await service.loopCronResume(body.id),
        };
      case "delete":
        return {
          ok: true,
          action: "delete",
          result: await service.loopCronDelete(body.id),
        };
      case "run":
        return {
          ok: true,
          action: "run",
          result: await service.loopCronRunNow(body.id),
        };
      case "reschedule":
        if (!body.interval) {
          return {
            ok: false,
            error: "reschedule requires an interval",
            code: "invalid-interval",
            status: 400,
          };
        }
        return {
          ok: true,
          action: "reschedule",
          result: await service.loopCronReschedule(body.id, body.interval),
        };
      case "edit-action":
        if (!body.actionText || body.actionText.trim().length === 0) {
          return {
            ok: false,
            error: "edit-action requires non-empty actionText",
            code: "invalid-action",
            status: 400,
          };
        }
        return {
          ok: true,
          action: "edit-action",
          result: await service.loopCronUpdateAction(body.id, body.actionText),
        };
    }
  } catch (e) {
    if (e instanceof LoopCronError) {
      return {
        ok: false,
        error: e.message,
        code: e.code,
        status: loopCronStatus(e.code),
      };
    }
    return {
      ok: false,
      error: errMsg(e),
      code: "exec-failed",
      status: 500,
    };
  }
}
