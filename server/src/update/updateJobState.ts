// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Durable two-phase-updater lifecycle state (issue #3057).
 *
 * The single mint-green update bar needs one truthful source of "where is the
 * update right now" that survives the server restarting itself mid-apply. That
 * state lives in `<HAPI_HOME>/staged-update/job.json`, written atomically by
 * BOTH the server (the initial `staging`/`applying` transition, so the UI
 * reflects the phase the instant a POST returns) and `scripts/update-hapimatic.sh`
 * (the durable `ready`/`succeeded`/`failed` transitions the shell alone can
 * prove, since only it fetches, verifies, swaps, restarts, and health-checks).
 *
 * HTTP 202 from `POST /update-stage` or `/update-trigger` means only that
 * `systemd-run` accepted a detached updater — NOT that staging or apply finished.
 * The client keys "staging spinner", "open the confirm dialog" (`ready`), and
 * "terminal reload" (`succeeded`) off THIS record, never off a resolved mutation
 * (issue #3057 R2/R3/R5, expert-review S-1).
 *
 * Reads are fail-safe (a missing/corrupt/foreign-schema file returns null — a
 * bad marker must never strand a phantom phase), mirroring `readMarker` /
 * `readDeferral`. Writes are temp-file + atomic rename so a killed writer never
 * leaves a torn record a concurrent reader could parse.
 */

export type UpdatePhase =
  | "available"
  | "staging"
  | "ready"
  | "applying"
  | "succeeded"
  | "failed";

export interface UpdateJobState {
  schemaVersion: 1;
  phase: UpdatePhase;
  /** The version being staged/applied — pins the record to one target. */
  targetVersion: string;
  /** The systemd-run transient unit name that owns this job (null before launch). */
  jobId: string | null;
  /** ISO 8601 of the last transition. */
  updatedAt: string;
  /** Machine-readable sanitized failure code (never secrets/raw updater output). */
  errorCode?: string;
  /** True when a failed apply was rolled back to the prior binary. */
  rollback?: boolean;
}

const JOB_DIR = "staged-update";
const JOB_FILE = "job.json";

/**
 * TTL after which a record still in an ACTIVE phase (`staging`/`applying`) is
 * treated as expired by `readJobState` — the staleness self-heal for issue #3737.
 * 15 min is far larger than the realistic stage/apply duration (OCI binary fetch +
 * sha256/size/signature verify + atomic swap + restart + health-check, typically
 * < 2-3 min), so a legitimately in-progress apply is never expired, while a stranded
 * `applying` (the 13-day mb1 jam) self-heals to a terminal `failed` on the next read.
 * Only `isActivePhase` records are subject to it; a `ready` staged binary persists
 * indefinitely (a user may confirm the restart hours/days later).
 */
export const STALE_ACTIVE_TTL_MS = 15 * 60 * 1000;

const VALID_PHASES: ReadonlySet<UpdatePhase> = new Set<UpdatePhase>([
  "available",
  "staging",
  "ready",
  "applying",
  "succeeded",
  "failed",
]);

function jobPath(dataDir: string): string {
  return path.join(dataDir, JOB_DIR, JOB_FILE);
}

/**
 * Read the durable job-state record. Returns null on missing / malformed /
 * unknown-schema / unknown-phase (fail-safe — a corrupt record must never strand
 * a phantom phase). A `jobId` of `null` is valid; only string-or-null passes.
 *
 * Staleness self-heal (issue #3737): a record still in an ACTIVE phase
 * (`staging`/`applying`) whose `updatedAt` is older than `ttlMs` is returned as a
 * synthesized terminal `failed` (errorCode `stale_timeout`) — transient and
 * read-only, the on-disk record is untouched. This un-jams a stranded `applying`
 * (the mb1 outage) so `/api/update-status` re-exposes the genuine available update,
 * the mutating routes stop 409'ing, and the DeferredApplyWatcher's terminal-phase
 * check self-clears a stuck deferral. A `ready`/terminal/`available` record is never
 * expired; an unparseable `updatedAt` is treated as NOT stale. `opts.now`/`opts.ttlMs`
 * are injectable for deterministic tests (defaults: `Date.now()` / `STALE_ACTIVE_TTL_MS`).
 */
export function readJobState(
  dataDir: string,
  opts?: { now?: number; ttlMs?: number }
): UpdateJobState | null {
  try {
    const raw = readFileSync(jobPath(dataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdateJobState>;
    if (parsed.schemaVersion !== 1) return null;
    if (
      typeof parsed.phase !== "string" ||
      !VALID_PHASES.has(parsed.phase as UpdatePhase)
    ) {
      return null;
    }
    if (typeof parsed.targetVersion !== "string") return null;
    if (typeof parsed.updatedAt !== "string") return null;
    if (
      parsed.jobId !== null &&
      parsed.jobId !== undefined &&
      typeof parsed.jobId !== "string"
    ) {
      return null;
    }
    const job: UpdateJobState = {
      schemaVersion: 1,
      phase: parsed.phase as UpdatePhase,
      targetVersion: parsed.targetVersion,
      jobId: parsed.jobId ?? null,
      updatedAt: parsed.updatedAt,
      ...(typeof parsed.errorCode === "string"
        ? { errorCode: parsed.errorCode }
        : {}),
      ...(parsed.rollback === true ? { rollback: true } : {}),
    };
    // #3737 defect #3: staleness self-heal for a stranded ACTIVE-phase record. A
    // real stage/apply lands a terminal phase within minutes, so an active record
    // older than the TTL means the writer died mid-flight — treat it as a terminal
    // `failed` on read (transient; disk untouched) so a stranded `applying` can never
    // jam the updater forever. `ready`/terminal/`available` records are unaffected;
    // an unparseable `updatedAt` falls through as NOT stale.
    if (isActivePhase(job.phase)) {
      const now = opts?.now ?? Date.now();
      const ttlMs = opts?.ttlMs ?? STALE_ACTIVE_TTL_MS;
      const updatedMs = Date.parse(job.updatedAt);
      if (!Number.isNaN(updatedMs) && now - updatedMs > ttlMs) {
        return {
          schemaVersion: 1,
          phase: "failed",
          targetVersion: job.targetVersion,
          jobId: job.jobId,
          updatedAt: job.updatedAt,
          errorCode: "stale_timeout",
        };
      }
    }
    return job;
  } catch {
    return null;
  }
}

/**
 * Write (overwrite) the job-state record via temp-file + atomic rename. The
 * server uses this for the initial `staging`/`applying` transition so the UI
 * reflects the phase before the shell's own writes land; the shell owns the
 * durable `ready`/`succeeded`/`failed` transitions.
 */
export function writeJobState(dataDir: string, state: UpdateJobState): void {
  const dir = path.join(dataDir, JOB_DIR);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.job.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, jobPath(dataDir));
}

/** A phase in which a stage/apply process is actively running (409-worthy). */
export function isActivePhase(phase: UpdatePhase): boolean {
  return phase === "staging" || phase === "applying";
}

/**
 * True when `job` is a `ready` staged record for exactly `targetVersion` — the
 * precondition `POST /update-trigger` requires before launching an apply.
 */
export function isReadyForTarget(
  job: UpdateJobState | null,
  targetVersion: string
): boolean {
  return (
    job !== null && job.phase === "ready" && job.targetVersion === targetVersion
  );
}
