// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Job model + per-script flag allowlists (issue #2468, R1).
 *
 * The security seam. Every job is built here as a validated `argv` ARRAY handed
 * to `systemd-run … -- <script> <argv…>`; there is no path by which a flag value
 * becomes shell syntax (the R1 anti-injection guarantee). A flag not on the
 * target script's allowlist, or a value that fails its type/pattern check, is
 * rejected with a typed {@link JobValidationError} BEFORE any spawn.
 *
 * Allowlists were derived from each script's own usage block (verified on
 * ms-dev) and completed/corrected at the 2026-08-01 expert review (R03/R04/D5).
 */

import {
  type BuiltJob,
  type JobKind,
  JobValidationError,
  JOB_KINDS,
} from "./types";

// ── Value patterns (all anchored so a value can never begin with '-' and thus
//    never masquerade as a flag, defense-in-depth atop argv-array execution) ──
const SUBDOMAIN = /^[a-z0-9][a-z0-9-]*$/; // matches deprovision.sh's own guard
// Local part MUST start with a non-dash char: an email is an argv token, and a
// value beginning with '-' could masquerade as a flag to the script's own
// parser (e.g. `--tier@x.co`). Anchoring here upholds the module's stated
// "a value can never begin with '-'" invariant (security review 2026-08-01).
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/;
const OCID = /^ocid1\.[a-z0-9._-]+$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const VM_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const SSH_HOST = /^[a-zA-Z0-9._@][a-zA-Z0-9._@:-]*$/; // user@host or host
const SURFACE = /^[a-z0-9][a-z0-9-]*$/;
// No spaces/metachars AND no `..` segment — a config/hosts path is never a
// traversal (security review 2026-08-01).
const FS_PATH = /^(?!.*\.\.)[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;
// deprovision.sh's --service-end grammar (`YYYY-MM-DD`, or with `THH:MM[:SS]` and an
// optional `Z` / `±HH[:]MM` offset) minus its space separator: a value is one argv
// token and never starts with '-'. The pattern is the shape only; serviceEndToMs is
// the calendar check (#5257 F9).
const SERVICE_END =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|([+-])(\d{2}):?(\d{2}))?)?$/;

/**
 * The backup retention window after the effective service end E, in days. One
 * parameter with scripts/deprovision.sh (RETENTION_WINDOW_DAYS) and
 * gateway/src/store/userMap.ts (RETENTION_WINDOW_DAYS) — change all three together
 * (contract K15).
 */
export const RETENTION_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A `--service-end` value as epoch ms, or null when it is not a real date and time.
 * Every component is range-checked and the date part round-trips through
 * `Date.UTC`, because `Date.parse("2026-02-31")` returns a timestamp (it rolls over
 * to 3 March). A value without an offset is UTC, as `date -u -d` reads it in
 * deprovision.sh — so the dates shown here equal the ones the retention record gets.
 * Everything accepted here, GNU `date` accepts too (offset hours stop at 23).
 */
export function serviceEndToMs(value: string): number | null {
  const m = value.match(SERVICE_END);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return null;
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (
    day.getUTCFullYear() !== y ||
    day.getUTCMonth() !== mo - 1 ||
    day.getUTCDate() !== d
  ) {
    return null;
  }
  let offsetMin = 0;
  if (m[8] !== undefined) {
    const [oh, om] = [Number(m[9]), Number(m[10])];
    if (oh > 23 || om > 59) return null;
    offsetMin = (m[8] === "-" ? -1 : 1) * (oh * 60 + om);
  }
  return day.getTime() + ((h * 60 + mi) * 60 + s) * 1000 - offsetMin * 60_000;
}

/** E + the retention window, as epoch ms: when the dated purge becomes allowed. */
export function deleteEligibleMs(serviceEndMs: number): number {
  return serviceEndMs + RETENTION_WINDOW_DAYS * DAY_MS;
}

/** E + the retention window as an ISO string, or null without a valid E. */
export function deleteEligibleIso(
  serviceEnd: string | undefined
): string | null {
  const ms = serviceEnd ? serviceEndToMs(serviceEnd) : null;
  return ms === null ? null : new Date(deleteEligibleMs(ms)).toISOString();
}

