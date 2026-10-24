// SPDX-License-Identifier: AGPL-3.0-only
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z, type ZodType } from "zod";

import {
  CreateJobRequestSchema,
  DeprovisionApplyRequestSchema,
  DeprovisionDryRunRequestSchema,
  ReconcileRepairRequestSchema,
  VM_PARITY_SOURCES,
  VM_PARITY_STALE_AFTER_MS,
  VmInventoryResponseSchema,
  VmParityHistoryResponseSchema,
  VmParityVerdictSchema,
  type JobStatusResponse,
  type PreflightResponse,
  type VmInventoryEntry,
  type VmInventoryVerdict,
  type VmParityHistoryEntry,
  type VmParitySummary,
} from "@hapi/protocol/adminVms";

import type { WebAppEnv } from "../middleware/auth";
import { createRateLimiter } from "../middleware/rateLimit";
import {
  decodeFailureMeta,
  decodeVmParityLedger,
  ledgerReadFailureMeta,
  serializeFailureMeta,
  type ParityHistoryLogMeta,
} from "./adminVmsParityLedger";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import {
  buildJob,
  deleteEligibleIso,
  isTerminalState,
  lookupDeprovisionGatewayHost,
  JobValidationError,
  maskSecretLine,
  maskSecretText,
  operatorActor,
  parseInventoryAccessTokens,
  parseSecretEnvValues,
  type AuditAction,
  type AuditLog,
  type BuiltJob,
  type EnabledProvisioner,
  type JobRecord,
  type ProvisionerHandle,
  type RunJobHooks,
} from "../../provisioner";

/**
 * Admin VM provisioning control plane — the operator-only HTTP surface (issue
 * #2469, epic #2467 Sub B). Backs the #2470 admin page. Consumes Sub A's
 * `initProvisioner()` handle (#2468).
 *
 * ## 🔴 Auth comes from the MOUNT POSITION — do not add an inline JWT middleware
 *
 * This factory takes NO `jwtSecret`, exactly like `extensionAdmin.ts`. It is
 * mounted in `web/buildWebApp.ts` AFTER the global `app.use("/api/*",
 * createAuthMiddleware(...))` gate, so every route here is JWT-gated
 * positionally (Hono matches handlers in registration order — that ordering IS
 * the auth mechanism). **If you move this mount above the global gate,
 * `adminVms.test.ts`'s auth-differential test fails.** That test is the
 * regression guard.
 *
 * ## 🔴 The capability guard is a SEPARATE, path-scoped first middleware → 404
 *
 * The SAME binary ships to the operator (RP1) and to user cloud VMs. On a user
 * VM the provisioner is INERT and every admin-VM route must return **404** (not
 * 403) so the binary never advertises that the routes exist. The guard below is
 * scoped to `app.use("/admin-vms/*", …)` — NEVER `"*"`: mounted at the shared
 * `/api` prefix, a bare `use("*")` becomes an `/api/*` middleware on the parent
 * app and would 404 every later-mounted `/api` route on a capability-closed
 * instance. It gates on the TOP-LEVEL discriminant `provisioner.enabled` — the
 * disabled handle is `{enabled:false, reason}` with no `capability` member, so
 * never read `provisioner.capability`.
 *
 * ## 🔴 The inventory endpoint is an ALLOWLIST, never a blocklist
 *
 * The fleet inventory records a per-VM `access_token`. `toSanitizedEntry` reads
 * ONLY `{name, url, disk_threshold_pct}` and the OUTPUT is re-validated against
 * the `.strict()` `VmInventoryEntry` schema — so a token can never serialize out
 * even if a future inventory field is added (mirrors the server's
 * `RedactedAccount`). The raw record is never logged. The optional `vmParity`
 * field (#3557) is likewise a named PROJECTION of Sub F's per-VM status file,
 * joined by subdomain in the route and re-validated by the same schema.
 *
 * ## 🔴 Deprovision is two-step and cannot express a one-shot destructive call
 *
 * `POST /deprovision/dry-run` runs the script's default dry-run (read-only job,
 * no fleet lock), returns the transcript + a fresh server-issued
 * `confirmationToken` bound to the EXACT validated argv previewed. `POST
 * /deprovision/apply` requires that token AND a `typedSubdomain` matching
 * exactly; only then does it replay `argv + --apply` (a mutating job → fleet
 * lock). The token is single-use, short-lived, and consumed delete-before-spawn.
 */

