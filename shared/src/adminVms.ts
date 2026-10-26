// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Admin VM provisioning API contracts (`@hapi/protocol/adminVms`, issue #2469,
 * epic #2467 Sub B).
 *
 * Request/response Zod schemas for the operator-only admin-VM routes
 * (`server/src/web/routes/adminVms.ts`): sanitized fleet inventory, job
 * create/list/status, SSE log follow, preflight, and the two-step deprovision.
 * Consumed by the server routes and by #2470's admin page.
 *
 * ## 🔴 The inventory response is an ALLOWLIST, structurally secret-free
 *
 * `VmInventoryEntrySchema` is `.strict()` and lists ONLY the fields the UI
 * renders. The fleet inventory file (`cloud-instances.json`) records a per-VM
 * `access_token`; the server maps each record field-by-field into this shape and
 * validates the OUTPUT here, so a token can never serialize out even if a future
 * inventory field is added (the same defense as the server's `RedactedAccount`).
 *
 * ## Layout
 *
 * A single flat file per `shared/CLAUDE.md` ("one file per cohesive concern; add
 * a subdirectory only when 3+ files"). The directive's folder+barrel shape
 * modeled `porter/` (5+ files); at one cohesive concern the flat file is the
 * convention-compliant form and the `@hapi/protocol/adminVms` export resolves
 * identically.
 */

import { z } from "zod";

// ── Job kind / state (mirror server/src/provisioner/types.ts) ────────────────
// Duplicated as a literal union here — @hapi/protocol must NOT depend on the
// server package. `buildJob` (server) re-validates the kind against its own
// registry, so a drift between these lists fails closed (an out-of-range kind is
// rejected server-side), never open.
export const JOB_KINDS = [
  "provision",
  "create-vm",
  "deprovision",
  "reconcile-detect",
  "reconcile-repair",
  "health-check",
  "push-update",
] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "capacity-waiting",
] as const;
export const JobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobStateSchema>;

// ── VM parity: Sub F's record value sets (#3556) ─────────────────────────────
// Declared ahead of BOTH consumers — the #3557 column schema below and the
// #3593 history schema further down — because each is evaluated at load time.
/**
 * The verdict and source value sets of Sub F's parity record, transcribed from
 * the normative contract (`docs/internal/architecture/vm-parity.md` § Status
 * file, #3556). Named `VM_PARITY_*` because bare `parity` already names the
 * CLI↔server shadow-mode harness (`server/src/parity/*`).
 */
export const VM_PARITY_VERDICTS = [
  "pass",
  "drift",
  "error",
  "skipped",
] as const;
export const VM_PARITY_SOURCES = [
  "vm-parity.timer",
  "provision.sh",
  "reconcile-vm.sh",
] as const;

// ── VM parity column (#3557, epic #3550 Sub G1) ──────────────────────────────
export const VmParityVerdictSchema = z.enum(VM_PARITY_VERDICTS);
export type VmParityVerdict = z.infer<typeof VmParityVerdictSchema>;

/**
 * A status record older than this is STALE — Sub F's freshness bound, the same
 * 48 hours `check-cloud-health.sh` raises `vm-parity-stale` at.
 */
export const VM_PARITY_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * The per-VM parity summary the inventory row carries. A PROJECTION of Sub F's
 * twelve-field status file, not the file itself: only the fields the column
 * renders cross the wire (never `target`, `checked_by`, `source`, `excluded` or
 * `checker_exit`). Both branches are `.strict()` for the same reason the entry
 * is — a raw status object merged in fails OUTPUT validation instead of riding
 * along.
 *
 * - `recorded` — a valid schema-v1 record exists for the VM. `stale` is computed
 *   server-side against {@link VM_PARITY_STALE_AFTER_MS}.
 * - `unreadable` — a status file exists but is not a valid record (bad JSON, a
 *   schema-v1 violation, a subdomain mismatch). Surfaced, never passed off as
 *   "never checked".
 *
 * A VM with NO status file carries no `vmParity` at all (never checked).
 *
 * camelCase on purpose, unlike #3593's snake_case {@link VmParityHistoryEntrySchema}:
 * that route serves F's ledger lines verbatim, while this is a derived summary
 * (`state` and `stale` are not F fields) nested in the camelCase inventory
 * entry, whose route already renames on-disk keys (`disk_threshold_pct` →
 * `diskThresholdPct`).
 */
export const VmParitySummarySchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("recorded"),
      verdict: VmParityVerdictSchema,
      compliant: z.boolean(),
      drift: z.number().int().nonnegative(),
      manifestVersion: z.string(),
      checkedAt: z.string(),
      stale: z.boolean(),
    })
    .strict(),
  z.object({ state: z.literal("unreadable") }).strict(),
]);
export type VmParitySummary = z.infer<typeof VmParitySummarySchema>;

