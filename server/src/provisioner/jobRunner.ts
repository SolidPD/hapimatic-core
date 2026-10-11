// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Job runner (issue #2468, R2/R3/R4).
 *
 * Launches a validated job as a DETACHED `systemd-run --user` transient unit
 * that survives Hapimatic server restarts/deploys, maintains the job state
 * machine, parses the `provision.sh` ACTION ITEMS summary, and re-attaches to
 * still-running units on startup (falling back to the persisted record + log
 * tail — never a hard error that loses job visibility, Fallback-Preservation).
 *
 * Modelled on the `systemd-run --user` transient-unit lifecycle in
 * `scripts/hapi-worktree.sh` (launch, dead-but-loaded-unit clear, status query,
 * re-attach by unit name). All systemd interaction goes through the injectable
 * {@link SystemdExecutor} so tests never touch real systemd/OCI.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { FleetLock, LockHolder } from "./fleetLock";
import type { JobStore } from "./jobStore";
import {
  type BuiltJob,
  type JobRecord,
  type JobResultJson,
  type JobState,
  isTerminalState,
} from "./types";

// ── systemd abstraction (injectable) ────────────────────────────────────────

/** Parsed `systemctl --user show` snapshot of a transient unit. */
export interface UnitShow {
  loadState: string; // loaded | not-found | …
  activeState: string; // active | activating | inactive | failed | …
  subState: string; // running | exited | dead | failed | …
  /** Numeric main-process exit code, or null (signal death / not yet exited). */
  execMainStatus: number | null;
  result: string; // success | exit-code | signal | …
}

export interface RunTransientSpec {
  unitName: string;
  scriptPath: string; // absolute
  argv: string[]; // job argv (no script path)
  logPath: string;
  workingDir?: string;
}

export interface SystemdExecutor {
  /** Launch the transient unit; resolves once STARTED (not once finished). */
  runTransient(spec: RunTransientSpec): Promise<void>;
  /** Query unit properties; null when the unit is unknown/gone. */
  show(unitName: string): Promise<UnitShow | null>;
  /** `systemctl --user is-active` → true for active/activating. */
  isActive(unitName: string): Promise<boolean>;
  /** Clear a dead-but-loaded transient unit so the name can be re-used. */
  resetFailed(unitName: string): Promise<void>;
}

// ── Pure helpers (exported for direct unit testing) ─────────────────────────