/** Injectable dependencies for {@link createAdminVmRoutes}. */
export interface AdminVmRoutesOptions {
  /** The `initProvisioner()` handle — enabled (live surface) or disabled (inert). */
  provisioner: ProvisionerHandle;
  /**
   * ABSOLUTE path to the fleet inventory JSON (`cloud-instances.json`). Injected
   * (never cwd-relative): the dev/prod instances run from separate checkouts, so
   * both read the per-machine canonical file under
   * `~/.local/state/hapimatic-provision/` unless an env override names another
   * (#3414; see the server-wiring site in buildWebApp.ts).
   */
  inventoryPath: string;
  /** Inventory-file reader (default `node:fs`). Tests inject a fixture. */
  readInventory?: (path: string) => Promise<string>;
  /**
   * The deprovision dry-run's `--gateway-host` when the VM's inventory record
   * has none — see {@link lookupDeprovisionGatewayHost} (#5257 F9, D3). Wired
   * from `HAPI_VM_GATEWAY_HOST` (buildWebApp.ts).
   */
  defaultGatewayHost?: string;
  /**
   * Inventory-file mtime source for the #2552 STALE verdict (default `node:fs`
   * `stat`). Tests inject a fixture mtime. Only consulted when
   * `inventoryStaleAfterMs` is set.
   */
  statInventory?: (path: string) => Promise<{ mtimeMs: number }>;
  /**
   * OPT-IN staleness bound (ms) for the #2552 read-path divergence verdict. When
   * set, the inventory endpoint returns a loud `stale` verdict if the file's
   * mtime is older than `now - inventoryStaleAfterMs`. UNSET (the default) means
   * the stale check is disabled, so a quiet-but-healthy fleet is never
   * false-flagged (OR-1). Tune to the provisioning cadence via
   * `HAPI_VM_INVENTORY_STALE_MS`.
   */
  inventoryStaleAfterMs?: number;
  /**
   * ABSOLUTE path to Sub F's append-only vm-parity ledger (`ledger.ndjson`,
   * #3556 ruling D1(a)) — RP1-local runtime state under `HAPI_VM_PARITY_STATE`,
   * resolved at the server-wiring site. Read by `GET /admin-vms/parity-history`
   * (#3593); an absent file means no parity run has been recorded yet. F writes
   * each VM's `<subdomain>.json` in the SAME directory (vm-parity.md § "Status
   * file"), so `GET /admin-vms/inventory` reads the #3557 parity column from
   * `dirname(vmParityLedgerPath)` — one option names the one directory.
   */
  vmParityLedgerPath: string;
  /** Ledger reader (default `node:fs`). Tests inject a fixture. */
  readVmParityLedger?: (path: string) => Promise<string>;
  /**
   * Status-file reader for the #3557 parity column (default `node:fs`). The same
   * convention as `readVmParityLedger`: it THROWS when the file is missing, and
   * the route treats ENOENT as never checked and any other failure as
   * `unreadable`. Tests inject a fixture.
   */
  readVmParityStatus?: (path: string) => Promise<string>;
  /** Per-job log reader for SSE follow (default `node:fs`, missing ⇒ ""). */
  readLog?: (logPath: string) => Promise<string>;
  /** SSE follow / dry-run poll interval, ms (default 500). */
  logPollIntervalMs?: number;
  /** Bounded wait for a dry-run to reach terminal before returning, ms (default 60s). */
  dryRunMaxWaitMs?: number;
  /** Clock for token expiry (default `Date.now`). */
  now?: () => number;
  /** Confirmation-token generator (default `crypto.randomUUID`). */
  genToken?: () => string;
  /** Confirmation-token TTL, ms (default 5 min). */
  confirmTokenTtlMs?: number;
  /**
   * Append-only audit log (issue #2471 R3). Records `create` (job/dry-run) and
   * `apply-confirm` (deprovision apply) here with the operator's JWT identity; the
   * runner records `terminal`. REQUIRED so the surface can never run un-audited.
   */
  auditLog: AuditLog;
  /**
   * ABSOLUTE path to the operator infra env file (`~/.oci/hapimatic-infra.env`) —
   * the source of value-maskable secret values for live-log masking (issue #2471
   * R4). Optional: when unset/absent, masking falls back to the value-independent
   * NAME=value + pattern + entropy layers.
   */
  secretEnvPath?: string;
  /** Infra-env reader (default `node:fs`). Tests inject a fixture. */
  readSecretEnv?: (path: string) => Promise<string>;
  /**
   * Per-minute cap on job-creating POSTs (issue #2471 R6). Default: env
   * `HAPI_VM_JOB_RATE_LIMIT` or 30. A shared limiter spans `POST /jobs`,
   * `POST /deprovision/dry-run`, and `POST /deprovision/apply` — the apply cap
   * doubles as the confirmation-token brute-force guard.
   */
  jobRateLimit?: number;
  /** Rate-cap window, ms (default 60_000). */
  jobRateWindowMs?: number;
  /**
   * Structured error sink for the parity-history 500 paths (#4392). Wired to
   * `options.errorLogger` at the server-wiring site (the #2561 pattern), so a
   * 500 is never silent. `meta` carries only non-secret locators — an errno
   * code, a ledger line number, zod issue paths/codes — never a ledger or
   * inventory value. Default: no-op (tests inject a recorder).
   */
  logError?: (message: string, meta: Record<string, unknown>) => void;
}

/** A pending deprovision confirmation, bound to the exact previewed argv. */
interface ConfirmationEntry {
  built: BuiltJob;
  subdomain: string;
  expiresAt: number;
}

const defaultReadInventory = (p: string): Promise<string> =>
  readFile(p, "utf8");
const defaultStatInventory = (p: string): Promise<{ mtimeMs: number }> =>
  stat(p).then(s => ({ mtimeMs: s.mtimeMs }));
// Both vm-parity readers (ledger + per-VM status file): ENOENT propagates.
const defaultReadVmParityFile = (p: string): Promise<string> =>
  readFile(p, "utf8");

/**
 * Resolve Sub F's parity ledger path (#3593) exactly as F's writer does:
 * `${HAPI_VM_PARITY_STATE:-$HOME/.local/state/hapimatic/vm-parity}/ledger.ndjson`
 * (docs/internal/architecture/vm-parity.md § Status file). The env var names
 * the state DIRECTORY, never the file. `||`, not `??`: bash `:-` treats an
 * EMPTY value as unset, so a set-but-empty variable must also fall back to the
 * default — `??` would resolve `ledger.ndjson` against the server's cwd while
 * the writer appends under $HOME (a silent split-brain that reads as `[]`).
 */
export function resolveVmParityLedgerPath(
  env: Record<string, string | undefined>,
  home: string
): string {
  const stateDir =
    env.HAPI_VM_PARITY_STATE || join(home, ".local/state/hapimatic/vm-parity");
  return join(stateDir, "ledger.ndjson");
}
const defaultReadLog = (p: string): Promise<string> =>
  readFile(p, "utf8").then(
    text => text,
    () => ""
  );
const defaultReadSecretEnv = (p: string): Promise<string> =>
  readFile(p, "utf8");

/** Allowlist a `JobRecord` down to the operator-facing shape (no internal paths). */
function toJobStatus(rec: JobRecord): JobStatusResponse {
  return {
    id: rec.id,
    kind: rec.kind,
    argv: rec.argv,
    state: rec.state,
    mutating: rec.mutating,
    exitCode: rec.exitCode,
    actionItems: rec.actionItems,
    result: rec.result,
    createdAt: rec.createdAt,
    startedAt: rec.startedAt,
    finishedAt: rec.finishedAt,
  };
}

/**
 * Allowlist ONE raw inventory record to the sanitized entry. Reads only the
 * three UI-rendered fields — never `access_token`, `bucket`, or `namespace`.
 * The OUTPUT is re-validated by the caller against the `.strict()` schema.
 */