// ── Inventory (R1) ───────────────────────────────────────────────────────────
/**
 * One sanitized fleet-inventory entry. `.strict()` is load-bearing: it forbids
 * any field beyond this allowlist, so a serialization bug that spread the raw
 * record (carrying `access_token`) fails OUTPUT validation instead of leaking.
 * No `access_token`, no email/namespace/user field. `diskThresholdPct` is
 * `.optional()` — some live records may omit it (never `.default()`, which would
 * make the inferred field required). `vmParity` (#3557) is optional for the same
 * reason and is present only when the VM has a parity status file.
 */
export const VmInventoryEntrySchema = z
  .object({
    name: z.string(),
    url: z.string(),
    diskThresholdPct: z.number().optional(),
    vmParity: VmParitySummarySchema.optional(),
  })
  .strict();
export type VmInventoryEntry = z.infer<typeof VmInventoryEntrySchema>;

/**
 * A LOUD divergence verdict on the sanitized inventory read-path (#2552). The
 * endpoint returns this (HTTP 200) INSTEAD of a silent empty array when the fleet
 * inventory file is MISSING, STALE, or SCHEMA-DRIFTED — so the panel renders an
 * explicit reason rather than a blank "0 VMs" fleet that hides a read/write path
 * divergence (the #2473 OOS-2 finding). `status` discriminates the three cases;
 * `message` is operator-facing prose. `.strict()` mirrors the entry-schema
 * allowlist posture so no extra field can ride along.
 */
export const VM_INVENTORY_VERDICT_STATUSES = [
  "missing",
  "stale",
  "schema-drift",
] as const;
export type VmInventoryVerdictStatus =
  (typeof VM_INVENTORY_VERDICT_STATUSES)[number];
export const VmInventoryVerdictSchema = z
  .object({
    status: z.enum(VM_INVENTORY_VERDICT_STATUSES),
    message: z.string(),
  })
  .strict();
export type VmInventoryVerdict = z.infer<typeof VmInventoryVerdictSchema>;

/**
 * The inventory endpoint response: EITHER the healthy sanitized fleet (an array
 * of `.strict()` entries) OR a loud `VmInventoryVerdict` (#2552). A plain
 * `z.union` (not `discriminatedUnion`) because the healthy branch is an array
 * with no discriminator key; the two branches never overlap (array vs object).
 * The `.strict()` OUTPUT invariant is preserved: a leaked-secret record fails the
 * array branch AND cannot match the verdict object, so the endpoint 500s rather
 * than serving it — a secret can never reach the client on any path.
 */
export const VmInventoryResponseSchema = z.union([
  z.array(VmInventoryEntrySchema),
  VmInventoryVerdictSchema,
]);
export type VmInventoryResponse = z.infer<typeof VmInventoryResponseSchema>;

// ── RP1 hub parity (#3996) ───────────────────────────────────────────────────
/**
 * The reserved name of RP1's own parity record: RP1, the declared profile's
 * verify-only source node, checks itself nightly and Sub F's writer records it
 * as `<state dir>/rp1.json`. The same default as
 * `scripts/lib/vm-parity-status-v1.sh` `VM_PARITY_HUB_ID` and the SessionStart
 * banner's `DEFAULT_HUB_ID`.
 */
export const VM_PARITY_HUB_ID = "rp1";