/** systemd unit names disallow ':' etc. — collapse to a safe charset. */
export function sanitizeInstance(instance: string): string {
  return instance.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Unit name carries the INSTANCE prefix because prod:3008 and dev:3009 share
 * one `systemd --user` manager — per-job ids alone would collide.
 */
export function buildUnitName(instance: string, id: string): string {
  return `hapi-vmjob-${sanitizeInstance(instance)}-${id}`;
}

/**
 * `systemd-run` argv (no shell on our side — an array handed to the spawn API).
 * `StandardError=inherit` merges stderr into the same append log (the ACTION
 * ITEMS summary is emitted on stderr). No `--collect`: a failed unit must
 * persist for inspection. `ExecStopPost` appends a `HAPI_JOB_EXIT=<code>`
 * sentinel so a unit GC'd while the server was down is still finalizable.
 *
 * `--no-block` is LOAD-BEARING (issue #2472 fixing a latent #2468 bug): without
 * it, `systemd-run` synchronously waits for the `Type=oneshot` ExecStart and
 * propagates a NON-ZERO script exit as a start-job failure (systemd-run itself
 * exits non-zero) — so `runTransient` throws BEFORE the detached finalize +
 * exit-map can classify it. That breaks every findings-run (health-check with
 * alerts, reconcile-detect with drift — both exit 1). `--no-block` makes
 * systemd-run return 0 at enqueue; the real exit is recovered later by
 * `finalize` via `systemctl show` ExecMainStatus (or the `HAPI_JOB_EXIT`
 * sentinel) — exactly what mapExitToState + the sentinel machinery were built
 * for. Empirically validated by #2472's tester: oneshot + exit 1 → WITH
 * `--no-block`, systemd-run exits 0 and the unit records ExecMainStatus=1;
 * WITHOUT it, systemd-run exits 1.
 */
export function buildSystemdRunArgs(spec: RunTransientSpec): string[] {
  const stopPost =
    "ExecStopPost=/bin/sh -c " +
    `"echo HAPI_JOB_EXIT=$EXIT_STATUS SERVICE_RESULT=$SERVICE_RESULT >> ${spec.logPath}"`;
  return [
    "--user",
    // #2472 (latent #2468 fix): detach the spawn so a non-zero-exit oneshot is
    // finalized async (systemctl show / HAPI_JOB_EXIT), never thrown here. See
    // the buildSystemdRunArgs JSDoc for the empirical matrix.
    "--no-block",
    `--unit=${spec.unitName}`,
    `--description=Hapimatic VM provisioning job ${spec.unitName}`,
    "--property=Type=oneshot",
    `--property=StandardOutput=append:${spec.logPath}`,
    "--property=StandardError=inherit",
    `--property=${stopPost}`,
    ...(spec.workingDir
      ? [`--property=WorkingDirectory=${spec.workingDir}`]
      : []),
    "--",
    spec.scriptPath,
    ...spec.argv,
  ];
}

/**
 * Per-kind exit-code → state map (R3, R12):
 *   0                                        ⇒ succeeded
 *   3 on a create path (create-vm / provision --create-vm) ⇒ capacity-waiting
 *   1 for health-check / reconcile-detect    ⇒ succeeded (findings, not failure)
 *   4 from provision (#4183, #3555)          ⇒ failed: the run finished, but the VM
 *                                              is NOT operator-compliant (config-layer,
 *                                              rotation-lease, capability-layer); the
 *                                              ACTION ITEMS carry the reasons. Only an
 *                                              --operator run exits 4, and this server
 *                                              never passes --operator
 *   5 from provision (#4214)                 ⇒ failed: the run finished, but a formerly
 *                                              fatal step failed, possibly the gateway
 *                                              registration itself; the ACTION ITEMS
 *                                              say what is missing (no JobState for
 *                                              "finished with actions" exists)
 *   otherwise                                ⇒ failed
 */
export function mapExitToState(
  rec: Pick<JobRecord, "kind" | "argv">,
  exitCode: number
): JobState {
  if (exitCode === 0) return "succeeded";
  const isCreatePath =
    rec.kind === "create-vm" ||
    (rec.kind === "provision" && rec.argv.includes("--create-vm"));
  if (exitCode === 3 && isCreatePath) return "capacity-waiting";
  // #4214: the run finished, but a formerly fatal step failed (the registration
  // may be one of them); the ACTION ITEMS say what is missing.
  if (exitCode === 5) return "failed";
  if (
    (rec.kind === "health-check" || rec.kind === "reconcile-detect") &&
    exitCode === 1
  ) {
    return "succeeded"; // exit 1 = findings present, not a runner failure
  }
  return "failed";
}

/**
 * Parse `provision.sh`'s ACTION ITEMS summary from the (stderr-merged) log tail.
 * Anchors on the real emission: a `WARNING: ──… ACTION ITEMS (N) …` header
 * followed by `WARNING:   • <item>` bullet lines. Absence ⇒ zero items.
 */
export function parseActionItems(logText: string): string[] {
  const lines = logText.split(/\r?\n/);
  const idx = lines.findIndex(
    l => l.startsWith("WARNING:") && /ACTION ITEMS \(\d+\)/.test(l)
  );
  if (idx === -1) return [];
  const items: string[] = [];
  const bulletRe = /^WARNING:\s+•\s+(.*\S)\s*$/;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(bulletRe);
    if (!m) break; // first non-bullet line ends the block
    items.push(m[1]);
  }
  return items;
}

/**
 * Last `HAPI_JOB_EXIT=<n>` sentinel written by the unit's ExecStopPost — the
 * restart-safe exit code when the unit itself was GC'd while the server was
 * down. Signal deaths write a non-numeric `$EXIT_STATUS` (e.g. `SIGTERM`) which
 * do not match, yielding null ⇒ finalized as failed (a killed job is a failure).
 */
export function parseExitSentinel(logText: string): number | null {
  const matches = [...logText.matchAll(/HAPI_JOB_EXIT=(\d+)\b/g)];
  if (matches.length === 0) return null;
  return Number(matches[matches.length - 1][1]);
}

/**
 * Best-effort extraction of a `--json` document from the (stderr-merged) log.
 * The scripts prefix every prose line (`:: `, `WARNING:`, `ALERT [`, `ok:`, …);
 * strip those and parse what remains. Returns null when nothing parses (result
 * is nullable by contract; #2469 surfaces it, #2471 masks it).
 */