/** VM tier enum — the SINGLE SOURCE OF TRUTH is scripts/lib/vm-tiers.json. */
export const VM_TIERS = ["ultra", "pro", "standard", "lite"] as const;

// ── Flag / positional / script spec shapes ──────────────────────────────────
type FlagValueType = "none" | "string" | "int" | "enum";

interface FlagSpec {
  value: FlagValueType;
  /** May appear more than once (e.g. --surface, --host). string/enum only. */
  repeatable?: boolean;
  /** The value is optional: a bare flag is also accepted (e.g. --from-image). */
  optional?: boolean;
  pattern?: RegExp; // string
  min?: number; // int
  max?: number; // int
  enumValues?: readonly string[]; // enum
}

interface PositionalSpec {
  name: string;
  required: boolean;
  pattern: RegExp;
}

interface ScriptSpec {
  /** Path RELATIVE to the repo root; resolved to absolute by the runner. */
  scriptRelPath: string;
  /** Ordered positional args. */
  positionals: PositionalSpec[];
  /** Allowlisted flags keyed by name (leading `--` included). */
  flags: Record<string, FlagSpec>;
}

/**
 * The per-kind allowlist registry. A kind absent from this map is unknown; a
 * flag absent from a kind's `flags` is rejected. Deliberately-omitted flags are
 * noted inline (they are security- or scope-sensitive; expert review R03/R04).
 */
export const SCRIPT_SPECS: Record<JobKind, ScriptSpec> = {
  // scripts/provision.sh — email is the SECOND POSITIONAL (provision has no
  // --email flag; that flag is deprovision-only). Omitted: --deploy-gateway,
  // --toolkit-branch, --rotate-keys (expert review R03).
  provision: {
    scriptRelPath: "scripts/provision.sh",
    positionals: [
      { name: "subdomain", required: true, pattern: SUBDOMAIN },
      { name: "email", required: true, pattern: EMAIL },
    ],
    flags: {
      "--ip": { value: "string", pattern: IPV4 },
      "--create-vm": { value: "none" },
      "--from-image": { value: "string", optional: true, pattern: OCID },
      "--tier": { value: "enum", enumValues: VM_TIERS },
      "--ocpus": { value: "int", min: 1, max: 64 },
      "--memory-gb": { value: "int", min: 1, max: 1024 },
      "--boot-volume-gb": { value: "int", min: 50, max: 2048 },
      "--vm-name": { value: "string", pattern: VM_NAME },
      "--no-tailscale": { value: "none" },
      "--dry-run": { value: "none" },
    },
  },

  // scripts/oci-create-vm.sh — omits --ssh-pubkey (path override is a security
  // seam we do not expose through the runner; expert review R04).
  "create-vm": {
    scriptRelPath: "scripts/oci-create-vm.sh",
    positionals: [
      { name: "subdomain", required: true, pattern: SUBDOMAIN },
      { name: "email", required: true, pattern: EMAIL },
    ],
    flags: {
      "--tier": { value: "enum", enumValues: VM_TIERS },
      "--vm-name": { value: "string", pattern: VM_NAME },
      "--from-image": { value: "string", pattern: OCID },
      "--ocpus": { value: "int", min: 1, max: 64 },
      "--memory-gb": { value: "int", min: 1, max: 1024 },
      "--boot-volume-gb": { value: "int", min: 50, max: 2048 },
      "--ad": { value: "int", min: 1, max: 3 },
      "--dry-run": { value: "none" },
    },
  },

  // scripts/deprovision.sh — dry-run by default; --apply flips it (mutating).
  // --service-end dates the retention record (#5257 F9); applyGuards checks the
  // calendar and refuses an E whose window has already ended. --purge-backups is
  // deliberately omitted: the purge is irreversible and CLI-only (#3058 D3).
  deprovision: {
    scriptRelPath: "scripts/deprovision.sh",
    positionals: [{ name: "subdomain", required: true, pattern: SUBDOMAIN }],
    flags: {
      "--email": { value: "string", pattern: EMAIL },
      "--gateway-host": { value: "string", pattern: SSH_HOST },
      "--service-end": { value: "string", pattern: SERVICE_END },
      "--apply": { value: "none" },
      "--dry-run": { value: "none" },
    },
  },

  // scripts/reconcile-vm.sh (detect) — single-VM only; --all (blanket sweep)
  // and the dangerous reference-override flags are deliberately excluded.
  "reconcile-detect": {
    scriptRelPath: "scripts/reconcile-vm.sh",
    positionals: [{ name: "subdomain", required: true, pattern: SUBDOMAIN }],
    flags: {
      "--surface": { value: "string", repeatable: true, pattern: SURFACE },
      "--reference-host": { value: "string", pattern: SSH_HOST },
      "--inventory": { value: "string", pattern: FS_PATH },
      "--json": { value: "none" },
      "--dry-run": { value: "none" },
    },
  },

  // scripts/reconcile-vm.sh (repair) — MUST carry --apply + EXACTLY ONE
  // --surface (the guard below rejects any blanket repair; expert review R13).
  "reconcile-repair": {
    scriptRelPath: "scripts/reconcile-vm.sh",
    positionals: [{ name: "subdomain", required: true, pattern: SUBDOMAIN }],
    flags: {
      "--surface": { value: "string", repeatable: true, pattern: SURFACE },
      "--reference-host": { value: "string", pattern: SSH_HOST },
      "--inventory": { value: "string", pattern: FS_PATH },
      "--apply": { value: "none" },
      "--json": { value: "none" },
    },
  },

  // infrastructure/cloud-vm/check-cloud-health.sh — always run --dry-run --json
  // (auto-injected below) to keep alert emails/debounce isolated from the
  // unattended timer (expert review R29).
  "health-check": {
    scriptRelPath: "infrastructure/cloud-vm/check-cloud-health.sh",
    positionals: [],
    flags: {
      "--config": { value: "string", pattern: FS_PATH },
      "--dry-run": { value: "none" },
      "--json": { value: "none" },
    },
  },

  // scripts/push-update-to-vms.sh — --tag required + at least one host source.
  // --repo/--asset/--remote-data-dir/--local-binary/--dry-run are forbidden
  // (expert review R04).
  "push-update": {
    scriptRelPath: "scripts/push-update-to-vms.sh",
    positionals: [],
    flags: {
      "--tag": { value: "string", pattern: RELEASE_TAG },
      "--host": { value: "string", repeatable: true, pattern: SSH_HOST },
      "--hosts-file": { value: "string", pattern: FS_PATH },
    },
  },
};

