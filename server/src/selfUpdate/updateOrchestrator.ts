// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import type { HarnessRegistry, InstallFlavor } from "@hapi/protocol";
import type { SyncEngine } from "../sync/syncEngine";
import type { Store } from "../store";
import type { AuditOutcome } from "../store/auditStore";
import {
  buildExecEnv,
  detectInstallFlavor,
  resolveHarnessBinary,
} from "./binaryResolver";

/**
 * Self-update orchestrator (issue #1774, Sub E of epic #1769, Tasks 3/4/5).
 *
 * The SERVER process (NOT a Claude session — inode semantics protect every
 * in-flight `claude`, including the admin's driving session) runs the harness's
 * code-defined update/rollback command via argv-form `execFile`. Pure
 * orchestration over injected deps (no globals) — the sibling `impactOrchestrator`
 * shape.
 *
 * Sequence (runUpdate): acquire in-flight lock → validate (descriptor, version
 * allowlist) → resolve binary + install flavor + select the per-flavor template
 * → capture prior version (R2, the escape hatch, BEFORE exec) → [pause spawning]
 * → execFile → detectNow (R4) → archive the #1772 companion (R7) → audit + resume
 * + release in `finally` (R6/R9). The command NEVER comes from the request — it
 * is resolved from the code-defined registry (R11).
 */

/** The result of an `execFile` run. `code === 0` is success; a positive code is
 *  a non-zero exit; `null` is a spawn failure (ENOENT) or a timeout kill. */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Injectable `execFile` — resolves (never rejects) so the orchestrator can
 *  audit a failure rather than unwind. */
export type ExecFileFn = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number; env: NodeJS.ProcessEnv }
) => Promise<ExecResult>;

/** Error codes the route maps to HTTP status. */
export type UpdateErrorCode =
  | "update_in_flight" // 409 — a concurrent update/rollback holds the lock
  | "unknown_harness" // 404 — harnessId not in the registry
  | "version_mismatch" // 409 — requested version != detected latest (anti-downgrade)
  | "no_prior_version" // 409 — rollback with no captured prior
  | "binary_not_found" // 500 — the harness binary could not be resolved (OR-1)
  | "invalid_version" // 400 — version failed the injection-safe allowlist
  | "exec_failed"; // 500 — the install/rollback command exited non-zero

/** The orchestrator's discriminated result (the route maps it to HTTP; the wire
 *  response is snake_case and NEVER echoes the command — R11). */
export type UpdateResult =
  | { ok: true; newVersion: string | null }
  | { ok: false; code: UpdateErrorCode; detail?: string };

/** Regex allowlist for a substitutable version token. Rejects any shell
 *  metacharacter (`;`, `$()`, backtick, space, `/`, `~`, `&`, `|`) — the argv
 *  array + shell-less execFile is the structural defense; this is the belt. */
const VERSION_RE = /^(stable|latest|[0-9]+\.[0-9]+\.[0-9]+(-[\w.]+)?)$/;

/** Default update timeout — a native `claude install` can be slow (download +
 *  unpack). Overridable via env for tuning without a redeploy. */
const DEFAULT_UPDATE_TIMEOUT_MS = process.env.HAPI_HARNESS_UPDATE_TIMEOUT_MS
  ? parseInt(process.env.HAPI_HARNESS_UPDATE_TIMEOUT_MS, 10)
  : 300_000;

/** Chars of stderr to retain in the audit `detail` / diagnostic. */
const STDERR_TAIL_LEN = 500;

/**
 * Task 4 — build an injection-safe argv from a command template. PURE (no
 * filesystem): validates every substitutable version against `VERSION_RE`,
 * substitutes `{version}` / `{prior_version}`, then splits on whitespace into
 * `[binToken, ...args]`. Throws `InvalidVersionError` on a bad version and a
 * plain Error on an unsubstituted placeholder or empty template.
 */
export class InvalidVersionError extends Error {
  constructor(value: string) {
    super(`invalid version token: ${JSON.stringify(value)}`);
    this.name = "InvalidVersionError";
  }
}