/**
 * `GET /admin-vms/parity-hub`: RP1's parity summary. Deliberately OUTSIDE
 * {@link VmInventoryEntrySchema} and the inventory array: RP1 is not a fleet VM
 * (no `cloud-instances.json` record, no `url`), and an inventory row without a
 * `url` would fail that `.strict()` schema. `vmParity` is absent when RP1 has
 * no hub record yet (the hub step is not installed, or has never run).
 */
export const VmParityHubSchema = z
  .object({
    name: z.string(),
    vmParity: VmParitySummarySchema.optional(),
  })
  .strict();
export type VmParityHub = z.infer<typeof VmParityHubSchema>;

/** Runtime type guard: is this response a loud verdict rather than a fleet array? */
export function isVmInventoryVerdict(
  response: VmInventoryResponse
): response is VmInventoryVerdict {
  return !Array.isArray(response);
}

// ── VM parity history (#3593, Sub G2) ────────────────────────────────────────
/**
 * One served line of F's append-only ledger (`ledger.ndjson`) — eight of the
 * twelve fields F records; `schema_version`, `target`, `excluded` and
 * `checked_by` are deliberately not served. Keys keep F's on-disk snake_case.
 * Types follow F's contract: `drift` is an integer ≥ 0 (0 for error/skipped),
 * `checker_exit` an integer where -1 means the checker was not run (skipped),
 * `manifest_version` the committed manifest's version: for a check that ran,
 * the checker's `manifest=` token, or `"unknown"` when it gave no usable
 * trailer; for a `skipped` record, the committed manifest's own version,
 * `"unknown"` only if that manifest is unreadable
 * (`scripts/lib/vm-parity-status-v1.sh`). `.strict()` is the OUTPUT allowlist exactly as on
 * `VmInventoryEntrySchema`: the server builds each entry BY NAME, so a spread
 * ledger line (or any stray field) fails validation and 500s instead of
 * reaching the client.
 */
export const VmParityHistoryEntrySchema = z
  .object({
    subdomain: z.string(),
    checked_at: z.string(),
    verdict: z.enum(VM_PARITY_VERDICTS),
    compliant: z.boolean(),
    drift: z.number().int().nonnegative(),
    manifest_version: z.string(),
    checker_exit: z.number().int().min(-1),
    source: z.enum(VM_PARITY_SOURCES),
  })
  .strict();
export type VmParityHistoryEntry = z.infer<typeof VmParityHistoryEntrySchema>;

/**
 * The `GET /api/admin-vms/parity-history[?vm=<subdomain>]` response: ledger
 * lines in append (chronological) order, filtered to subdomains present in the
 * fleet inventory. A plain array — an absent ledger is `[]`, not a verdict.
 */
export const VmParityHistoryResponseSchema = z.array(
  VmParityHistoryEntrySchema
);
export type VmParityHistoryResponse = z.infer<
  typeof VmParityHistoryResponseSchema
>;

// ── Job create / status (R2) ─────────────────────────────────────────────────
/**
 * A single flag value handed to `buildJob`: `true` = presence-only flag,
 * `string`/`number` = valued, `array` = a repeatable flag, `false` = omit.
 * Mirrors the server's `JobInputs["flags"]` value union.
 */
export const JobFlagValueSchema = z.union([
  z.boolean(),
  z.string(),
  z.number(),
  z.array(z.union([z.string(), z.number()])),
]);

/**
 * `POST /admin-vms/jobs` body. `kind` + the raw operator inputs handed to
 * `buildJob`, which is the security seam: an out-of-allowlist flag or bad value
 * is rejected there with a 400 and no job record is created (AC-2). The flag
 * MAP is validated for shape only here; the flag NAMES/VALUES are validated by
 * `buildJob`'s per-script allowlist.
 */
export const CreateJobRequestSchema = z.object({
  kind: JobKindSchema,
  positionals: z.array(z.string()).optional(),
  flags: z.record(z.string(), JobFlagValueSchema).optional(),
});
export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

/**
 * A job record as surfaced to the operator. Allowlisted from the server's
 * `JobRecord`: the internal `scriptPath`/`logPath`/`unitName` are omitted (the
 * SSE log endpoint is the log-access surface). `result` passes through #2468's
 * nullable `JobRecord.result` (parsed health/reconcile `--json`); `unknown`
 * because the shape is the script's own document.
 */