function toSanitizedEntry(record: unknown): VmInventoryEntry {
  const r = (record ?? {}) as Record<string, unknown>;
  const entry: VmInventoryEntry = {
    name: typeof r.name === "string" ? r.name : "",
    url: typeof r.url === "string" ? r.url : "",
  };
  if (typeof r.disk_threshold_pct === "number") {
    entry.diskThresholdPct = r.disk_threshold_pct;
  }
  return entry;
}

// ── #3557: Sub F's per-VM parity status file → the row's `vmParity` ──────────
/** Sub F's subdomain grammar (provision.sh's own shape) — also the file name. */
const VM_PARITY_SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * INPUT schema for ONE `<subdomain>.json` — Sub F's twelve schema-v1 fields
 * (`docs/internal/architecture/vm-parity.md` § "Status file"). Deliberately NOT
 * `.strict()`: F's contract lets a field be ADDED without bumping
 * `schema_version`, so unknown keys are stripped, never fatal. A rename, retype
 * or removal bumps the version, which `z.literal(1)` rejects.
 */
const VmParityStatusRecordSchema = z.object({
  schema_version: z.literal(1),
  subdomain: z.string().regex(VM_PARITY_SUBDOMAIN),
  target: z.string(),
  compliant: z.boolean(),
  verdict: VmParityVerdictSchema,
  drift: z.number().int().nonnegative(),
  excluded: z.number().int().nonnegative(),
  manifest_version: z.string().min(1),
  checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
  checked_by: z.string(),
  checker_exit: z.number().int().min(-1).max(255),
  source: z.enum(VM_PARITY_SOURCES),
});

const VM_PARITY_UNREADABLE: VmParitySummary = { state: "unreadable" };

/**
 * Project one status-file body onto the row summary. Pure. Anything that is not
 * a self-consistent schema-v1 record for THIS subdomain is `unreadable` — shown
 * as such, never passed off as "never checked" or as compliant. Only the
 * rendered fields survive the projection.
 */
function toVmParitySummary(
  text: string,
  subdomain: string,
  nowMs: number
): VmParitySummary {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return VM_PARITY_UNREADABLE;
  }
  const parsed = VmParityStatusRecordSchema.safeParse(json);
  if (!parsed.success) return VM_PARITY_UNREADABLE;
  const rec = parsed.data;
  const checkedMs = Date.parse(rec.checked_at);
  if (
    rec.subdomain !== subdomain ||
    rec.compliant !== (rec.verdict === "pass") ||
    !Number.isFinite(checkedMs)
  ) {
    return VM_PARITY_UNREADABLE;
  }
  return {
    state: "recorded",
    verdict: rec.verdict,
    compliant: rec.compliant,
    drift: rec.drift,
    manifestVersion: rec.manifest_version,
    checkedAt: rec.checked_at,
    stale: nowMs - checkedMs > VM_PARITY_STALE_AFTER_MS,
  };
}

/**
 * Read + project one VM's status file. `undefined` = no file (ENOENT: never
 * checked) or a name outside the subdomain grammar (no path is built from it).
 * Never throws: any other read failure is `unreadable`, so one bad file can
 * never 500 the whole inventory.
 */