export function buildArgv(
  template: string,
  vars: { version?: string; priorVersion?: string }
): { binToken: string; args: string[] } {
  for (const v of [vars.version, vars.priorVersion]) {
    if (v !== undefined && !VERSION_RE.test(v)) {
      throw new InvalidVersionError(v);
    }
  }
  let substituted = template;
  if (vars.version !== undefined) {
    substituted = substituted.split("{version}").join(vars.version);
  }
  if (vars.priorVersion !== undefined) {
    substituted = substituted.split("{prior_version}").join(vars.priorVersion);
  }
  if (/\{[a-z_]+\}/.test(substituted)) {
    throw new Error(`unsubstituted placeholder in template: ${substituted}`);
  }
  const tokens = substituted.trim().split(/\s+/).filter(Boolean);
  const [binToken, ...args] = tokens;
  if (!binToken) throw new Error("empty command template");
  return { binToken, args };
}

/** The default real `execFile` — resolves with the captured output + exit code,
 *  NEVER rejects (a non-zero exit or a spawn failure becomes a result the
 *  orchestrator audits). */
const defaultExecFile: ExecFileFn = (bin, args, opts) =>
  new Promise<ExecResult>(resolve => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs,
        encoding: "utf-8",
        env: opts.env,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
          return;
        }
        const errAny = error as NodeJS.ErrnoException & {
          code?: number | string;
        };
        // A numeric `code` is the process exit code; a string code (ENOENT,
        // etc.) or a signal kill (timeout) is a spawn/kill failure → null.
        const numericCode =
          typeof errAny.code === "number" ? errAny.code : null;
        const stderrCombined =
          (stderr && stderr.length > 0 ? stderr : "") ||
          errAny.message ||
          String(error);
        resolve({
          stdout: stdout ?? "",
          stderr: stderrCombined,
          code: numericCode,
        });
      }
    );
  });

/** The store surface the orchestrator needs (narrow for testability). */
type OrchestratorStore = Pick<
  Store,
  "harness" | "audit" | "updateStatus" | "impactAnalysis"
>;

export interface UpdateOrchestratorDeps {
  engine: Pick<SyncEngine, "getSession" | "archiveSession">;
  store: OrchestratorStore;
  /** The code-defined registry — the command source of truth (R11). */
  registry: HarnessRegistry;
  /** `federationConfig?.nodeId ?? "standalone"` — the SAME value #1770's poll +
   *  the detection state stamp. */
  nodeId: string;
  /** Re-run detection after a successful apply (R4). Injected from the poll
   *  service's `detectNow`. */
  detectNow: (harnessId: string) => Promise<void>;
  /** Injectable execFile (default the real one). */
  execFileFn?: ExecFileFn;
  /** Injectable binary resolver (default `resolveHarnessBinary`). */
  resolveBinary?: (name: string) => string | null;
  /** Injectable flavor detector (default `detectInstallFlavor`). */
  detectFlavor?: (resolvedPath: string) => InstallFlavor;
  /** Injectable exec-env builder (default `buildExecEnv`). */
  buildEnv?: () => NodeJS.ProcessEnv;
  /** Injectable clock (default `() => Date.now()`). */
  now?: () => number;
  /** Update/rollback timeout (ms). Default 5 min. */
  timeoutMs?: number;
  /** Optional spawn-quiesce (Task 10). Default no-ops — the flow is correct
   *  without them; they only narrow the symlink-flip spawn race (R9/KD-2). */
  pauseSpawning?: () => Promise<void>;
  resumeSpawning?: () => Promise<void>;
}

function firstToken(cmd: string): string {
  return cmd.trim().split(/\s+/)[0] ?? "";
}

function tail(s: string): string {
  return s.length > STDERR_TAIL_LEN ? s.slice(-STDERR_TAIL_LEN) : s;
}

function appendDetail(base: string | null, extra: string): string {
  return base ? `${base}; ${extra}` : extra;
}

export class UpdateOrchestrator {
  private readonly engine: UpdateOrchestratorDeps["engine"];
  private readonly store: OrchestratorStore;
  private readonly registry: HarnessRegistry;
  private readonly nodeId: string;
  private readonly detectNowFn: (harnessId: string) => Promise<void>;
  private readonly execFileFn: ExecFileFn;
  private readonly resolveBinary: (name: string) => string | null;
  private readonly detectFlavor: (resolvedPath: string) => InstallFlavor;
  private readonly buildEnv: () => NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly pauseSpawning?: () => Promise<void>;
  private readonly resumeSpawning?: () => Promise<void>;