export const JobStatusResponseSchema = z.object({
  id: z.string(),
  kind: JobKindSchema,
  argv: z.array(z.string()),
  state: JobStateSchema,
  mutating: z.boolean(),
  exitCode: z.number().nullable(),
  actionItems: z.array(z.string()).nullable(),
  result: z.unknown().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type JobStatusResponse = z.infer<typeof JobStatusResponseSchema>;

/**
 * `POST /admin-vms/jobs` response. `started:false` means the (mutating) job is
 * queued behind a held fleet lock; `lockReason` carries the "held by …" text so
 * the UI can surface it instead of failing silently.
 */
export const CreateJobResponseSchema = z.object({
  job: JobStatusResponseSchema,
  started: z.boolean(),
  lockReason: z.string().optional(),
});
export type CreateJobResponse = z.infer<typeof CreateJobResponseSchema>;

// ── Preflight (R4) ───────────────────────────────────────────────────────────
/** Non-secret fleet-lock holder metadata (operator-only). */
export const FleetLockHolderSchema = z.object({
  instance: z.string(),
  jobId: z.string(),
  unitName: z.string(),
  acquiredAt: z.number(),
});
export type FleetLockHolder = z.infer<typeof FleetLockHolderSchema>;

/**
 * `GET /admin-vms/preflight`. `enabled`/`reason` are the LIVE capability verdict
 * (so the UI can show WHY the panel is disabled without a restart); `fleetLock`
 * is the read-only lock status. Note: this route sits BEHIND the capability
 * 404-guard, so a client that can read it is already on an enabled instance —
 * the capability-disabled reason therefore reaches a client only in the narrow
 * "enabled at boot, disabled live" window; #2470 maps a 404 to gate-closed.
 */
export const PreflightResponseSchema = z.object({
  enabled: z.boolean(),
  reason: z.string(),
  fleetLock: z.object({
    held: z.boolean(),
    holder: FleetLockHolderSchema.optional(),
  }),
});
export type PreflightResponse = z.infer<typeof PreflightResponseSchema>;

// ── Deprovision two-step (R5) ────────────────────────────────────────────────
/**
 * `POST /admin-vms/deprovision/dry-run` body. `subdomain` is re-validated by
 * `buildJob`'s `deprovision` positional pattern (`^[a-z0-9][a-z0-9-]*$`).
 * `email` (optional) becomes `--email`, the fallback for a gateway whose mappings
 * cannot be listed. `serviceEnd` (optional, #5257 F9) becomes `--service-end`, the
 * effective service end E that dates the backup retention record; `buildJob`
 * validates it (a real calendar date, not more than 30 days ago). Without it the
 * teardown keeps the bucket in service and ends INCOMPLETE RETENTION. The dialog
 * always sends it; the API keeps it optional.
 */
export const DeprovisionDryRunRequestSchema = z.object({
  subdomain: z.string().min(1),
  email: z.string().optional(),
  serviceEnd: z.string().optional(),
});
export type DeprovisionDryRunRequest = z.infer<
  typeof DeprovisionDryRunRequestSchema
>;

/**
 * `POST /admin-vms/deprovision/dry-run` response. The transcript is the (default
 * dry-run) deprovision job's log; `confirmationToken` is a fresh, short-lived,
 * single-use, server-side token BOUND to the exact validated argv previewed
 * here — the apply step replays that argv + `--apply`, so the service end and
 * gateway host below are the ones the apply uses (#5257 F9).
 *
 * `serviceEnd` echoes the request's E; `deleteEligibleAt` is E + 30 days (ISO),
 * the earliest date of the dated purge; both are null without a service end.
 * `gatewayHost` is the `--gateway-host` passed (the inventory record's
 * `gateway_host`, else the server's `HAPI_VM_GATEWAY_HOST`), or null when there
 * is none — the teardown then cannot write the retention record.
 */
export const DeprovisionDryRunResponseSchema = z.object({
  jobId: z.string(),
  subdomain: z.string(),
  state: JobStateSchema,
  transcript: z.string(),
  confirmationToken: z.string(),
  serviceEnd: z.string().nullable(),
  deleteEligibleAt: z.string().nullable(),
  gatewayHost: z.string().nullable(),
});
export type DeprovisionDryRunResponse = z.infer<
  typeof DeprovisionDryRunResponseSchema
>;

/**
 * `POST /admin-vms/deprovision/apply` body. BOTH the fresh `confirmationToken`
 * (from a matching dry-run) AND the `typedSubdomain` (which must equal the
 * token's bound subdomain exactly) are required — the API cannot express a
 * one-shot destructive call.
 */
export const DeprovisionApplyRequestSchema = z.object({
  confirmationToken: z.string().min(1),
  typedSubdomain: z.string().min(1),
});
export type DeprovisionApplyRequest = z.infer<
  typeof DeprovisionApplyRequestSchema
>;

// ── Reconcile detection result (#2472, Sub E) ────────────────────────────────
/**
 * The six reconcile contract surfaces, in canonical render order. Mirrors
 * `scripts/lib/reconcile-surfaces.sh`'s `RECONCILE_SURFACES`. The UI renders ALL
 * six even when a surface is absent from a detection result: a default detect
 * covers all six (reconcile-vm.sh reads `$RECONCILE_SURFACES` when no `--surface`
 * is given — the usage text's "all five" is a stale comment, corrected in #2472).
 */
export const RECONCILE_SURFACES = [
  "wrapper",
  "handoff-config",
  "binary-version",
  "forced-command-keys",
  "age-recipient",
  "handoff-secret",
] as const;
export type ReconcileSurfaceName = (typeof RECONCILE_SURFACES)[number];

/**
 * The surfaces that offer an automated repair. `handoff-secret` is
 * DETECTION-ONLY by design (#2316) — the tool never transports key material, so
 * there is no repair. The UI shows the rotate-secret procedure instead of a
 * repair button, and the server rejects a `reconcile-repair --surface
 * handoff-secret` in `buildJob`'s `applyGuards` (the R13 security seam).
 */
export const RECONCILE_REPAIRABLE_SURFACES: readonly ReconcileSurfaceName[] =
  RECONCILE_SURFACES.filter(s => s !== "handoff-secret");

/** The four per-surface verdicts. `error` is rendered distinctly from drift. */
export const RECONCILE_VERDICTS = [
  "match",
  "diverged",
  "absent",
  "error",
] as const;
export type ReconcileVerdict = (typeof RECONCILE_VERDICTS)[number];

/**
 * One surface's detection verdict. `verdict` is `z.string()` (not the enum) so a
 * future script verdict never fails the whole document parse — the UI narrows to
 * the known set and renders anything else as `error`. `.passthrough()` for the
 * same forward-compat reason (shared/CLAUDE.md), since this is an external
 * script's document.
 */
export const ReconcileSurfaceSchema = z
  .object({
    name: z.string(),
    verdict: z.string(),
    observed: z.string(),
    expected: z.string(),
  })
  .passthrough();
export type ReconcileSurface = z.infer<typeof ReconcileSurfaceSchema>;

export const ReconcileVmSchema = z
  .object({
    name: z.string(),
    target: z.string(),
    surfaces: z.array(ReconcileSurfaceSchema),
  })
  .passthrough();
export type ReconcileVm = z.infer<typeof ReconcileVmSchema>;

export const ReconcileReferenceSchema = z
  .object({
    host: z.string(),
    kind: z.string(),
    source: z.string(),
    digest: z.string(),
    provenance: z.string(),
    provenance_detail: z.string(),
  })
  .passthrough();
export type ReconcileReference = z.infer<typeof ReconcileReferenceSchema>;

/**
 * The parsed `--json` document of a `reconcile-detect` job — the shape
 * `scripts/reconcile-vm.sh --json` emits (verified against source + a
 * `--print-reference` run). Consumed by `ReconcilePanel` via `safeParse` over
 * the job's `result` (#2468 persists that verbatim as `unknown`), so a shape
 * drift degrades to "detection unavailable" rather than a crash.
 */
export const ReconcileDetectResultSchema = z
  .object({
    reference: ReconcileReferenceSchema,
    vms: z.array(ReconcileVmSchema),
    all_match: z.boolean(),
  })
  .passthrough();
export type ReconcileDetectResult = z.infer<typeof ReconcileDetectResultSchema>;

/**
 * `POST /admin-vms/reconcile/:name/repair` body. Exactly ONE surface — the API
 * cannot express a blanket repair-all (the server's `buildJob` guard also
 * enforces exactly one `--surface` and rejects `handoff-secret`). `age-recipient`
 * naming is satisfied structurally: every repair names its single surface here.
 * All six are accepted at the shape layer; `handoff-secret` is rejected by
 * `buildJob` with a clear message (defense-in-depth, R13).
 */
export const ReconcileRepairRequestSchema = z.object({
  surface: z.enum(RECONCILE_SURFACES),
});
export type ReconcileRepairRequest = z.infer<
  typeof ReconcileRepairRequestSchema
>;

// ── Health-check result (#2472, Sub E) ───────────────────────────────────────
/**
 * The health checks, in canonical render order: exactly the names
 * `infrastructure/cloud-vm/check-cloud-health.sh` emits via `add_check`, in the
 * order a healthy sweep emits them (not their order in the script's source, where
 * the helper functions come first). `HealthCard` renders only these names, so a check
 * missing here never reaches `/admin/vms` (#5525: `hostkey-pin`, `vm-parity`
 * and `account-mappings` had been emitted but never shown).
 * `scripts/test-check-cloud-health.sh` (32g) fails when the two lists diverge.
 * There is no "service state" check (expert review R11).
 */
export const HEALTH_CHECKS = [
  "reachability",
  "disk",
  "mem",
  "binary-version",
  "handoff",
  "gateway-mapping",
  "hostkey-pin",
  "backup",
  "backup-markers",
  "vm-parity",
  "account-mappings",
] as const;
export type HealthCheckName = (typeof HEALTH_CHECKS)[number];

/** The three health verdicts. `alert` is rendered distinctly. */
export const HEALTH_VERDICTS = ["ok", "alert", "skipped"] as const;
export type HealthVerdict = (typeof HEALTH_VERDICTS)[number];

/**
 * One per-check result. `verdict` is `z.string()` (permissive parse; the UI
 * narrows) and `.passthrough()` for forward-compat. `class` is the optional
 * alert sub-class the script attaches (e.g. `disk-collector`, `version-stale`).
 */
export const HealthCheckSchema = z
  .object({
    check: z.string(),
    verdict: z.string(),
    observed: z.string(),
    expected: z.string(),
    class: z.string().optional(),
  })
  .passthrough();
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const HealthInstanceSchema = z
  .object({
    name: z.string(),
    url: z.string(),
    checks: z.array(HealthCheckSchema),
  })
  .passthrough();
export type HealthInstance = z.infer<typeof HealthInstanceSchema>;

export const HealthSummarySchema = z
  .object({
    instances: z.number(),
    ok: z.number(),
    alerts: z.number(),
    skipped: z.number(),
  })
  .passthrough();
export type HealthSummary = z.infer<typeof HealthSummarySchema>;

/**
 * The parsed `--json` document of a `health-check` job — the shape
 * `check-cloud-health.sh --json` emits (verified against a live empty-sweep
 * run). `reference_version` is nullable (unresolved reference). The sweep is
 * fleet-wide (one job → every instance; `check-cloud-health.sh` has no
 * per-instance filter, expert review R30), so each `HealthCard` selects its
 * instance from `instances[]` by name. Consumed via `safeParse` over the job's
 * `result`.
 */
export const HealthResultSchema = z
  .object({
    generated_at: z.string(),
    config: z.string(),
    reference_version: z.string().nullable(),
    gateway_status: z.string(),
    instances: z.array(HealthInstanceSchema),
    summary: HealthSummarySchema,
  })
  .passthrough();
export type HealthResult = z.infer<typeof HealthResultSchema>;