/** Unique set of script paths the module can invoke — reused by capability.ts. */
export const ALL_SCRIPT_REL_PATHS: readonly string[] = Array.from(
  new Set(JOB_KINDS.map(k => SCRIPT_SPECS[k].scriptRelPath))
);

/** Raw operator inputs to {@link buildJob}. */
export interface JobInputs {
  /** Positional arguments in order (e.g. [subdomain, email]). */
  positionals?: string[];
  /**
   * Flags keyed by name (leading `--`). Values: `true` = presence-only flag;
   * `string`/`number` = valued; array = a repeatable flag's values; `false` =
   * omit the flag.
   */
  flags?: Record<string, boolean | string | number | Array<string | number>>;
}

/**
 * Whether a job mutates real infrastructure — computed from kind + argv, NOT
 * fixed per kind. Any `--dry-run` job is read-only regardless of kind; a
 * dry-run-default `deprovision` is read-only until `--apply` is present.
 * Drives the R7 fleet lock.
 */
export function computeMutating(
  kind: JobKind,
  argv: readonly string[]
): boolean {
  if (argv.includes("--dry-run")) return false;
  switch (kind) {
    case "provision":
    case "create-vm":
    case "reconcile-repair":
    case "push-update":
      return true;
    case "deprovision":
      return argv.includes("--apply");
    case "reconcile-detect":
    case "health-check":
      return false;
  }
}

// ── Per-flag validation → argv fragment ─────────────────────────────────────
function reject(
  code: "unknown-flag" | "bad-value",
  kind: JobKind,
  message: string
): never {
  throw new JobValidationError(code, kind, message);
}