export function parseResultJson(logText: string): JobResultJson | null {
  const prosePrefixes = [
    "::",
    "WARNING:",
    "ERROR:",
    "ALERT ",
    "ok:",
    "OK:",
    "✓",
    "HAPI_JOB_EXIT=",
    "SERVICE_RESULT=",
    "[push-update]",
  ];
  const kept = logText
    .split(/\r?\n/)
    .filter(l => {
      const t = l.trimStart();
      if (t === "") return false;
      return !prosePrefixes.some(p => t.startsWith(p));
    })
    .join("\n")
    .trim();
  if (!kept) return null;
  try {
    return JSON.parse(kept) as JobResultJson;
  } catch {
    // Fallback: from the first bracket to the end.
    const brace = kept.indexOf("{");
    const bracket = kept.indexOf("[");
    const start =
      brace === -1
        ? bracket
        : bracket === -1
          ? brace
          : Math.min(brace, bracket);
    if (start === -1) return null;
    try {
      return JSON.parse(kept.slice(start)) as JobResultJson;
    } catch {
      return null;
    }
  }
}

const RESULT_KINDS = new Set<JobRecord["kind"]>([
  "health-check",
  "reconcile-detect",
  "reconcile-repair",
]);

// ── Runner ──────────────────────────────────────────────────────────────────

export interface JobRunnerDeps {
  store: JobStore;
  fleetLock: FleetLock;
  executor: SystemdExecutor;
  /** Instance label for unit-name namespacing + lock holder (e.g. "dev:3009"). */
  instance: string;
  /** Absolute repo root: scriptPath = join(repoRoot, built.scriptRelPath). */
  repoRoot: string;
  /** Directory for per-job logs. */
  logDir: string;
  now?: () => number;
  genId?: () => string;
  readLog?: (logPath: string) => Promise<string>;
  ensureLog?: (logPath: string) => Promise<void>;
  /**
   * Fired ONCE when a job reaches a terminal state (issue #2471 R3). A generic
   * domain-event callback — the runner does not know it means "audit"; the
   * composition root (`web/server.ts`) wires it to append a terminal audit entry
   * with the `system` actor. Fires from both the normal `finalize` path and the
   * spawn-failure path, so every terminal transition is observed.
   */
  onTerminal?: (record: JobRecord) => void;
  /**
   * Structured error sink (issue #2561). Called when an audit/domain-event observer
   * (onTerminal / onPersist) throws — the failure is LOGGED but still swallowed (an
   * audit-append failure must never fail the job). Optional: unset => prior silent behavior.
   */
  logError?: (message: string, meta: Record<string, unknown>) => void;
}

/** Outcome of {@link JobRunner.runJob}. */
export type RunOutcome =
  | { started: true; record: JobRecord }
  | { started: false; reason: string; record: JobRecord };

/** Per-call hooks for {@link JobRunner.runJob} (issue #2471 R3). */
export interface RunJobHooks {
  /**
   * Fired ONCE, synchronously, AFTER the job record is persisted but BEFORE the
   * fleet lock and unit spawn. The route wires this to append its `create` /
   * `apply-confirm` audit entry with the operator actor, so the record is durable
   * even if the spawn throws (a `systemd-run` oneshot whose ExecStart exits
   * non-zero surfaces as a thrown error here). Observer errors are non-fatal.
   */
  onPersist?: (record: JobRecord) => void;
}

async function defaultReadLog(logPath: string): Promise<string> {
  try {
    return await readFile(logPath, "utf8");
  } catch {
    return "";
  }
}

async function defaultEnsureLog(logPath: string): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
  const fh = await open(logPath, "a", 0o600);
  await fh.close();
}

export class JobRunner {
  private readonly store: JobStore;
  private readonly fleetLock: FleetLock;
  private readonly executor: SystemdExecutor;
  private readonly instance: string;
  private readonly repoRoot: string;
  private readonly logDir: string;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly readLog: (logPath: string) => Promise<string>;
  private readonly ensureLog: (logPath: string) => Promise<void>;
  private readonly onTerminal?: (record: JobRecord) => void;
  private readonly logError?: (
    message: string,
    meta: Record<string, unknown>
  ) => void;

  constructor(deps: JobRunnerDeps) {
    this.store = deps.store;
    this.fleetLock = deps.fleetLock;
    this.executor = deps.executor;
    this.instance = deps.instance;
    this.repoRoot = deps.repoRoot;
    this.logDir = deps.logDir;
    this.now = deps.now ?? (() => Date.now());
    this.genId = deps.genId ?? (() => randomUUID());
    this.readLog = deps.readLog ?? defaultReadLog;
    this.ensureLog = deps.ensureLog ?? defaultEnsureLog;
    this.onTerminal = deps.onTerminal;
    this.logError = deps.logError;
  }