  constructor(deps: UpdateOrchestratorDeps) {
    this.engine = deps.engine;
    this.store = deps.store;
    this.registry = deps.registry;
    this.nodeId = deps.nodeId;
    this.detectNowFn = deps.detectNow;
    this.execFileFn = deps.execFileFn ?? defaultExecFile;
    this.resolveBinary = deps.resolveBinary ?? resolveHarnessBinary;
    this.detectFlavor = deps.detectFlavor ?? (p => detectInstallFlavor(p));
    this.buildEnv = deps.buildEnv ?? buildExecEnv;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS;
    this.pauseSpawning = deps.pauseSpawning;
    this.resumeSpawning = deps.resumeSpawning;
  }

  /** Apply an update to `targetVersion` (which MUST equal the detected latest). */
  async runUpdate(params: {
    nodeId: string;
    harnessId: string;
    targetVersion: string;
    actor: string | null;
  }): Promise<UpdateResult> {
    return this.run({ ...params, action: "update" });
  }

  /** Roll back to the captured `prior_version` (never a client-supplied version). */
  async runRollback(params: {
    nodeId: string;
    harnessId: string;
    actor: string | null;
  }): Promise<UpdateResult> {
    return this.run({ ...params, action: "rollback", targetVersion: null });
  }

  /**
   * The shared update/rollback body. `action` selects the descriptor template
   * family and the audit `action`; for a rollback `targetVersion` is resolved
   * from the captured `prior_version` (never the request).
   */
  private async run(params: {
    nodeId: string;
    harnessId: string;
    actor: string | null;
    action: "update" | "rollback";
    targetVersion: string | null;
  }): Promise<UpdateResult> {
    const { nodeId, harnessId, actor, action } = params;

    // 1. Acquire the in-flight lock (the 409 producer). A held lock means a
    //    concurrent update/rollback is running — refuse before any state change.
    if (!this.store.updateStatus.tryAcquire(nodeId, harnessId, this.now())) {
      return { ok: false, code: "update_in_flight" };
    }

    let installedBefore: string | null = null;
    let toVersion: string | null = params.targetVersion;
    let outcome: AuditOutcome = "failure";
    let detail: string | null = null;
    let newVersion: string | null = null;
    let errorCode: UpdateErrorCode | undefined;
    let attempted = false; // audit iff the privileged exec was attempted
    let paused = false;

    try {
      // 2. Descriptor from the REGISTRY (never the request — R11).
      const descriptor = this.registry.find(d => d.id === harnessId);
      if (!descriptor) {
        errorCode = "unknown_harness";
        detail = `unknown harness: ${harnessId}`;
        return { ok: false, code: errorCode, detail };
      }

      // 3. Read current state + resolve the target version for this action.
      const state = this.store.harness.getDetectionState(nodeId, harnessId);
      installedBefore = state?.installed_version ?? null;

      if (action === "update") {
        // Version allowlist (anti-downgrade / poisoned-registry defense): the
        // requested target MUST equal the detection state's latest_version.
        if (!state || state.latest_version !== params.targetVersion) {
          errorCode = "version_mismatch";
          detail = `requested ${params.targetVersion ?? "null"} != detected latest ${
            state?.latest_version ?? "unknown"
          }`;
          return { ok: false, code: errorCode, detail };
        }
        toVersion = params.targetVersion;
      } else {
        // Rollback target is EXCLUSIVELY the captured prior_version.
        const prior = state?.prior_version ?? null;
        if (!prior) {
          errorCode = "no_prior_version";
          detail = "no rollback point captured";
          return { ok: false, code: errorCode, detail };
        }
        toVersion = prior;
      }

      // 4. Resolve the harness binary + install flavor + the per-flavor template.
      const binaryName = firstToken(descriptor.detect.cmd);
      const harnessBinary = this.resolveBinary(binaryName);
      if (!harnessBinary) {
        errorCode = "binary_not_found";
        detail = `cannot resolve harness binary '${binaryName}' (OR-1)`;
        return { ok: false, code: errorCode, detail };
      }
      const flavor = this.detectFlavor(harnessBinary);
      const template = descriptor.install_flavors[flavor][action].cmd;

      let argv: { binToken: string; args: string[] };
      try {
        argv = buildArgv(
          template,
          action === "update"
            ? { version: toVersion ?? undefined }
            : { priorVersion: toVersion ?? undefined }
        );
      } catch (err) {
        errorCode =
          err instanceof InvalidVersionError
            ? "invalid_version"
            : "exec_failed";
        detail = err instanceof Error ? err.message : String(err);
        return { ok: false, code: errorCode, detail };
      }

      // The exec binary is the TEMPLATE's bin token (native → `claude`, npm →
      // `npm`), resolved independently of the flavor-detection binary.
      const execBin = this.resolveBinary(argv.binToken);
      if (!execBin) {
        errorCode = "binary_not_found";
        detail = `cannot resolve exec binary '${argv.binToken}' (OR-1)`;
        return { ok: false, code: errorCode, detail };
      }

      // 5. Capture the prior version BEFORE the exec (R2 — the escape hatch).
      //    An update captures the current installed; a rollback does NOT
      //    re-capture (it is already restoring the captured slot).
      if (action === "update") {
        this.store.harness.setPriorVersion(nodeId, harnessId, installedBefore);
      }

      // 6. Optional spawn-quiesce during the symlink flip (best-effort — a pause
      //    failure must not abort the update; the flow is correct without it).
      if (this.pauseSpawning) {
        try {
          await this.pauseSpawning();
          paused = true;
        } catch (err) {
          detail = appendDetail(
            detail,
            `pauseSpawning failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // 7. Execute the privileged command (argv-form, no shell — R3).
      attempted = true;
      const result = await this.execFileFn(execBin, argv.args, {
        timeoutMs: this.timeoutMs,
        env: this.buildEnv(),
      });
      if (result.code !== 0) {
        errorCode = "exec_failed";
        detail = appendDetail(
          detail,
          `${flavor} '${argv.binToken}' exited ${result.code ?? "null"}: ${tail(
            result.stderr
          )}`
        );
        return { ok: false, code: errorCode, detail };
      }

      // 8. Success. Re-run detection (R4). A detectNow throw AFTER a successful
      //    install does NOT flip the outcome — it is recorded in the audit
      //    detail (the install already landed).
      outcome = "success";
      try {
        await this.detectNowFn(harnessId);
      } catch (err) {
        detail = appendDetail(
          detail,
          `detectNow failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      newVersion =
        this.store.harness.getDetectionState(nodeId, harnessId)
          ?.installed_version ?? null;

      // 9. (update only) Archive the #1772 companion for the just-updated range
      //    (R7). A throw here is likewise recorded, not fatal.
      if (action === "update") {
        try {
          await this.archiveCompanion(
            nodeId,
            harnessId,
            installedBefore,
            toVersion
          );
        } catch (err) {
          detail = appendDetail(
            detail,
            `archiveCompanion failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      return { ok: true, newVersion };
    } finally {
      // Non-droppable audit for EVERY executed path (R6). Validation rejections
      // (steps 2-5) never set `attempted`, so a rejected request writes no audit
      // row — only an executed (or exec-attempted) action is recorded.
      if (attempted) {
        this.store.audit.append({
          timestamp: this.now(),
          actor,
          node_id: nodeId,
          harness_id: harnessId,
          action,
          from_version: installedBefore,
          to_version: toVersion,
          outcome,
          detail,
        });
      }
      // Always un-pause (even on a throw), then release the lock.
      if (paused && this.resumeSpawning) {
        try {
          await this.resumeSpawning();
        } catch {
          // best-effort — a failed resume must not throw out of finally.
        }
      }
      this.store.updateStatus.release(nodeId, harnessId);
    }
  }

  /**
   * Task 5 — archive the #1772 companion for `(nodeId, harnessId, from→to)` if
   * one exists and is still active. Reuses the EXISTING engine method — E writes
   * no archive/reconnect code. `reapRemoteWindow` reaps the launcher's window B
   * (terminal archive); `preserveForReconnect` tags window A `@hapi_archive` so
   * the daemon's orphan reaper KEEPS it reconnectable (R7/R8) — the #2683
   * archive-for-reconnect semantics the manual archive route uses.
   */
  private async archiveCompanion(
    nodeId: string,
    harnessId: string,
    from: string | null,
    to: string | null
  ): Promise<void> {
    if (!to) return;
    const row = this.store.impactAnalysis.getByRange(
      nodeId,
      harnessId,
      from ?? "",
      to
    );
    // Raw sqlite rows keep snake_case columns — reading a camelCase
    // `peerSessionId` would be undefined and silently skip the archive (R7).
    const sid = row?.peer_session_id;
    if (!sid) return; // no companion for this range — nothing to archive.
    if (!this.engine.getSession(sid)?.active) return; // already gone — skip.
    await this.engine.archiveSession(sid, {
      reapRemoteWindow: true,
      preserveForReconnect: true,
    });
  }
}