function appendValued(
  kind: JobKind,
  name: string,
  spec: FlagSpec,
  raw: string | number,
  out: string[]
): void {
  if (spec.value === "int") {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n)) {
      reject(
        "bad-value",
        kind,
        `flag '${name}' requires an integer, got '${raw}'`
      );
    }
    if (spec.min !== undefined && n < spec.min) {
      reject(
        "bad-value",
        kind,
        `flag '${name}' below minimum ${spec.min}: ${n}`
      );
    }
    if (spec.max !== undefined && n > spec.max) {
      reject(
        "bad-value",
        kind,
        `flag '${name}' above maximum ${spec.max}: ${n}`
      );
    }
    out.push(name, String(n));
    return;
  }
  const s = typeof raw === "number" ? String(raw) : raw;
  if (typeof s !== "string") {
    reject("bad-value", kind, `flag '${name}' requires a string value`);
  }
  if (spec.value === "enum") {
    if (!spec.enumValues || !spec.enumValues.includes(s)) {
      reject(
        "bad-value",
        kind,
        `flag '${name}' must be one of [${(spec.enumValues ?? []).join(", ")}], got '${s}'`
      );
    }
    out.push(name, s);
    return;
  }
  // spec.value === "string"
  if (spec.pattern && !spec.pattern.test(s)) {
    reject("bad-value", kind, `flag '${name}' value '${s}' failed validation`);
  }
  out.push(name, s);
}

function appendFlag(
  kind: JobKind,
  name: string,
  spec: FlagSpec,
  input: boolean | string | number | Array<string | number>,
  out: string[]
): void {
  // Presence-only flag.
  if (spec.value === "none") {
    if (input === true) out.push(name);
    else if (input === false)
      return; // caller opted out — omit
    else reject("bad-value", kind, `flag '${name}' takes no value`);
    return;
  }

  // Repeatable flag — accept a single value or an array.
  if (spec.repeatable) {
    const items = Array.isArray(input) ? input : [input];
    for (const item of items) {
      if (typeof item !== "string" && typeof item !== "number") {
        reject("bad-value", kind, `flag '${name}' requires string values`);
      }
      appendValued(kind, name, spec, item, out);
    }
    return;
  }

  if (Array.isArray(input)) {
    reject("bad-value", kind, `flag '${name}' is not repeatable`);
  }

  // Optional-value flag (e.g. --from-image): bare true / value / omit.
  if (spec.optional) {
    if (input === true) {
      out.push(name);
      return;
    }
    if (input === false) return;
  } else if (input === true || input === false) {
    reject("bad-value", kind, `flag '${name}' requires a value`);
  }

  appendValued(kind, name, spec, input as string | number, out);
}

/** Options for {@link buildJob}. */
export interface BuildJobOptions {
  /** The clock for time-relative guards (the deprovision service-end bound). */
  now?: number;
}

/**
 * Validate `inputs` for `kind` and produce a spawnable {@link BuiltJob}. Throws
 * {@link JobValidationError} (no spawn) on any allowlist / value / guard
 * violation.
 */
export function buildJob(
  kind: JobKind,
  inputs: JobInputs = {},
  opts: BuildJobOptions = {}
): BuiltJob {
  // hasOwnProperty guard (NOT `SCRIPT_SPECS[kind]` truthiness): a bracket lookup
  // for an inherited key like `toString`/`constructor`/`__proto__` returns a
  // truthy prototype member, which would slip past a `!spec` check and later
  // throw an uncaught TypeError. (security review 2026-08-01)
  if (!Object.prototype.hasOwnProperty.call(SCRIPT_SPECS, kind)) {
    throw new JobValidationError(
      "unknown-kind",
      kind,
      `unknown job kind '${kind}'`
    );
  }
  const spec = SCRIPT_SPECS[kind];

  // Positionals.
  const positionals = inputs.positionals ?? [];
  const requiredCount = spec.positionals.filter(p => p.required).length;
  if (positionals.length < requiredCount) {
    throw new JobValidationError(
      "bad-positional",
      kind,
      `kind '${kind}' expects at least ${requiredCount} positional(s), got ${positionals.length}`
    );
  }
  if (positionals.length > spec.positionals.length) {
    throw new JobValidationError(
      "bad-positional",
      kind,
      `kind '${kind}' accepts at most ${spec.positionals.length} positional(s), got ${positionals.length}`
    );
  }
  positionals.forEach((value, i) => {
    if (typeof value !== "string" || !spec.positionals[i].pattern.test(value)) {
      throw new JobValidationError(
        "bad-positional",
        kind,
        `positional '${spec.positionals[i].name}' value '${value}' failed validation`
      );
    }
  });

  // Flags.
  const argvFlags: string[] = [];
  for (const [name, input] of Object.entries(inputs.flags ?? {})) {
    // hasOwnProperty guard: a key like `toString`/`constructor`/`__proto__`
    // resolves to a truthy prototype member on the plain-object allowlist and
    // would otherwise BYPASS the allowlist, injecting an unvalidated token
    // (e.g. a deliberately-omitted `--rotate-keys`) into the argv — the R1 seam.
    // (security review 2026-08-01)
    if (!Object.prototype.hasOwnProperty.call(spec.flags, name)) {
      throw new JobValidationError(
        "unknown-flag",
        kind,
        `flag '${name}' is not allowed for kind '${kind}'`
      );
    }
    appendFlag(kind, name, spec.flags[name], input, argvFlags);
  }

  // Kind-specific guards.
  applyGuards(kind, argvFlags, opts.now ?? Date.now());

  // health-check is always a read-only, machine-readable probe.
  if (kind === "health-check") {
    if (!argvFlags.includes("--dry-run")) argvFlags.push("--dry-run");
    if (!argvFlags.includes("--json")) argvFlags.push("--json");
  }

  const argv = [...positionals, ...argvFlags];
  return {
    kind,
    scriptRelPath: spec.scriptRelPath,
    argv,
    mutating: computeMutating(kind, argv),
  };
}