  /**
   * Notify the terminal-state observer (issue #2471 R3). Swallows a callback
   * error: an audit-append failure must never turn a genuinely-terminal job back
   * into an exception that the caller mis-handles as "still running".
   */
  private notifyTerminal(record: JobRecord): void {
    if (!this.onTerminal) return;
    try {
      this.onTerminal(record);
    } catch (err) {
      this.logError?.(
        "VM provisioner: terminal audit observer threw (audit entry may be lost)",
        {
          jobId: record.id,
          kind: record.kind,
          phase: "onTerminal",
          error: String(err),
        }
      );
      /* observer errors remain non-fatal to the job's terminal transition */
    }
  }

  /** The `hapi-vmjob-<instance>-` prefix that scopes units to THIS instance. */
  private unitPrefix(): string {
    return `hapi-vmjob-${sanitizeInstance(this.instance)}-`;
  }

  private holderFor(rec: JobRecord): LockHolder {
    return {
      instance: this.instance,
      jobId: rec.id,
      unitName: rec.unitName,
      acquiredAt: rec.startedAt ?? rec.createdAt,
    };
  }

  /**
   * Persist a job (state `queued`), acquire the fleet lock for a MUTATING job
   * (queue/reject with a reason if held), then launch the detached unit.
   */
  async runJob(built: BuiltJob, hooks?: RunJobHooks): Promise<RunOutcome> {
    const id = this.genId();
    const unitName = buildUnitName(this.instance, id);
    const logPath = join(this.logDir, `${id}.log`);
    const createdAt = this.now();
    const scriptPath = join(this.repoRoot, built.scriptRelPath);

    const record: JobRecord = {
      id,
      kind: built.kind,
      scriptPath,
      argv: built.argv,
      state: "queued",
      mutating: built.mutating,
      logPath,
      unitName,
      exitCode: null,
      actionItems: null,
      result: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    };
    this.store.create(record);

    // #2471 R3: record the creation BEFORE the spawn — a spawn failure (a
    // `systemd-run` oneshot ExecStart exiting non-zero throws below) must not lose
    // the operator's creation record. Non-fatal: an audit error never blocks a job.
    if (hooks?.onPersist) {
      try {
        hooks.onPersist(this.store.get(id) as JobRecord);
      } catch (err) {
        this.logError?.(
          "VM provisioner: create/apply-confirm audit observer threw (audit entry may be lost)",
          {
            jobId: id,
            kind: record.kind,
            phase: "onPersist",
            error: String(err),
          }
        );
        /* audit observer errors remain non-fatal to job creation */
      }
    }

    // Mutating jobs serialize on the cross-instance fleet lock.
    if (built.mutating) {
      const acq = await this.fleetLock.tryAcquire({
        instance: this.instance,
        jobId: id,
        unitName,
        acquiredAt: createdAt,
      });
      if (!acq.acquired) {
        // Leave the job `queued` (waiting) and surface the reason.
        return {
          started: false,
          reason: acq.reason ?? "fleet lock unavailable",
          record: this.store.get(id) as JobRecord,
        };
      }
    }

    try {
      await this.ensureLog(logPath);
      await this.executor.resetFailed(unitName); // clear stale dead-but-loaded unit
      await this.executor.runTransient({
        unitName,
        scriptPath,
        argv: built.argv,
        logPath,
        workingDir: this.repoRoot,
      });
      this.store.updateState(id, "running", { startedAt: this.now() });
      return { started: true, record: this.store.get(id) as JobRecord };
    } catch (err) {
      // Spawn failed (infra error). Release the lock, mark failed, fail loud.
      if (built.mutating) await this.fleetLock.release(id);
      this.store.updateState(id, "failed", { finishedAt: this.now() });
      this.notifyTerminal(this.store.get(id) as JobRecord); // R3: audit the failed terminal
      throw err;
    }
  }

