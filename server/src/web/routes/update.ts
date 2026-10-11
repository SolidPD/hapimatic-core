// SPDX-License-Identifier: AGPL-3.0-only
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { defineCapability } from "@hapi/protocol";
import { cataloged } from "../../capabilities/cataloged";
import { VERSION } from "../../version.generated";
import type { SyncEngine } from "../../sync/syncEngine";
import {
  clearDeferral,
  isBlockingThinking,
  readDeferral,
  writeDeferral,
} from "../../update/deferredApply";
import {
  isActivePhase,
  isReadyForTarget,
  readJobState,
  writeJobState,
  type UpdateJobState,
} from "../../update/updateJobState";
import { createAuthMiddleware, type WebAppEnv } from "../middleware/auth";
import type { ErrorLogger } from "../../logging/errorLogger";

/**
 * Update status/trigger routes (issue #1006, D999-10 control-plane push;
 * session-aware UX in issue #2589).
 *
 * `GET /update-status` (NO AUTH) reads the LOCAL staged-update marker written by
 * RP1's push-update-to-vms.sh — it makes no GitHub call and needs no PAT. The
 * marker is the single interface (R15): `{version, sha256, sizeBytes, binaryPath,
 * stagedAt}`. A missing/malformed marker means "no update available" (fail-safe).
 * Issue #2589 augments the response with LIVE, per-request fields — `sessionImpact`
 * (active + thinking counts), `machineName`, and `deferred` (the pending "apply
 * when idle" state) — computed OUTSIDE the 5-min marker cache so dialog counts are
 * never minutes stale.
 *
 * `POST /update-trigger` (JWT AUTH) launches scripts/update-hapimatic.sh as a
 * transient systemd --user unit via `systemd-run`, so the updater runs in its own
 * cgroup and survives the server restarting itself (the catch-22). Returns 202.
 * Issue #2589 adds `{ mode: "now" | "when-idle" }`: "when-idle" defers the apply
 * server-side (survives tab close + restart) until no session is thinking.
 *
 * `POST /update-cancel-deferral` (JWT AUTH, #2589) clears a pending deferral.
 *
 * Mounted BEFORE the global /api/* JWT middleware (like health.ts), so auth is
 * applied inline to the mutating routes only — mirrors health.ts:96-98.
 *
 * THREAT MODEL (D5, #2589): `GET /update-status` is deliberately PRE-AUTH (public)
 * like `/version`. The new `sessionImpact`/`machineName` fields therefore ship
 * without a JWT. This is acceptable under the Tailscale threat model — the
 * instance is reachable only over the tailnet, the counts are aggregate (no
 * per-session detail), and the machine name is already broadcast in federation
 * peer announcements. Do NOT move session-detail (ids, titles) onto this endpoint.
 */

/** Aggregate session impact of a restart (issue #2589). */
export interface SessionImpact {
  /** Active sessions on this instance (`getActiveSessions().length`). */
  active: number;
  /** Actively-thinking sessions (`thinking ⇒ active`, so counted over actives). */
  thinking: number;
  /**
   * Sessions currently BLOCKING the deferred-apply gate (issue #3735) — the same
   * `isBlockingThinking` predicate the gate itself uses, over the same active set,
   * so this count is exactly what a pending "when-idle" apply is waiting on. Differs
   * from `thinking` by excluding stuck-but-not-inferring sessions (tui-blocked /
   * rate-limited). The pending dialog surfaces THIS count (not raw `thinking`) so
   * the operator sees precisely what the gate is waiting for.
   */
  blocking: number;
}