function applyGuards(kind: JobKind, argvFlags: string[], now: number): void {
  if (kind === "deprovision") {
    const at = argvFlags.indexOf("--service-end");
    if (at !== -1) {
      const value = argvFlags[at + 1];
      const ms = serviceEndToMs(value);
      if (ms === null) {
        throw new JobValidationError(
          "bad-value",
          kind,
          `--service-end '${value}' is not a real calendar date and time`
        );
      }
      // #5257 D1: an E whose retention window has already ended makes the retained
      // backups purge-eligible the moment the teardown finishes. A typo of the year
      // does exactly that, so the dashboard refuses it; the CLI stays the path for a
      // teardown that is really that late.
      if (deleteEligibleMs(ms) <= now) {
        throw new JobValidationError(
          "guard-violation",
          kind,
          `--service-end '${value}' is more than ${RETENTION_WINDOW_DAYS} days ago, so its backups would be purge-eligible at teardown — run scripts/deprovision.sh from the CLI for that case`
        );
      }
    }
  }

  if (kind === "reconcile-repair") {
    if (!argvFlags.includes("--apply")) {
      throw new JobValidationError(
        "guard-violation",
        kind,
        "reconcile-repair requires --apply"
      );
    }
    const surfaceCount = argvFlags.filter(a => a === "--surface").length;
    if (surfaceCount !== 1) {
      throw new JobValidationError(
        "guard-violation",
        kind,
        `reconcile-repair requires exactly one --surface (no blanket repair), got ${surfaceCount}`
      );
    }
    // handoff-secret is DETECTION-ONLY (#2316): the tool never transports key
    // material, so there is no automated repair (reconcile-vm.sh's
    // _repair_handoff_secret only prints the rotate procedure and returns 1).
    // Reject it in this shared build layer so BOTH the generic POST /jobs path
    // and the dedicated reconcile-repair endpoint refuse it (#2472 R4/Task 2).
    // surfaceCount === 1 above guarantees exactly one --surface value at
    // surfaceIdx + 1.
    const surfaceIdx = argvFlags.indexOf("--surface");
    if (argvFlags[surfaceIdx + 1] === "handoff-secret") {
      throw new JobValidationError(
        "guard-violation",
        kind,
        "reconcile-repair cannot target handoff-secret — it is detection-only (#2316); rotate the secret via the documented procedure instead of --apply"
      );
    }
  }
  // reconcile-detect cannot carry --apply — it is absent from that allowlist, so
  // an --apply input is already rejected as unknown-flag above.

  if (kind === "push-update") {
    if (!argvFlags.includes("--tag")) {
      throw new JobValidationError(
        "guard-violation",
        kind,
        "push-update requires --tag"
      );
    }
    if (!argvFlags.includes("--host") && !argvFlags.includes("--hosts-file")) {
      throw new JobValidationError(
        "guard-violation",
        kind,
        "push-update requires --host or --hosts-file"
      );
    }
  }
}
