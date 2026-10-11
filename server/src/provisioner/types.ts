// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Provisioner job type contracts (issue #2468, epic #2467 Sub A).
 *
 * The RP1 bash scripts are the single source of provisioning truth. This module
 * WRAPS and INVOKES them as detached `systemd-run --user` jobs; it never
 * reimplements OCI / DNS / Tailscale logic. These types describe one job = one
 * validated script invocation, its detached-execution lifecycle, and its
 * persisted (secret-free) record.
 *
 * Discriminated-union / literal-union style mirrors
 * `server/src/extensions/scheduler/scheduler/types.ts`.
 */

/**
 * The set of provisioning scripts the runner can invoke, one literal per script
 * entry point. `reconcile-vm.sh` is split into two kinds — `reconcile-detect`
 * (read-only) and `reconcile-repair` (mutating, `--apply`) — so the mutating vs
 * read-only classification is expressible at the type level (cross-ref #2472,
 * which consumes these kinds rather than re-adding its own; expert review
 * 2026-08-01, D5/R04).
 */
export type JobKind =
  | "provision" // scripts/provision.sh (incl. the --create-vm create path)
  | "create-vm" // scripts/oci-create-vm.sh
  | "deprovision" // scripts/deprovision.sh
  | "reconcile-detect" // scripts/reconcile-vm.sh (detect only, no --apply)
  | "reconcile-repair" // scripts/reconcile-vm.sh --apply
  | "health-check" // infrastructure/cloud-vm/check-cloud-health.sh
  | "push-update"; // scripts/push-update-to-vms.sh

/** All job kinds, for exhaustive iteration in specs/tests. */
export const JOB_KINDS: readonly JobKind[] = [
  "provision",
  "create-vm",
  "deprovision",
  "reconcile-detect",
  "reconcile-repair",
  "health-check",
  "push-update",
] as const;

/**
 * Job state machine: `queued → running → succeeded | failed | capacity-waiting`.
 *
 * `capacity-waiting` is a first-class terminal-for-now state, NOT a failure: it
 * is the mapping of `oci-create-vm.sh` exit 3 (capacity ladder exhausted, a
 * retry-cron was written). Such a job closes by operator action, surfaced in the
 * #2472 health view.
 */
export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "capacity-waiting";

/** The three terminal states — no further transition occurs from these. */
export const TERMINAL_STATES: readonly JobState[] = [
  "succeeded",
  "failed",
  "capacity-waiting",
] as const;

export function isTerminalState(state: JobState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * A single operator action item parsed from `provision.sh`'s final ACTION ITEMS
 * summary. Each is the raw bullet text (the `warn "  • <text>"` line body).
 */
export type ActionItem = string;

/**
 * Parsed `--json` output of a `health-check` / `reconcile-detect` job. The shape
 * is the script's own JSON document — deliberately `unknown` here (Sub A only
 * persists it verbatim; #2469's `GET /admin-vms/jobs/:id` surfaces it). `null`
 * for every other kind and when the document could not be parsed.
 */
export type JobResultJson = unknown;

/**
 * A persisted job record. Contains NO secret values and NO secret env-var names
 * (R5) — only flags, states, timestamps, the log-file path, the unit name, the
 * exit code, the parsed non-secret ACTION ITEMS, and the parsed non-secret
 * `result` JSON.
 */
export interface JobRecord {
  /** Opaque unique id (also embedded in the systemd unit name). */
  id: string;
  kind: JobKind;
  /** Absolute path to the invoked script (resolved under the repo root). */
  scriptPath: string;
  /** Validated argument vector (positionals + flags). Never a shell string. */
  argv: string[];
  state: JobState;
  /**
   * Whether this job mutates real infrastructure. Computed from kind + argv in
   * {@link buildJob} (NOT fixed per kind) — drives the R7 fleet lock. A
   * read-only job (health-check, detect, any `--dry-run`, dry-run-default
   * deprovision) bypasses the lock.
   */
  mutating: boolean;
  /** Per-job log file (0600) that systemd appends raw script output to. */
  logPath: string;
  /** The transient unit name (`hapi-vmjob-<instance>-<id>`). */
  unitName: string;
  /** Process exit code once terminal; null while queued/running. */
  exitCode: number | null;
  /** ACTION ITEMS parsed from the log tail (provision kind); null otherwise. */
  actionItems: ActionItem[] | null;
  /** Parsed `--json` document for health/reconcile kinds; null otherwise. */
  result: JobResultJson | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

/**
 * A validated, spawnable job descriptor produced by {@link buildJob}. It carries
 * the fixed `argv` and the computed `mutating` flag; the runner assigns id, unit
 * name, log path, timestamps, and the initial `queued` state.
 */
export interface BuiltJob {
  kind: JobKind;
  /** Script path RELATIVE to the repo root (e.g. `scripts/provision.sh`). */
  scriptRelPath: string;
  /** Positionals followed by flags. No script path, no shell metacharacters. */
  argv: string[];
  mutating: boolean;
}

/** Why a {@link JobValidationError} was raised — lets callers branch/surface. */
export type JobValidationCode =
  | "unknown-kind"
  | "bad-positional"
  | "unknown-flag"
  | "bad-value"
  | "guard-violation";

/**
 * Thrown by {@link buildJob} when submitted inputs violate the target script's
 * allowlist or a kind-specific guard. Distinct from generic errors so the model
 * layer's rejection is observable — and it is raised BEFORE any process spawn
 * (the R1 anti-injection guarantee).
 */
export class JobValidationError extends Error {
  readonly code: JobValidationCode;
  readonly kind: JobKind | string;
  constructor(
    code: JobValidationCode,
    kind: JobKind | string,
    message: string
  ) {
    super(message);
    this.name = "JobValidationError";
    this.code = code;
    this.kind = kind;
  }
}

// buildJob is declared in jobModel.ts (imports this module). Re-exported from
// the barrel (index.ts). This forward reference in the JSDoc above is
// intentional — types.ts holds no runtime logic.
export type { BuiltJob as ValidatedJob };