  /**
   * Finalize a `running` job if its unit has exited. Idempotent: a terminal or
   * still-running job is returned unchanged; a `queued` job (never spawned) is
   * untouched. Reads the exit code from `systemctl show`, falling back to the
   * log's `HAPI_JOB_EXIT=` sentinel when the unit is gone (Fallback-Preservation).
   */
  async finalize(id: string): Promise<JobRecord> {
    const rec = this.store.get(id);
    if (!rec) throw new Error(`finalize: unknown job ${id}`);
    if (rec.state === "queued" || isTerminalState(rec.state)) return rec;

    const show = await this.executor.show(rec.unitName);
    if (
      show &&
      (show.activeState === "active" ||
        show.activeState === "activating" ||
        show.activeState === "reloading")
    ) {
      return rec; // still running — not finalizable yet
    }

    const logText = await this.readLog(rec.logPath);
    const exitCode =
      show && show.execMainStatus !== null
        ? show.execMainStatus
        : parseExitSentinel(logText);

    return this.applyTerminal(rec, exitCode, logText);
  }

  private async applyTerminal(
    rec: JobRecord,
    exitCode: number | null,
    logText: string
  ): Promise<JobRecord> {
    const state: JobState =
      exitCode === null ? "failed" : mapExitToState(rec, exitCode);

    if (exitCode !== null) this.store.setExit(rec.id, exitCode);

    if (rec.kind === "provision") {
      const items = parseActionItems(logText);
      if (items.length > 0) this.store.setActionItems(rec.id, items);
    }
    if (RESULT_KINDS.has(rec.kind)) {
      const result = parseResultJson(logText);
      if (result !== null) this.store.setResult(rec.id, result);
    }

    this.store.updateState(rec.id, state, { finishedAt: this.now() });

    // Release the fleet lock AFTER the record is terminal (so a concurrent
    // staleness probe sees a terminal record). AWAITED: a caller that admits
    // the next queued job right after finalize() relies on the lock being free.
    if (rec.mutating) await this.fleetLock.release(rec.id);
    // Clear the dead-but-loaded unit — best-effort; a stale unit must never
    // fail a job that has already reached a terminal state.
    try {
      await this.executor.resetFailed(rec.unitName);
    } catch {
      /* unit cleanup is non-fatal */
    }

    const terminal = this.store.get(rec.id) as JobRecord;
    this.notifyTerminal(terminal); // R3: audit the terminal state (fires once)
    return terminal;
  }

  /**
   * On server startup, re-bind persisted `running` jobs owned by THIS instance:
   * a still-active unit keeps running (a mutating job re-adopts its fleet lock);
   * an exited/gone unit is finalized from the log tail + record.
   */
  async reattach(): Promise<JobRecord[]> {
    const prefix = this.unitPrefix();
    const results: JobRecord[] = [];
    for (const rec of this.store.listByState("running")) {
      if (!rec.unitName.startsWith(prefix)) continue; // another instance owns it
      const active = await this.executor.isActive(rec.unitName);
      if (active) {
        if (rec.mutating) await this.fleetLock.adopt(this.holderFor(rec));
        results.push(rec);
      } else {
        results.push(await this.finalize(rec.id));
      }
    }
    return results;
  }
}

// ── Real systemd executor (used on RP1; tests inject a stub) ────────────────

/**
 * Drives `systemd-run` / `systemctl --user` via the spawn API (an argv array —
 * no shell, so job argv can never become shell syntax).
 */
export class RealSystemdExecutor implements SystemdExecutor {
  async runTransient(spec: RunTransientSpec): Promise<void> {
    const proc = Bun.spawn(["systemd-run", ...buildSystemdRunArgs(spec)], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      throw new Error(
        `systemd-run failed (exit ${code}) for unit ${spec.unitName}: ${stderr}`
      );
    }
  }

  async show(unitName: string): Promise<UnitShow | null> {
    const proc = Bun.spawn(
      [
        "systemctl",
        "--user",
        "show",
        unitName,
        "--property=LoadState,ActiveState,SubState,ExecMainStatus,Result",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const map: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) map[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!map.LoadState || map.LoadState === "not-found") return null;

    const rawStatus = map.ExecMainStatus;
    const execMainStatus =
      rawStatus !== undefined && /^\d+$/.test(rawStatus)
        ? Number(rawStatus)
        : null;

    return {
      loadState: map.LoadState ?? "",
      activeState: map.ActiveState ?? "",
      subState: map.SubState ?? "",
      execMainStatus,
      result: map.Result ?? "",
    };
  }

  async isActive(unitName: string): Promise<boolean> {
    const proc = Bun.spawn(["systemctl", "--user", "is-active", unitName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return out === "active" || out === "activating";
  }

  async resetFailed(unitName: string): Promise<void> {
    const proc = Bun.spawn(["systemctl", "--user", "reset-failed", unitName], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited; // a missing unit is fine — ignore the status
  }
}