/** Pending "apply when idle" state surfaced to the client (issue #2589). */
export interface DeferredState {
  pending: boolean;
  mode: "when-idle";
  requestedAt: string;
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  lastChecked: string;
  error?: string;
  /**
   * Live session impact (issue #2589). OMITTED entirely when the session source
   * is unavailable or errors — the client degrades to the plain dialog (R6).
   */
  sessionImpact?: SessionImpact;
  /** Server-resolved machine/node display name for the honest copy (R5, #2589). */
  machineName?: string;
  /** Pending deferred-apply state, or null when none (issue #2589). */
  deferred?: DeferredState | null;
  /**
   * Durable two-phase-updater lifecycle state, or null when no job record exists
   * (issue #3057). Read fresh per-request (NOT from the 5-min marker cache) so the
   * single-bar UI reflects `staging`/`ready`/`applying`/`succeeded`/`failed`
   * truthfully as the shell transitions it. HTTP 202 is launch acceptance, NOT
   * completion — the client keys the staging spinner, the confirm-dialog (`ready`),
   * and the terminal reload (`succeeded`) off THIS field.
   */
  job?: UpdateJobState | null;
}

interface StagedMarker {
  version: string;
  sha256: string;
  sizeBytes?: number;
  binaryPath: string;
  stagedAt: string;
}

export interface UpdateRoutesOptions {
  jwtSecret?: Uint8Array;
  errorLogger?: ErrorLogger | null;
  /** Instance data dir (HAPI_HOME). Default: $HAPI_HOME or ~/.hapimatic-private. */
  dataDir?: string;
  /** Server port for the updater's --port flag. Default: configuration.webappPort. */
  port?: number;
  /** Installed binary path for the updater's --binary flag. */
  binaryPath?: string;
  /** Service unit names for the updater's --unit / --daemon-unit flags. */
  serviceUnit?: string;
  daemonUnit?: string;
  /** Path to update-hapimatic.sh. Default: $HAPI_UPDATE_SCRIPT_PATH or <dataDir>/update-hapimatic.sh. */
  scriptPath?: string;
  /** Injectable spawn (for tests). Default: node:child_process spawn. */
  spawn?: typeof nodeSpawn;
  /** Cache TTL in ms (default 5 min). */
  cacheTtlMs?: number;
  /**
   * Session source for `sessionImpact` (issue #2589). Late-bound getter, like the
   * sibling routes. When absent/null the `sessionImpact` field is omitted (R6).
   */
  getSyncEngine?: () => SyncEngine | null;
  /**
   * Server-resolved machine/node display name for the honest copy (R5, #2589).
   * Typically the federation `nodeLabel`; falls back to `os.hostname()`.
   */
  machineName?: string;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Compare two versions using the repo grammar `^(\d+)\.(\d+)\.(\d+)(-[A-Z]{1,2})?$`.
 * A suffixed version is a PRERELEASE of the unsuffixed one (X.Y.Z-AA < X.Y.Z);
 * two suffixes compare lexicographically. Returns -1 | 0 | 1 (a vs b).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const strip = (v: string): string => v.replace(/^v/, "");
  const parse = (v: string): { core: number[]; suffix: string } => {
    const s = strip(v);
    const dash = s.indexOf("-");
    const core = (dash === -1 ? s : s.slice(0, dash))
      .split(".")
      .map(n => Number.parseInt(n, 10) || 0);
    const suffix = dash === -1 ? "" : s.slice(dash + 1);
    return { core, suffix };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const ai = pa.core[i] ?? 0;
    const bi = pb.core[i] ?? 0;
    if (ai > bi) return 1;
    if (ai < bi) return -1;
  }
  // Cores equal — no-suffix outranks suffix (suffix is a prerelease).
  if (pa.suffix === "" && pb.suffix === "") return 0;
  if (pa.suffix === "" && pb.suffix !== "") return 1;
  if (pa.suffix !== "" && pb.suffix === "") return -1;
  if (pa.suffix > pb.suffix) return 1;
  if (pa.suffix < pb.suffix) return -1;
  return 0;
}

function resolveDataDir(opts: UpdateRoutesOptions): string {
  return (
    opts.dataDir ??
    process.env.HAPI_HOME ??
    path.join(homedir(), ".hapimatic-private")
  );
}