async function readVmParitySummary(deps: {
  stateDir: string;
  subdomain: string;
  readVmParityStatus: (path: string) => Promise<string>;
  nowMs: number;
}): Promise<VmParitySummary | undefined> {
  if (!VM_PARITY_SUBDOMAIN.test(deps.subdomain)) return undefined;
  let text: string;
  try {
    text = await deps.readVmParityStatus(
      join(deps.stateDir, `${deps.subdomain}.json`)
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return VM_PARITY_UNREADABLE;
  }
  return toVmParitySummary(text, deps.subdomain, deps.nowMs);
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Parse + Zod-validate a JSON request body. Returns the validated data, or a
 * ready-to-return 400 Response — the single body-parse error shape shared by
 * every POST route here (dedupes what were three identical parse+validate
 * blocks; malformed JSON and schema-invalid bodies both yield a 400).
 */
async function readValidatedBody<T>(
  c: Context<WebAppEnv>,
  schema: ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid JSON body" }, 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json(
        { error: "invalid request", details: parsed.error.issues },
        400
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

/**
 * The classified state of the fleet-inventory read-path (#2552, Task 3): a
 * healthy result carrying the RAW array, or one of the loud divergence verdicts,
 * or a genuine server failure. `ok` returns the raw array (NOT sanitized) so the
 * endpoint keeps the `.strict()` OUTPUT allowlist re-validation in one place —
 * this helper never widens the sanitization surface.
 */
type InventoryClassification =
  | { kind: "ok"; raw: unknown[] }
  | { kind: "missing" }
  | { kind: "stale"; ageMs: number }
  | { kind: "schema-drift"; detail: string }
  | { kind: "unavailable"; code: string }
  | { kind: "unreadable" };

/**
 * Classify the fleet inventory into a healthy result or a loud divergence
 * verdict (#2552). Pure + injectable: consumes the same `readInventory` /
 * `statInventory` the route factory was constructed with (a real fs by default,
 * a fixture in tests). Distinguishes "the fleet diverged" (missing / stale /
 * schema-drift verdicts) from "the server broke" (`unavailable` non-ENOENT fs
 * error, `unreadable` JSON parse failure — both stay 500s at the endpoint).
 */
async function classifyInventory(deps: {
  inventoryPath: string;
  readInventory: (path: string) => Promise<string>;
  statInventory: (path: string) => Promise<{ mtimeMs: number }>;
  inventoryStaleAfterMs: number | undefined;
  now: () => number;
}): Promise<InventoryClassification> {
  const {
    inventoryPath,
    readInventory,
    statInventory,
    inventoryStaleAfterMs,
    now,
  } = deps;
  let text: string;
  try {
    text = await readInventory(inventoryPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { kind: "missing" };
    }
    // The errno is a non-secret locator (EACCES vs EIO vs EISDIR) for the
    // parity-history log (#4392); no response body carries it.
    return { kind: "unavailable", code: code ?? "unknown" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  if (!Array.isArray(raw)) {
    return {
      kind: "schema-drift",
      detail: "inventory root is not a JSON array",
    };
  }
  // Recognizable-shape check: every record must carry a string `name` + `url`. A
  // drifted document (wrong keys / a different schema) is surfaced as a loud
  // verdict instead of silently coercing to blank rows via toSanitizedEntry's
  // defensive `?? ""` defaults — the exact silent-partial-render #2552 targets.
  for (let i = 0; i < raw.length; i++) {
    const rec = raw[i] as Record<string, unknown> | null;
    if (
      typeof rec !== "object" ||
      rec === null ||
      typeof rec.name !== "string" ||
      typeof rec.url !== "string"
    ) {
      return {
        kind: "schema-drift",
        detail: `entry ${i} is missing a string name/url`,
      };
    }
  }
  // Stale check is OPT-IN: only when a freshness bound is configured. A
  // quiet-but-healthy fleet (old mtime, valid inventory) is NEVER flagged by
  // default (OR-1). A stat failure is non-fatal — never manufacture a stale
  // verdict from a missing stat.
  if (inventoryStaleAfterMs !== undefined) {
    try {
      const { mtimeMs } = await statInventory(inventoryPath);
      const ageMs = now() - mtimeMs;
      if (ageMs > inventoryStaleAfterMs) return { kind: "stale", ageMs };
    } catch {
      // fall through to the healthy path
    }
  }
  return { kind: "ok", raw };
}

export function createAdminVmRoutes(
  opts: AdminVmRoutesOptions
): Hono<WebAppEnv> {
  const {
    provisioner,
    inventoryPath,
    auditLog,
    readInventory = defaultReadInventory,
    defaultGatewayHost,
    statInventory = defaultStatInventory,
    inventoryStaleAfterMs,
    vmParityLedgerPath,
    readVmParityLedger = defaultReadVmParityFile,
    readVmParityStatus = defaultReadVmParityFile,
    readLog = defaultReadLog,
    readSecretEnv = defaultReadSecretEnv,
    secretEnvPath,
    logPollIntervalMs = 500,
    dryRunMaxWaitMs = 60_000,
    now = () => Date.now(),
    genToken = () => randomUUID(),
    confirmTokenTtlMs = 5 * 60_000,
    jobRateLimit = Number(process.env.HAPI_VM_JOB_RATE_LIMIT) || 30,
    jobRateWindowMs = 60_000,
    logError = () => {},
  } = opts;

  const app = new Hono<WebAppEnv>();

  // Server-side, single-use, expiring confirmation-token store. In-memory is
  // correct: a token is bound to a specific server process's in-flight preview.
  const confirmTokens = new Map<string, ConfirmationEntry>();

  // ── R6: shared per-minute job-creation rate cap ─────────────────────────────
  // ONE limiter instance shared across every job-creating POST (create, dry-run,
  // apply) so a burst across endpoints counts together; default key is the
  // operator namespace (per-operator/instance). Instantiated INSIDE the factory
  // (house rule) so each `createAdminVmRoutes` call — including per test — gets a
  // fresh bucket map. Applied AFTER the capability 404-guard, so a user VM never
  // rate-limits (it 404s first). Covering `apply` here also caps confirmation-
  // token attempts (brute-force guard). #2472's dedicated health/reconcile POSTs
  // are ALSO job-creating and MUST reuse this limiter when they land; today those
  // kinds are created via `POST /admin-vms/jobs`, which is already capped.
  const jobCreationLimiter = createRateLimiter({
    name: "admin-vms-job-creation",
    limit: jobRateLimit,
    windowMs: jobRateWindowMs,
  });

  // ── R4: collect the value-maskable secret set for live-log masking ──────────
  // Sourced from the operator infra env file + the fleet inventory `access_token`s.
  // Read per SSE connection / per dry-run (always fresh; inventory can change).
  // A missing/unreadable source is non-fatal — the value-independent NAME=value +
  // pattern + entropy layers still fire. NEVER logs the file it reads.
  async function collectMaskValues(): Promise<string[]> {
    const values: string[] = [];
    if (secretEnvPath) {
      try {
        values.push(
          ...parseSecretEnvValues(await readSecretEnv(secretEnvPath))
        );
      } catch {
        /* infra env absent/unreadable — value-independent layers still mask */
      }
    }
    try {
      values.push(
        ...parseInventoryAccessTokens(await readInventory(inventoryPath))
      );
    } catch {
      /* inventory absent — fine */
    }
    return values;
  }

  /** Operator actor for the audit trail, from the JWT context (#2471 R3). */
  function auditActor(c: Context<WebAppEnv>): ReturnType<typeof operatorActor> {
    return operatorActor(c.get("userId"), c.get("namespace"));
  }

  /**
   * A `runJob` hook that appends a `create` / `apply-confirm` audit entry (operator
   * actor) BEFORE the unit spawn (#2471 R3) — ONE definition of the entry shape,
   * shared by the job-create, dry-run, and apply routes so the security-critical
   * audit fields cannot drift across call sites.
   */
  function auditCreationHook(
    c: Context<WebAppEnv>,
    action: AuditAction
  ): RunJobHooks {
    return {
      onPersist: rec =>
        auditLog.append({
          actor: auditActor(c),
          action,
          jobId: rec.id,
          kind: rec.kind,
          flags: rec.argv,
          state: rec.state,
        }),
    };
  }

  // ── Capability 404-guard: path-scoped, gates on the top-level discriminant ──
  app.use("/admin-vms/*", async (c, next) => {
    if (!provisioner.enabled) {
      return c.notFound(); // 404 — never advertise the routes on a user VM
    }
    return next();
  });

  /**
   * Drive a job to a terminal state (bounded). Idempotent `finalize` transitions
   * a still-running detached unit; returns the terminal record, or the last
   * record observed at the deadline.
   */
  async function driveToTerminal(
    prov: EnabledProvisioner,
    id: string
  ): Promise<JobRecord> {
    const deadline = now() + dryRunMaxWaitMs;
    for (;;) {
      let rec = prov.store.get(id);
      if (!rec) throw new Error(`admin-vms: job vanished mid-poll: ${id}`);
      if (rec.state === "running") rec = await prov.runner.finalize(id);
      if (isTerminalState(rec.state) || now() >= deadline) return rec;
      await sleep(logPollIntervalMs);
    }
  }

  // ── R1 + #2552: sanitized fleet inventory with a LOUD divergence verdict ─────
  // A missing / stale / schema-drifted inventory returns an explicit
  // `VmInventoryVerdict` (HTTP 200) rather than the old silent `[]` that hid a
  // read/write path divergence (#2473 OOS-2). The verdict IS a successful
  // determination of the fleet state — hence 200, keeping the client in its
  // success path (a non-2xx would throw `ApiError` before the panel could render
  // the reason). Genuine SERVER failures (non-ENOENT fs error, unparseable JSON)
  // stay loud 500s — "the server broke", distinct from "the fleet diverged". The
  // `.strict()` OUTPUT allowlist re-validation on the healthy path is unchanged,
  // so a leaked secret still 500s rather than reaching the client.
  app.get(
    "/admin-vms/inventory",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-inventory",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return the sanitized cloud-VM fleet (name, url, disk threshold, per-VM vmParity summary), or a loud verdict when the inventory is missing, stale, or schema-drifted.",
        whenToUse: "When the operator wants to see the current cloud-VM fleet.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/admin-vms/inventory",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const classification = await classifyInventory({
        inventoryPath,
        readInventory,
        statInventory,
        inventoryStaleAfterMs,
        now,
      });
      switch (classification.kind) {
        case "missing":
          return c.json(
            {
              status: "missing",
              message:
                "The fleet inventory file was not found on the server read-path. " +
                "Provision at least one VM, or confirm the read-path and write-path " +
                "resolve to the SAME inventory file (single-sourced via INVENTORY_FILE / HAPI_VM_INVENTORY_FILE).",
            } satisfies VmInventoryVerdict,
            200
          );
        case "stale":
          return c.json(
            {
              status: "stale",
              message:
                `The fleet inventory has not been written in ${Math.round(classification.ageMs / 1000)}s ` +
                `(freshness bound ${Math.round((inventoryStaleAfterMs ?? 0) / 1000)}s). ` +
                "It may be diverging from the live fleet.",
            } satisfies VmInventoryVerdict,
            200
          );
        case "schema-drift":
          return c.json(
            {
              status: "schema-drift",
              message:
                `The fleet inventory did not match the expected shape (${classification.detail}). ` +
                "The read-path and write-path schemas may have drifted.",
            } satisfies VmInventoryVerdict,
            200
          );
        case "unavailable":
          return c.json({ error: "inventory unavailable" }, 500); // never log the raw record
        case "unreadable":
          return c.json({ error: "inventory unreadable" }, 500);
        case "ok":
          try {
            const entries = classification.raw.map(toSanitizedEntry);
            // #3557: the explicit two-source join — the inventory row (fleet
            // membership) + Sub F's per-VM parity status (verdict state), keyed by
            // subdomain. NOT a second inventory source: the status files never add
            // or drop a row. Emitted CONDITIONALLY (the diskThresholdPct pattern),
            // so a VM with no status file carries no `vmParity` key at all. The
            // status files sit beside #3593's ledger, in `dirname(vmParityLedgerPath)`.
            const nowMs = now();
            const summaries = await Promise.all(
              entries.map(entry =>
                readVmParitySummary({
                  stateDir: dirname(vmParityLedgerPath),
                  subdomain: entry.name,
                  readVmParityStatus,
                  nowMs,
                })
              )
            );
            summaries.forEach((summary, i) => {
              if (summary) entries[i].vmParity = summary;
            });
            // OUTPUT allowlist enforcement: a stray secret field would fail
            // `.strict()` here and 500 rather than leak.
            return c.json(VmInventoryResponseSchema.parse(entries));
          } catch {
            return c.json({ error: "inventory serialization failed" }, 500);
          }
      }
    }
  );

  // ── #3593 (Sub G2): fleet parity history ───────────────────────────────────
  // A DISTINCT read-only route (ruling D2(a)) over Sub F's append-only ledger;
  // `vmParity` on the inventory entry is G1's (#3557) and is not touched here.
  // The inventory is consulted ONLY as a membership filter (which subdomains the
  // fleet knows) — no inventory field reaches the response, so `access_token`
  // cannot. Reads two local files (the ledger and the fleet inventory): no ssh /
  // oci / per-VM fetch in the request path.
  app.get(
    "/admin-vms/parity-history",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-parity-history",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return the append-only VM parity history (verdict, drift count, manifest version, checker exit, source per recorded check) for fleet-inventory VMs; ?vm= narrows it to one VM.",
        whenToUse:
          "When the operator wants to see how a cloud VM's parity with RP1 has changed over time.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/admin-vms/parity-history",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!provisioner.enabled) return c.notFound();
      // #4392: every 500 below calls logError exactly once, with non-secret
      // locators only — `ParityHistoryLogMeta` is a closed union, so a ledger or
      // inventory value cannot be passed.
      const fail = (
        error: string,
        message: string,
        meta: ParityHistoryLogMeta
      ) => {
        logError(message, meta);
        return c.json({ error }, 500);
      };

      // Membership filter, classified FIRST: the absent-ledger `[]` below must
      // never mask an inventory server fault (the #2552 silent-blank class). The
      // stale check is deliberately OFF here: `stale` is /inventory's freshness
      // verdict, while a quiet fleet's names are still the fleet — treating it as
      // "no known VMs" would silently blank the history. Server faults
      // (`unavailable` fs error, `unreadable` JSON) are 500s exactly as on
      // /inventory; missing / schema-drifted inventories carry no names, so they
      // fail CLOSED to [] (ruling D2(a)'s plain-array contract).
      const classification = await classifyInventory({
        inventoryPath,
        readInventory,
        statInventory,
        inventoryStaleAfterMs: undefined,
        now,
      });
      if (classification.kind === "unavailable") {
        return fail(
          "inventory unavailable",
          "parity-history: inventory unavailable",
          { path: "inventory", kind: "unavailable", code: classification.code }
        );
      }
      if (classification.kind === "unreadable") {
        return fail(
          "inventory unreadable",
          "parity-history: inventory unreadable",
          { path: "inventory", kind: "unreadable" }
        );
      }

      let text: string;
      try {
        text = await readVmParityLedger(vmParityLedgerPath);
      } catch (err) {
        // No ledger yet = no parity run recorded yet: benign, never a 500.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return c.json([]);
        return fail(
          "vm-parity history unavailable",
          "parity-history: ledger unavailable",
          ledgerReadFailureMeta(err)
        );
      }
      let history: VmParityHistoryEntry[];
      try {
        history = decodeVmParityLedger(text); // never log the raw ledger
      } catch (err) {
        return fail(
          "vm-parity history unreadable",
          "parity-history: ledger decode failed",
          decodeFailureMeta(err)
        );
      }

      const knownSubdomains = new Set<string>(
        classification.kind === "ok"
          ? classification.raw.map(rec => (rec as { name: string }).name)
          : []
      );
      // `?vm=` is only ever compared — never a path, argv, or command operand.
      const vm = c.req.query("vm");
      const entries = history.filter(
        e =>
          knownSubdomains.has(e.subdomain) &&
          (vm === undefined || e.subdomain === vm)
      );
      try {
        // OUTPUT allowlist enforcement, exactly as on /inventory.
        return c.json(VmParityHistoryResponseSchema.parse(entries));
      } catch (err) {
        return fail(
          "vm-parity history serialization failed",
          "parity-history: serialization failed",
          serializeFailureMeta(err)
        );
      }
    }
  );

  // ── R2: job create / list / status ─────────────────────────────────────────
  // R6: the shared rate cap runs before the handler (after the capability guard).
  app.post(
    "/admin-vms/jobs",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-create-job",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Create and start an admin provisioning job (provision, health-check, reconcile) from a validated kind, positionals, and allowlisted flags.",
        whenToUse:
          "When the operator wants to run a cloud-VM provisioning operation.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/admin-vms/jobs",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    jobCreationLimiter,
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const body = await readValidatedBody(c, CreateJobRequestSchema);
      if (!body.ok) return body.res;

      let built: BuiltJob;
      try {
        built = buildJob(
          body.data.kind,
          {
            positionals: body.data.positionals,
            flags: body.data.flags,
          },
          { now: now() }
        );
      } catch (err) {
        // The allowlist rejection (AC-2): 400 with no job record created.
        if (err instanceof JobValidationError) {
          return c.json(
            { error: err.message, code: err.code, kind: err.kind },
            400
          );
        }
        throw err;
      }

      // R3: audit the creation BEFORE the spawn, so the operator's creation record
      // survives a spawn failure. `argv` is secret-free (#2468); fires regardless of
      // started/queued.
      const outcome = await provisioner.runner.runJob(
        built,
        auditCreationHook(c, "create")
      );
      return c.json(
        {
          job: toJobStatus(outcome.record),
          started: outcome.started,
          ...(outcome.started ? {} : { lockReason: outcome.reason }),
        },
        outcome.started ? 201 : 202
      );
    }
  );

  app.get(
    "/admin-vms/jobs",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-list-jobs",
        domain: "harness-admin",
        surface: "rest",
        description:
          "List all admin provisioning jobs with their state and result, finalizing any still-running jobs so the list reflects reality.",
        whenToUse:
          "When the operator wants to review recent provisioning jobs.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/admin-vms/jobs",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const prov = provisioner;
      // Finalize still-running jobs so the list reflects reality — Sub B has no
      // background finalizer, and `finalize` is idempotent (releases the fleet
      // lock for a completed mutating job). Few jobs run at once (mutating jobs
      // serialize on the lock), so this is bounded.
      for (const rec of prov.store.listByState("running")) {
        await prov.runner.finalize(rec.id);
      }
      return c.json(prov.store.list().map(toJobStatus));
    }
  );

  app.get(
    "/admin-vms/jobs/:id",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-job-status",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return one admin provisioning job's current state and result by id, finalizing it if still running.",
        whenToUse:
          "When the operator wants the status of a specific provisioning job.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/admin-vms/jobs/:id",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const prov = provisioner;
      const id = c.req.param("id");
      let rec = prov.store.get(id);
      if (!rec) return c.json({ error: "job not found" }, 404);
      if (rec.state === "running") rec = await prov.runner.finalize(id);
      return c.json(toJobStatus(rec));
    }
  );

  // ── R3: SSE job-log follow ──────────────────────────────────────────────────
  app.get(
    "/admin-vms/jobs/:id/logs",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-job-logs",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Stream a provisioning job's secret-masked log output over Server-Sent Events until the job reaches a terminal state.",
        whenToUse:
          "When the operator wants to follow a running provisioning job's live output.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/admin-vms/jobs/:id/logs",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    c => {
      if (!provisioner.enabled) return c.notFound();
      const prov = provisioner;
      const id = c.req.param("id");
      const rec0 = prov.store.get(id);
      if (!rec0) return c.json({ error: "job not found" }, 404);
      const logPath = rec0.logPath;

      return streamSSE(c, async stream => {
        let aborted = false;
        const onAbort = (): void => {
          aborted = true;
        };
        c.req.raw.signal.addEventListener("abort", onAbort, { once: true });
        stream.onAbort(onAbort);

        let offset = 0;
        let pending = "";

        // R4: the per-job log FILE holds RAW script output (systemd writes the unit's
        // bytes directly; the server never touches them in flight — the at-rest file's
        // protection is its 0600/0700 mode, #2468). This SSE boundary is the one place
        // the server reads those bytes, so EVERY line is masked here before it is
        // streamed to the operator. Values gathered once per connection.
        const maskValues = await collectMaskValues();

        // Emit every COMPLETE (newline-terminated) line appended since last read,
        // holding a trailing partial line back so a line split across two reads is
        // never emitted twice. Reading the whole file + slicing avoids an fs.watch
        // handle (nothing to leak on disconnect).
        const flushAppended = async (): Promise<void> => {
          const full = await readLog(logPath);
          if (full.length <= offset) return;
          pending += full.slice(offset);
          offset = full.length;
          const nl = pending.lastIndexOf("\n");
          if (nl === -1) return;
          const complete = pending.slice(0, nl);
          pending = pending.slice(nl + 1);
          for (const line of complete.split("\n")) {
            await stream.writeSSE({
              event: "log",
              data: maskSecretLine(line, maskValues),
            });
          }
        };

        const flushFinal = async (): Promise<void> => {
          await flushAppended();
          if (pending.length > 0) {
            await stream.writeSSE({
              event: "log",
              data: maskSecretLine(pending, maskValues),
            });
            pending = "";
          }
        };

        while (!aborted) {
          await flushAppended();
          let rec = prov.store.get(id);
          if (!rec) break; // job vanished
          if (rec.state === "running") rec = await prov.runner.finalize(id);
          if (isTerminalState(rec.state)) {
            await flushFinal(); // drain the tail the unit wrote just before exit
            await stream.writeSSE({ event: "state", data: rec.state });
            break;
          }
          await sleep(logPollIntervalMs); // queued or still running — re-poll
        }
      });
    }
  );

  // ── R4: preflight (capability verdict + fleet-lock state) ───────────────────
  app.get(
    "/admin-vms/preflight",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-preflight",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return the live provisioner capability verdict and current fleet-lock state without acquiring the lock.",
        whenToUse:
          "When the operator wants to know why the admin panel is enabled or disabled.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/admin-vms/preflight",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      if (!provisioner.enabled) return c.notFound();
      // LIVE verdict — surfaces WHY the panel is (still) disabled without a
      // restart. Read the lock via the non-acquiring `status()`, NEVER
      // `tryAcquire()` (which would take the real lock).
      const verdict = provisioner.capability();
      const lock = await provisioner.fleetLock.status();
      const body: PreflightResponse = {
        enabled: verdict.enabled,
        reason: verdict.reason,
        fleetLock: { held: lock.held, holder: lock.holder },
      };
      return c.json(body);
    }
  );

  // ── R5: two-step deprovision ────────────────────────────────────────────────
  app.post(
    "/admin-vms/deprovision/dry-run",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-deprovision-dry-run",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Preview a cloud-VM deprovision as a read-only dry run, returning the masked transcript and a single-use confirmation token bound to the exact previewed teardown.",
        whenToUse:
          "When the operator wants to see what a VM teardown would do before applying it.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/admin-vms/deprovision/dry-run",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
        example:
          '{"subdomain":"ms2","email":"ops@example.com","serviceEnd":"2026-10-31"}',
      })
    ),
    jobCreationLimiter,
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const prov = provisioner;
      const body = await readValidatedBody(c, DeprovisionDryRunRequestSchema);
      if (!body.ok) return body.res;
      const { subdomain, email, serviceEnd } = body.data;

      const gatewayHost = await lookupDeprovisionGatewayHost({
        subdomain,
        inventoryPath,
        readInventory,
        defaultGatewayHost,
      });
      const flags: Record<string, string> = {};
      if (email) flags["--email"] = email;
      if (gatewayHost) flags["--gateway-host"] = gatewayHost;
      // #5257 F9: E dates the retention record. It joins the argv the token binds,
      // so the apply replays it with no change to the apply body.
      if (serviceEnd) flags["--service-end"] = serviceEnd;

      // DEFAULT dry-run: no --apply, no --dry-run (so apply replays argv + --apply
      // cleanly). `buildJob` re-validates the subdomain + flags — the security seam —
      // including the service end's calendar check and its 30-day past bound.
      let built: BuiltJob;
      try {
        built = buildJob(
          "deprovision",
          { positionals: [subdomain], flags },
          { now: now() }
        );
      } catch (err) {
        if (err instanceof JobValidationError) {
          return c.json({ error: err.message, code: err.code }, 400);
        }
        throw err;
      }

      // R3: audit the dry-run job creation before the spawn.
      const outcome = await prov.runner.runJob(
        built,
        auditCreationHook(c, "create")
      );
      const finalRec = await driveToTerminal(prov, outcome.record.id);
      // R4: the deprovision script masks its OWN --dry-run output; mask again here at
      // the server read boundary (defense-in-depth) before the transcript crosses to
      // the client — the same redaction the SSE path applies.
      const transcript = maskSecretText(
        await readLog(finalRec.logPath),
        await collectMaskValues()
      );

      const token = genToken();
      confirmTokens.set(token, {
        built,
        subdomain,
        expiresAt: now() + confirmTokenTtlMs,
      });

      return c.json({
        jobId: finalRec.id,
        subdomain,
        state: finalRec.state,
        transcript,
        confirmationToken: token,
        serviceEnd: serviceEnd ?? null,
        deleteEligibleAt: deleteEligibleIso(serviceEnd),
        gatewayHost: gatewayHost ?? null,
      });
    }
  );

  // R6: the shared cap covers apply too — this doubles as the confirmation-token
  // brute-force guard (bounded attempts per operator per minute).
  app.post(
    "/admin-vms/deprovision/apply",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-deprovision-apply",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Execute an irreversible cloud-VM teardown, replaying the exact previewed deprovision plus apply, gated on a matching single-use confirmation token and typed subdomain.",
        whenToUse:
          "When the operator has reviewed a dry run and wants to permanently tear down the VM.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/admin-vms/deprovision/apply",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "operator" },
        example:
          '{"confirmationToken":"the-token-returned-by-dry-run","typedSubdomain":"ms2"}',
      })
    ),
    jobCreationLimiter,
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const body = await readValidatedBody(c, DeprovisionApplyRequestSchema);
      if (!body.ok) return body.res;
      const { confirmationToken, typedSubdomain } = body.data;

      // No `await` between the lookup and the consuming delete below, so the
      // check-then-consume is atomic w.r.t. the event loop: two concurrent applies
      // cannot both pass (delete-before-spawn).
      const entry = confirmTokens.get(confirmationToken);
      if (!entry || entry.expiresAt <= now()) {
        confirmTokens.delete(confirmationToken); // reap an expired entry
        return c.json({ error: "invalid or expired confirmation token" }, 401);
      }
      if (entry.subdomain !== typedSubdomain) {
        // Do NOT consume on a mismatch — let the operator retype the subdomain.
        return c.json({ error: "typed subdomain does not match" }, 400);
      }
      confirmTokens.delete(confirmationToken); // atomic single-use consume

      // Replay EXACTLY what was previewed, plus --apply. A mutating job ⇒ fleet lock.
      const applyBuilt: BuiltJob = {
        kind: "deprovision",
        scriptRelPath: entry.built.scriptRelPath,
        argv: [...entry.built.argv, "--apply"],
        mutating: true,
      };
      // R3: audit the confirmed --apply BEFORE the spawn (via onPersist). This is the
      // security-critical event — an operator authorized an irreversible teardown, and
      // the token is already consumed, so the confirmation must be recorded even if the
      // spawn fails.
      const outcome = await provisioner.runner.runJob(
        applyBuilt,
        auditCreationHook(c, "apply-confirm")
      );
      return c.json(
        {
          job: toJobStatus(outcome.record),
          started: outcome.started,
          ...(outcome.started ? {} : { lockReason: outcome.reason }),
        },
        outcome.started ? 201 : 202
      );
    }
  );

  // ── #2472 (Sub E): dedicated health + reconcile endpoints ───────────────────
  // All three reuse the shared jobCreationLimiter (R6 — the per-minute cap spans
  // EVERY job-creating POST) and auditCreationHook "create" (R3 — audited before
  // the spawn), and route through buildJob (the R1/R13 security seam). health +
  // reconcile-detect are read-only (fleet-lock-exempt, R5); reconcile-repair is
  // mutating (fleet lock, per #2468's computeMutating). The directive's
  // host-scoped/no-lock recommendation for repair is documented-not-adopted:
  // #2468 couples "mutating" with the fleet lock, and over-locking a rare,
  // operator-initiated repair is the safe conservative choice (health/detect
  // still run under a held lock per R5).

  /** Run a built job (audited "create") and shape the 201/202 CreateJobResponse. */
  async function runAndRespond(
    c: Context<WebAppEnv>,
    prov: EnabledProvisioner,
    built: BuiltJob
  ) {
    const outcome = await prov.runner.runJob(
      built,
      auditCreationHook(c, "create")
    );
    return c.json(
      {
        job: toJobStatus(outcome.record),
        started: outcome.started,
        ...(outcome.started ? {} : { lockReason: outcome.reason }),
      },
      outcome.started ? 201 : 202
    );
  }

  // POST /admin-vms/health — fleet-scoped read-only sweep. check-cloud-health.sh
  // has no per-instance filter, so ONE run covers every instance and each
  // HealthCard selects its own instance from the result JSON (expert review R30).
  // buildJob auto-injects --dry-run --json for health-check (isolates the UI run
  // from the unattended timer's alert emails / debounce, R29).
  app.post(
    "/admin-vms/health",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-health",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Run a fleet-wide read-only cloud-VM health sweep against the operator inventory, returning per-instance health as a job result.",
        whenToUse:
          "When the operator wants a current health check across all cloud VMs.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/admin-vms/health",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    jobCreationLimiter,
    async c => {
      if (!provisioner.enabled) return c.notFound();
      let built: BuiltJob;
      try {
        // Pass --config = the SAME inventory file the /inventory endpoint reads
        // (HAPI_VM_INVENTORY_FILE, else INVENTORY_FILE, else the canonical
        // ~/.local/state/hapimatic-provision/cloud-instances.json). Since #3414 the
        // script resolves the same canonical default on its own, but an env override
        // set on this server never reaches the job (systemd-run --user units get no
        // env), so --config still pins the sweep to exactly the file the table
        // shows. (#2472)
        built = buildJob("health-check", {
          flags: { "--config": inventoryPath },
        });
      } catch (err) {
        if (err instanceof JobValidationError) {
          return c.json(
            { error: err.message, code: err.code, kind: err.kind },
            400
          );
        }
        throw err;
      }
      return runAndRespond(c, provisioner, built);
    }
  );

  // POST /admin-vms/reconcile/:name/detect — read-only per-VM drift detection.
  // No --surface ⇒ every surface reconcile-vm.sh covers by default; --json for the
  // structural parse the ReconcilePanel consumes. --inventory threads the operator
  // inventory path (the SAME value health-check threads as --config, #2472), closing
  // the split-checkout divergence for reconcile too (#2566); a no-op on the operator
  // instance where the paths coincide.
  app.post(
    "/admin-vms/reconcile/:name/detect",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-reconcile-detect",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Run read-only drift detection for one named cloud VM across every reconcile surface, returning the structured drift result.",
        whenToUse:
          "When the operator wants to see what has drifted on a specific VM.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/admin-vms/reconcile/:name/detect",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    jobCreationLimiter,
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const name = c.req.param("name");
      let built: BuiltJob;
      try {
        built = buildJob("reconcile-detect", {
          positionals: [name],
          flags: { "--inventory": inventoryPath, "--json": true },
        });
      } catch (err) {
        if (err instanceof JobValidationError) {
          return c.json(
            { error: err.message, code: err.code, kind: err.kind },
            400
          );
        }
        throw err;
      }
      return runAndRespond(c, provisioner, built);
    }
  );

  // POST /admin-vms/reconcile/:name/repair — per-surface mutating repair. The
  // body names EXACTLY ONE surface; buildJob's applyGuards enforces --apply +
  // exactly one --surface AND rejects handoff-secret (detection-only, #2316), so
  // a handoff-secret or blanket repair returns 400 with no spawn. age-recipient
  // naming is satisfied structurally (a single named surface).
  app.post(
    "/admin-vms/reconcile/:name/repair",
    cataloged(
      defineCapability({
        id: "harness-admin.api-admin-vms-reconcile-repair",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Apply a mutating reconcile repair to exactly one named surface of a cloud VM, gated by the provisioner's apply guards.",
        whenToUse:
          "When the operator wants to fix a specific drifted surface on a VM.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/admin-vms/reconcile/:name/repair",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "operator" },
        example: '{"surface":"dns"}',
      })
    ),
    jobCreationLimiter,
    async c => {
      if (!provisioner.enabled) return c.notFound();
      const name = c.req.param("name");
      const body = await readValidatedBody(c, ReconcileRepairRequestSchema);
      if (!body.ok) return body.res;
      let built: BuiltJob;
      try {
        built = buildJob("reconcile-repair", {
          positionals: [name],
          flags: {
            // --inventory threads the operator inventory path like detect (#2566);
            // additive to the repair guards (--apply + exactly one --surface).
            "--inventory": inventoryPath,
            "--surface": body.data.surface,
            "--apply": true,
            "--json": true,
          },
        });
      } catch (err) {
        if (err instanceof JobValidationError) {
          return c.json(
            { error: err.message, code: err.code, kind: err.kind },
            400
          );
        }
        throw err;
      }
      return runAndRespond(c, provisioner, built);
    }
  );

  return app;
}