/** Read the local staged-update marker. Returns null on missing/malformed (fail-safe). */
function readMarker(dataDir: string): StagedMarker | null {
  try {
    const raw = readFileSync(
      path.join(dataDir, "staged-update", "marker.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Partial<StagedMarker>;
    if (
      typeof parsed.version !== "string" ||
      typeof parsed.sha256 !== "string" ||
      typeof parsed.binaryPath !== "string"
    ) {
      return null;
    }
    return parsed as StagedMarker;
  } catch {
    return null;
  }
}

/**
 * Compute the marker-derived status by reading the LOCAL marker — no network, no
 * PAT. Exported so the deferred-apply watcher (issue #2589) can read live
 * availability without going through the route's 5-min cache.
 */
export function computeStatus(dataDir: string): UpdateStatus {
  const now = new Date().toISOString();
  const marker = readMarker(dataDir);
  if (!marker) {
    return {
      currentVersion: VERSION,
      latestVersion: VERSION,
      updateAvailable: false,
      lastChecked: now,
    };
  }
  const updateAvailable = compareVersions(marker.version, VERSION) > 0;
  return {
    currentVersion: VERSION,
    latestVersion: marker.version,
    updateAvailable,
    lastChecked: now,
  };
}

/**
 * Fully-resolved launcher config — the inputs to `launchUpdater`. Both the
 * "Update now" route path and the deferred-apply watcher (issue #2589) run the
 * SAME apply through this, so the deferred fire is byte-identical to "Update now".
 */
export interface LauncherConfig {
  port: number;
  binaryPath: string;
  serviceUnit: string;
  daemonUnit: string;
  scriptPath: string;
  dataDir: string;
  spawn: typeof nodeSpawn;
  errorLogger?: ErrorLogger | null;
}

/** Resolve the launcher config from route options + env/defaults (issue #2589). */
export function resolveLauncherConfig(
  opts: UpdateRoutesOptions
): LauncherConfig {
  const dataDir = resolveDataDir(opts);
  const envPort = Number(process.env.WEBAPP_PORT);
  const port =
    opts.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 3008);
  return {
    port,
    binaryPath:
      opts.binaryPath ?? path.join(homedir(), ".local/bin/hapimatic-private"),
    serviceUnit: opts.serviceUnit ?? "hapimatic-private",
    daemonUnit: opts.daemonUnit ?? "hapimatic-private-daemon",
    scriptPath:
      opts.scriptPath ??
      process.env.HAPI_UPDATE_SCRIPT_PATH ??
      path.join(dataDir, "update-hapimatic.sh"),
    dataDir,
    spawn: opts.spawn ?? nodeSpawn,
    errorLogger: opts.errorLogger,
  };
}

/**
 * Which phase of the split updater to run (issue #3057). `stage` obtains + verifies
 * the staged binary and writes `ready` (no swap); `apply` re-verifies the staged
 * binary and does the destructive swap/restart/health-check; `combined` is the
 * legacy single-shot fetch-and-apply retained for manual callers.
 */
export type UpdaterAction = "stage" | "apply" | "combined";

/**
 * Launch update-hapimatic.sh as a transient systemd --user unit (issue #1006;
 * extracted to a shared callable in issue #2589 so the immediate and deferred
 * paths use the SAME mechanism; generalized over stage/apply/combined in #3057).
 *
 * systemd-run registers a transient unit and exits immediately; the updater runs
 * OUTSIDE the server's cgroup, so it survives the server restarting itself. Do
 * NOT use detached/setsid — the server unit's default KillMode=control-group
 * would kill an in-cgroup child mid-swap.
 *
 * For `stage`/`apply` the transient unit's exit is NOT completion (the shell
 * fetches, verifies, swaps, restarts, and health-checks after `systemd-run`
 * returns). To keep the UI truthful across that gap, this writes the INITIAL
 * durable phase (`staging`/`applying`) synchronously BEFORE spawning, so a GET
 * /update-status the instant a POST returns already reflects it; the shell then
 * owns the subsequent `ready`/`succeeded`/`failed` transitions. A launch failure
 * reverts that optimistic write to `failed` (no shell process will). The legacy
 * `combined` action writes NO job state (manual callers keep pre-#3057 behavior).
 */
export async function launchUpdater(
  cfg: LauncherConfig,
  action: UpdaterAction = "combined",
  jobId?: string
): Promise<{ ok: boolean; exitCode: number; unit: string }> {
  const unit = jobId ?? `hapi-update-${Math.random().toString(36).slice(2, 8)}`;

  if (action === "stage" || action === "apply") {
    try {
      writeJobState(cfg.dataDir, {
        schemaVersion: 1,
        phase: action === "stage" ? "staging" : "applying",
        targetVersion: computeStatus(cfg.dataDir).latestVersion,
        jobId: unit,
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      cfg.errorLogger?.error?.(`failed to write initial ${action} job state`, {
        category: "update",
        context: { error: String(err) },
      });
    }
  }

  const modeFlag =
    action === "stage"
      ? ["--stage-only"]
      : action === "apply"
        ? ["--apply-only"]
        : [];

  const args = [
    "--user",
    "--collect",
    `--unit=${unit}`,
    "--setenv=HAPI_UPDATE_TRIGGERED_BY=api",
    "bash",
    cfg.scriptPath,
    ...modeFlag,
    "--job-id",
    unit,
    "--port",
    String(cfg.port),
    "--binary",
    cfg.binaryPath,
    "--unit",
    cfg.serviceUnit,
    "--daemon-unit",
    cfg.daemonUnit,
    "--data-dir",
    cfg.dataDir,
  ];

  const exitCode = await new Promise<number>(resolve => {
    try {
      const child = cfg.spawn("systemd-run", args, { stdio: "ignore" });
      child.on("error", () => resolve(-1));
      child.on("exit", code => resolve(code ?? -1));
    } catch {
      resolve(-1);
    }
  });

  if (exitCode !== 0) {
    cfg.errorLogger?.error?.(
      `systemd-run failed to launch updater (exit ${exitCode})`,
      { category: "update" }
    );
    // A failed launch leaves no shell process to write a terminal phase — revert
    // the optimistic staging/applying write to `failed` so the UI does not hang
    // on a phantom in-progress phase (#3057 R7).
    if (action === "stage" || action === "apply") {
      try {
        writeJobState(cfg.dataDir, {
          schemaVersion: 1,
          phase: "failed",
          targetVersion: computeStatus(cfg.dataDir).latestVersion,
          jobId: unit,
          updatedAt: new Date().toISOString(),
          errorCode: "launch_failed",
        });
      } catch {
        // best-effort: the 5xx response already tells the client the launch failed
      }
    }
  }
  return { ok: exitCode === 0, exitCode, unit };
}

export function createUpdateRoutes(
  opts: UpdateRoutesOptions = {}
): Hono<WebAppEnv> {
  const app = new Hono<WebAppEnv>();
  const launcherCfg = resolveLauncherConfig(opts);
  const dataDir = launcherCfg.dataDir;
  const ttlMs = opts.cacheTtlMs ?? DEFAULT_TTL_MS;
  // Resolved once — nodeLabel/hostname are stable for the process lifetime.
  // `|| hostname()` guards an empty/whitespace label (federation/webClient.ts:100
  // precedent); the badge does the final generic "this instance" fallback.
  const machineName = opts.machineName?.trim() || hostname() || undefined;

  // Per-instance MARKER cache (closure, not module-level, so tests get fresh
  // state). Only the marker-derived fields are cached — sessionImpact/deferred/
  // machineName are computed per-request (finding 2589-4: caching the whole
  // object made dialog counts minutes stale).
  let cache: UpdateStatus | null = null;
  let cachedAt = 0;

  const getMarkerStatus = (forceRefresh: boolean): UpdateStatus => {
    const fresh = cache !== null && Date.now() - cachedAt < ttlMs;
    if (!forceRefresh && fresh && cache) {
      return cache;
    }
    cache = computeStatus(dataDir);
    cachedAt = Date.now();
    return cache;
  };

  /** Live per-request session impact. Omitted on any error (R6 degrade-safe). */
  const computeSessionImpact = (): SessionImpact | undefined => {
    const engine = opts.getSyncEngine?.();
    if (!engine) return undefined;
    try {
      const active = engine.getActiveSessions();
      // thinking ⇒ active, so counting thinking over the active set equals
      // counting it over the full cache — and avoids the getSessions() history
      // inflation that #1477 fixed for the active count.
      return {
        active: active.length,
        thinking: active.filter(s => s.thinking).length,
        // #3735: the gate's true blocking count — same predicate + same source as
        // the DeferredApplyWatcher, so the pending dialog shows exactly what the
        // apply is waiting on (never a raw `thinking` count that includes stuck flags).
        blocking: active.filter(isBlockingThinking).length,
      };
    } catch {
      return undefined;
    }
  };

  /** Live per-request pending-deferral state (null when none). */
  const computeDeferred = (): DeferredState | null => {
    const rec = readDeferral(dataDir);
    if (!rec) return null;
    return { pending: true, mode: rec.mode, requestedAt: rec.requestedAt };
  };

  // GET /update-status — public, mirrors version.ts. Reads the local marker (cached)
  // + live session impact / deferred state / machine name (per-request).
  app.get(
    "/update-status",
    cataloged(
      defineCapability({
        id: "harness-admin.update-status",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Return the current harness self-update status (public, like /version).",
        whenToUse:
          "When a client polls whether a harness update is available or staged.",
        invocation: {
          kind: "rest",
          method: "GET",
          path: "/api/update-status",
        },
        auth: "none",
        riskTier: "readonly",
        availability: { scope: "user" },
      })
    ),
    c => {
      const forceRefresh = c.req.query("refresh") === "true";
      const base = getMarkerStatus(forceRefresh);
      const sessionImpact = computeSessionImpact();
      const body: UpdateStatus = {
        ...base,
        machineName,
        deferred: computeDeferred(),
        // #3057: read the durable lifecycle state fresh per-request (like
        // sessionImpact/deferred) — the phase changes far faster than the 5-min
        // marker cache. null when no stage/apply has run.
        job: readJobState(dataDir),
      };
      // OMIT sessionImpact entirely (not `undefined`) when unavailable — the client
      // keys its fallback off the field's absence.
      if (sessionImpact) body.sessionImpact = sessionImpact;
      return c.json(body);
    }
  );

  // JWT auth applied inline to the mutating routes only (mirrors health.ts:98).
  if (opts.jwtSecret) {
    const authMiddleware = createAuthMiddleware(
      opts.jwtSecret,
      opts.errorLogger
    );
    app.use("/update-stage", authMiddleware);
    app.use("/update-trigger", authMiddleware);
    app.use("/update-cancel-deferral", authMiddleware);
  }

  // POST /update-stage — JWT-required (#3057 R2). Idempotently launches the
  // non-destructive stage/download (`--stage-only`): fetch + verify sha256/size/
  // signature, then write job.json phase=ready. Returns 202 on launch; the UI
  // stays in `staging` (spinner on the bar) and does NOT open the confirm dialog
  // until a subsequent GET /update-status reports `job.phase === "ready"` — a 202
  // is launch acceptance, NOT staging completion (expert-review S-1).
  app.post(
    "/update-stage",
    cataloged(
      defineCapability({
        id: "harness-admin.update-stage",
        domain: "harness-admin",
        surface: "rest",
        description: "Stage a harness self-update for later application.",
        whenToUse:
          "When the operator prepares a harness update without applying it.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/update-stage",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    async c => {
      const status = getMarkerStatus(true);
      if (!status.updateAvailable) {
        return c.json({ error: "no_update_available" }, 409);
      }

      const job = readJobState(dataDir);
      // Idempotent: already staged+ready for this exact target → report ready,
      // do NOT relaunch a second stage (same-target retries are no-ops, R6).
      if (isReadyForTarget(job, status.latestVersion)) {
        return c.json({
          accepted: true,
          phase: "ready",
          jobId: job?.jobId ?? null,
        });
      }
      // A stage/apply is already in flight for this data dir → 409 with the phase.
      if (job && isActivePhase(job.phase)) {
        return c.json({ error: "update_busy", phase: job.phase }, 409);
      }

      const { ok, exitCode, unit } = await launchUpdater(launcherCfg, "stage");
      if (!ok) {
        return c.json({ error: "launch_failed", exitCode }, 500);
      }
      return c.json({ accepted: true, phase: "staging", jobId: unit }, 202);
    }
  );

  // POST /update-trigger — JWT-required. Accepts { mode: "now" | "when-idle" }.
  app.post(
    "/update-trigger",
    cataloged(
      defineCapability({
        id: "harness-admin.update-trigger",
        domain: "harness-admin",
        surface: "rest",
        description:
          "Trigger the harness self-update now via a transient systemd-run unit (restarts the service).",
        whenToUse: "When the operator applies a staged harness update.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/update-trigger",
        },
        auth: "jwt",
        riskTier: "destructive",
        availability: { scope: "operator" },
        probe: "skip",
      })
    ),
    async c => {
      const parsed = (await c.req.json().catch(() => ({}))) as {
        mode?: unknown;
      };
      const mode = parsed?.mode === "when-idle" ? "when-idle" : "now";

      // Re-check availability server-side; refuse if nothing to apply.
      const status = getMarkerStatus(true);
      if (!status.updateAvailable) {
        return c.json({ error: "no_update_available" }, 409);
      }

      // #3057 R3/R4 (expert-review S-1): apply ONLY after the update has been staged
      // and integrity/signature-verified (job.phase === "ready" for this target).
      // The client reaches here only after it has polled `ready` and shown the
      // restart-confirmation dialog. Refuse otherwise so a 202 can never launch a
      // swap on unverified bytes: 409 `update_busy` while a stage/apply is active,
      // else 409 `not_staged`.
      const job = readJobState(dataDir);
      if (!isReadyForTarget(job, status.latestVersion)) {
        if (job && isActivePhase(job.phase)) {
          return c.json({ error: "update_busy", phase: job.phase }, 409);
        }
        return c.json(
          { error: "not_staged", phase: job?.phase ?? "available" },
          409
        );
      }

      if (mode === "when-idle") {
        // Defer server-side — survives tab close AND server restart. No launch now;
        // the DeferredApplyWatcher fires the identical apply-only once no session
        // thinks. The deferral is recorded only for an already-ready staged update.
        writeDeferral(dataDir, {
          mode: "when-idle",
          requestedAt: new Date().toISOString(),
          requestedBy: c.get("namespace"),
        });
        return c.json({ accepted: true, deferred: true }, 202);
      }

      // mode === "now": an immediate apply supersedes any pending deferral
      // (finding 2589-3 — otherwise a stale deferral would fire a second apply).
      clearDeferral(dataDir);

      const { ok, exitCode, unit } = await launchUpdater(launcherCfg, "apply");
      if (!ok) {
        return c.json({ error: "launch_failed", exitCode }, 500);
      }
      return c.json({ accepted: true, jobId: unit }, 202);
    }
  );

  // POST /update-cancel-deferral — JWT-required. Clears a pending deferral so the
  // badge returns to plain "update available" (issue #2589, R3 cancellable).
  app.post(
    "/update-cancel-deferral",
    cataloged(
      defineCapability({
        id: "harness-admin.update-cancel-deferral",
        domain: "harness-admin",
        surface: "rest",
        description: "Cancel a deferred harness self-update.",
        whenToUse: "When the operator un-defers a pending update.",
        invocation: {
          kind: "rest",
          method: "POST",
          path: "/api/update-cancel-deferral",
        },
        auth: "jwt",
        riskTier: "mutating",
        availability: { scope: "operator" },
      })
    ),
    c => {
      clearDeferral(dataDir);
      return c.json({ cancelled: true });
    }
  );

  return app;
}
