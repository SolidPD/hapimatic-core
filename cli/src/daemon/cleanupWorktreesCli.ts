// SPDX-License-Identifier: MIT
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

import {
  discoverWorktreeInstances,
  getListeningPorts,
  releaseWorktreePortClaim,
  type DiscoveredWorktreeInstance,
} from "./worktreeMeta";
import {
  isWorktreeLive,
  listLiveCwds,
  resolveRepoRoot,
  tearDownWorktreeInstance,
} from "./worktree";
import { resolveWorktreeHostBase } from "./worktreeHostBase";

const execFileAsync = promisify(execFile);

/**
 * `hapi daemon cleanup-worktrees` — TS implementation of the bash crons'
 * teardown loop (#1385 Task 4 / R7). Discovers failed and/or expired worktree
 * instances and tears them down via `tearDownWorktreeInstance`.
 *
 * Replaces the bash duplications in `scripts/worktree-crash-recovery.sh` and
 * `scripts/worktree-ttl-cleanup.sh` with a single canonical TS entry point.
 * Task 5 reduces those scripts to thin wrappers that `exec` into this
 * subcommand (cron entries unchanged — wrappers preserve XDG/DBUS env setup).
 *
 * Output format mirrors the bash cron log lines (`[<ISO_UTC>] <message>`) so
 * operators can diff side-by-side during the bash → TS migration.
 *
 * Modes:
 *   - `failed` — mirrors `worktree-crash-recovery.sh`: lists systemd units in
 *     `failed` state, tears them down with `clean: true` (matches bash
 *     `--clean --force`).
 *   - `ttl`    — mirrors `worktree-ttl-cleanup.sh`: Pass 1 age-based (instances
 *     older than `--ttl-hours`) + Pass 2 idle-based (active daemons with 0
 *     tmux sessions and uptime > `--idle-hours`). Both passes use
 *     `clean: false` (matches bash `--force` only, NOT `--clean`).
 *   - `both`   — runs failed then ttl.
 *
 * Defaults: `--ttl-hours=24`, `--idle-hours=1`. Matches bash defaults.
 */

export type CleanupMode = "failed" | "ttl" | "orphaned-claims" | "both";

export interface CleanupOptions {
  mode: CleanupMode;
  ttlHours: number;
  idleHours: number;
  dryRun: boolean;
  /**
   * Issue #3592: explicit repo root, overriding `process.cwd()`. Validated at
   * parse time (non-empty, absolute) and always passed through `resolveRepoRoot`
   * — never used verbatim. NOT threaded from the cron wrappers in this PR (D1-A);
   * for tests, manual invocation, and future federation use from any cwd.
   */
  repoRoot?: string;
}

interface CleanupCandidate {
  port: number;
  reason: string;
  /** True for crashed units (matches bash `--clean`); false for ttl/idle
   *  (matches bash `--force` without `--clean`). */
  clean: boolean;
  worktreePath?: string;
  sessionId?: string;
}

/**
 * Result shape for `listDaemonPortsByState` (issue #1390). Distinguishes
 * "systemctl returned an empty list" (failed=false, ports=[]) from "systemctl
 * itself errored" (failed=true) so callers can surface cron-env breakage
 * (dbus/linger drift, missing systemctl) instead of silently swallowing it.
 */
export interface ListDaemonPortsResult {
  ports: number[];
  failed: boolean;
  reason?: string;
}

/** Internal aggregate returned by `findFailedCandidates` and `findTtlCandidates`. */
interface FindCandidatesResult {
  candidates: CleanupCandidate[];
  systemctlFailed: boolean;
}

const DEFAULT_TTL_HOURS = 24;
const DEFAULT_IDLE_HOURS = 1;
const USAGE =
  "Usage: hapi daemon cleanup-worktrees " +
  "[--mode=failed|ttl|orphaned-claims|both] [--ttl-hours=N] [--idle-hours=N] " +
  "[--repo-root=DIR] [--dry-run]";

function logCron(message: string): void {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  console.log(`[${ts}] ${message}`);
}

export function parseArgs(args: string[]): CleanupOptions {
  let mode: CleanupMode = "both";
  let ttlHours = DEFAULT_TTL_HOURS;
  let idleHours = DEFAULT_IDLE_HOURS;
  let dryRun = false;
  let repoRoot: string | undefined;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (
        value !== "failed" &&
        value !== "ttl" &&
        value !== "orphaned-claims" &&
        value !== "both"
      ) {
        throw new Error(
          `Invalid --mode value: '${value}' (expected failed|ttl|orphaned-claims|both)`
        );
      }
      mode = value;
      continue;
    }
    if (arg.startsWith("--ttl-hours=")) {
      const raw = arg.slice("--ttl-hours=".length);
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --ttl-hours value: '${raw}'`);
      }
      ttlHours = value;
      continue;
    }
    if (arg.startsWith("--idle-hours=")) {
      const raw = arg.slice("--idle-hours=".length);
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --idle-hours value: '${raw}'`);
      }
      idleHours = value;
      continue;
    }
    if (arg.startsWith("--repo-root=")) {
      const raw = arg.slice("--repo-root=".length);
      // Issue #3592 (finding 3592-2): reject empty and relative values at parse
      // time. A relative path resolved against a cron cwd is exactly the failure
      // class this flag guards against — refuse it rather than resolve() it. The
      // accepted value is still passed through resolveRepoRoot (never verbatim).
      if (raw === "" || !raw.startsWith("/")) {
        throw new Error(
          `Invalid --repo-root value: '${raw}' (must be a non-empty absolute path)`
        );
      }
      repoRoot = raw;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error("__HELP__");
    }
    throw new Error(`Unknown argument: '${arg}'`);
  }

  return { mode, ttlHours, idleHours, dryRun, repoRoot };
}

/**
 * Issue #3592: resolve the repo root for the cleanup run. Prefers an explicit
 * `--repo-root` (validated absolute at parse time) over `cwd`, and ALWAYS passes
 * the chosen value through `resolveRepoRoot` — never verbatim. `resolveRepoRoot`
 * git-resolves the path, normalizes a worktree path to its MAIN root, and
 * verifies `<root>/.git` exists, so a typo'd/relative/non-repo value THROWS
 * (→ the caller's exit 2) rather than silently discovering 0 instances and
 * letting Pass 2 reap gated instances (finding 3592-2). Exported for unit tests.
 */
export async function resolveCleanupRepoRoot(
  options: CleanupOptions,
  cwd: string = process.cwd()
): Promise<string> {
  return resolveRepoRoot(options.repoRoot ?? cwd);
}

export async function listDaemonPortsByState(
  state: "failed" | "active"
): Promise<ListDaemonPortsResult> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user",
      "list-units",
      "--type=service",
      `--state=${state}`,
      "--no-legend",
      "hapimatic-wt-*-daemon.service",
    ]);
    const ports: number[] = [];
    for (const match of stdout.matchAll(
      /hapimatic-wt-(\d+)-daemon\.service/g
    )) {
      const port = Number(match[1]);
      if (Number.isFinite(port)) ports.push(port);
    }
    return { ports, failed: false };
  } catch (err) {
    // Issue #1390: surface systemctl failure to the caller instead of swallowing.
    // The previous `catch { return [] }` matched the bash `|| true` pattern but
    // that was the silent-failure bug — cron-env breakage (dbus/linger drift,
    // missing systemctl) returned an empty list indistinguishable from "no
    // failed units," so cron mail-on-failure never fired. Callers now surface
    // the failure and the runner returns a non-zero exit code.
    const message = err instanceof Error ? err.message : String(err);
    return { ports: [], failed: true, reason: message };
  }
}

/**
 * Returns true when the given worktree holds an open approval-gate sentinel
 * (`claudedocs/issue-<N>-awaiting-approval.md`). The worker writes it at the
 * approval gate and the closer removes it, so its presence means "operator
 * verification pending" (#2915). This is the liveness signal the Pass 2 idle
 * reap must honor: a verification instance has 0 tmux sessions on its OWN
 * socket by construction (the driving Claude session runs under the PROD
 * daemon), so tmux count can never distinguish "live operator-facing" from
 * "abandoned".
 *
 * Fail-safe direction is deliberate: a missing/unreadable `claudedocs/` dir
 * returns false (do NOT exempt), matching the issue's "under-exempt = no worse
 * than today" risk posture — a filesystem hiccup must never protect every
 * instance.
 */
function hasOpenApprovalGate(worktreePath?: string): boolean {
  if (!worktreePath) return false;
  try {
    const dir = join(worktreePath, "claudedocs");
    // #3331 (Task 7, R6): a worktree with a live USER-APPROVAL challenge/grant
    // file is "awaiting user" exactly like the #2915 awaiting-approval sentinel,
    // so extend the veto to the D3a flat-dotfile literals (registry §4.4). The
    // flat naming is what makes this possible — readdirSync above is
    // non-recursive, so a subdirectory would have been invisible. Scope is Pass 2
    // (idle) only: this predicate's sole call site is the idle reap; Pass 1's 24h
    // age reap deliberately still collects a stale gate (bounded leak, 3331-8).
    return readdirSync(dir).some(
      f =>
        /^issue-.*-awaiting-approval\.md$/.test(f) ||
        /^\.approval-challenge-\d+\.json$/.test(f) ||
        /^\.user-approval-granted-\d+\.json$/.test(f)
    );
  } catch {
    // No claudedocs dir / unreadable → NOT exempt (fail toward today's reap).
    return false;
  }
}

async function getTmuxSessionCount(port: number): Promise<number> {
  try {
    const { stdout } = await execFileAsync("tmux", [
      "-L",
      `hapimatic-wt-${port}`,
      "list-sessions",
    ]);
    return stdout.split("\n").filter(line => line.trim().length > 0).length;
  } catch {
    // tmux exits 1 when no server is running for this socket. Mirrors the
    // bash `tmux list-sessions 2>/dev/null | wc -l || true` pattern.
    return 0;
  }
}

async function getDaemonUptimeSeconds(
  port: number,
  nowEpoch: number
): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("systemctl", [
      "--user",
      "show",
      `hapimatic-wt-${port}-daemon.service`,
      "--property=ActiveEnterTimestamp",
      "--value",
    ]);
    const ts = stdout.trim();
    if (!ts) return null;
    const enterMs = Date.parse(ts);
    if (!Number.isFinite(enterMs)) return null;
    return nowEpoch - Math.floor(enterMs / 1000);
  } catch {
    return null;
  }
}

/**
 * #3202: absolute path of a worktree instance's browser-presence sidecar. The
 * producer (`server/src/web/worktreePresence.ts`) writes it into the per-instance
 * DATA DIR (`HAPI_HOME` = `$HOME/.hapimatic-wt-<port>`); this consumer half derives
 * the SAME directory from the port — the `${home}/.hapimatic-wt-${port}` derivation
 * `tearDownWorktreeInstance` uses in `worktree.ts`. They match ONLY because
 * `scripts/hapi-worktree.sh` sets `HAPI_HOME=$data_dir` with
 * `data_dir="$HOME/.hapimatic-wt-<port>"` — the producer↔consumer sidecar contract.
 * Consumed by #3210's "reaped by NEITHER sweep" test; do not diverge the path or
 * mtime semantics after landing without notifying #3210.
 */
export function sidecarPathForPort(port: number): string {
  return join(homedir(), `.hapimatic-wt-${port}`, ".worktree-last-request");
}

/**
 * #3202: last browser-presence epoch (seconds) for a worktree instance, read from
 * the sidecar's mtime, or `null` on ANY error (absent/unreadable). Fail-safe
 * direction mirrors `hasOpenApprovalGate`: a missing/unreadable signal ⇒ `null` ⇒
 * NOT exempt ⇒ today's reap (under-exempt = no worse than today). Keyed by PORT,
 * not `worktreePath`, so it also works for the Pass-2 orphan case where the
 * worktree dir is gone. `resolvePath` is a unit-test seam (real temp files, no fs
 * mocking) — it redirects only WHERE the file is looked up, so the real
 * `statSync`/mtime code path is still exercised.
 */
function getLastRequestEpoch(
  port: number,
  resolvePath: (port: number) => string = sidecarPathForPort
): number | null {
  try {
    return Math.floor(statSync(resolvePath(port)).mtimeMs / 1000);
  } catch {
    // Absent / unreadable sidecar → no presence signal (fail toward the reap).
    return null;
  }
}

async function findFailedCandidates(
  instances: DiscoveredWorktreeInstance[]
): Promise<FindCandidatesResult> {
  const result = await listDaemonPortsByState("failed");
  if (result.failed) {
    logCron(
      `WARNING: systemctl --user list-units (failed) errored — ` +
        `cron env may be broken (dbus/linger drift?). ` +
        `Reason: ${result.reason ?? "unknown"}`
    );
    return { candidates: [], systemctlFailed: true };
  }
  if (result.ports.length === 0) {
    logCron("No crashed worktree units found.");
    return { candidates: [], systemctlFailed: false };
  }

  logCron(`Processing ${result.ports.length} failed daemon unit(s)...`);
  const instanceByPort = new Map<number, DiscoveredWorktreeInstance>();
  for (const instance of instances) {
    instanceByPort.set(instance.port, instance);
  }

  const candidates: CleanupCandidate[] = [];
  for (const port of result.ports) {
    const instance = instanceByPort.get(port);
    if (instance) {
      logCron(
        `  Crash detected: hapimatic-wt-${port}-daemon.service ` +
          `(worktree: ${basename(instance.worktreePath)})`
      );
    } else {
      logCron(
        `  Crash detected: hapimatic-wt-${port}-daemon.service ` +
          `(orphan: no worktree dir for port ${port})`
      );
    }
    candidates.push({
      port,
      reason: instance ? "crashed" : "crashed-orphan",
      clean: true,
      worktreePath: instance?.worktreePath,
      sessionId: instance?.sessionId,
    });
  }
  return { candidates, systemctlFailed: false };
}

export async function findTtlCandidates(
  instances: DiscoveredWorktreeInstance[],
  ttlHours: number,
  idleHours: number,
  // #2915: injectable seams for unit tests (mirrors findOrphanedClaimCandidates
  // in this file). When omitted, each value is resolved live. The sentinel check
  // (`hasOpenApprovalGate`) is deliberately NOT seamed — tests drive it with real
  // temp-dir fixtures, honoring the package's no-fs-mocking convention.
  // #3202: `sidecarPathForPort` seams WHERE the browser-presence sidecar is looked
  // up, NOT the epoch value — the real `statSync`/mtime path is still exercised
  // (fs-derived like the sentinel; tested with real temp files). Seaming it also
  // keeps the #2915 cases from stat-ing a real `~/.hapimatic-wt-<port>` on a box
  // with live instances.
  seams?: {
    activePorts?: number[];
    tmuxSessionCounts?: Map<number, number>;
    daemonUptimeSeconds?: Map<number, number>;
    sidecarPathForPort?: (port: number) => string;
  }
): Promise<FindCandidatesResult> {
  const candidates: CleanupCandidate[] = [];
  const nowEpoch = Math.floor(Date.now() / 1000);
  const ttlSeconds = ttlHours * 3600;
  const idleThresholdSeconds = idleHours * 3600;

  // Pass 1 (age): iterate discovered instances, check created_at age.
  let expiredCount = 0;
  for (const instance of instances) {
    if (!instance.createdAt) continue;
    const createdMs = Date.parse(instance.createdAt);
    if (!Number.isFinite(createdMs)) continue;
    const ageSec = nowEpoch - Math.floor(createdMs / 1000);
    if (ageSec <= ttlSeconds) continue;
    const ageHours = Math.floor(ageSec / 3600);
    logCron(
      `TTL expired: ${basename(instance.worktreePath)} ` +
        `(age: ${ageHours}h, port: ${instance.port})`
    );
    candidates.push({
      port: instance.port,
      reason: `ttl-age (${ageHours}h > ${ttlHours}h)`,
      // Pass 1 in bash uses `--force` without `--clean`.
      clean: false,
      worktreePath: instance.worktreePath,
      sessionId: instance.sessionId,
    });
    expiredCount++;
  }
  if (expiredCount === 0) {
    logCron(`Pass 1 (age): no expired instances found (TTL: ${ttlHours}h).`);
  } else {
    logCron(`Pass 1 (age): found ${expiredCount} expired instance(s).`);
  }

  // Pass 2 (idle): for any active daemon not already caught by Pass 1, check
  // tmux session count + daemon uptime. Catches orphans whose worktree dir
  // was deleted before the daemon was stopped — Pass 1 cannot see those.
  let activeDaemonPorts: number[];
  if (seams?.activePorts) {
    activeDaemonPorts = seams.activePorts;
  } else {
    const activeResult = await listDaemonPortsByState("active");
    if (activeResult.failed) {
      // Issue #1390: surface systemctl failure to the runner. Pass 1's candidates
      // are still valid (they came from `discoverWorktreeInstances`, not systemctl),
      // so keep them; just skip Pass 2 and flag the failure for the exit code.
      logCron(
        `WARNING: systemctl --user list-units (active) errored — ` +
          `skipping Pass 2 (idle). ` +
          `Reason: ${activeResult.reason ?? "unknown"}`
      );
      return { candidates, systemctlFailed: true };
    }
    activeDaemonPorts = activeResult.ports;
  }
  const passOnePorts = new Set(candidates.map(c => c.port));
  const instanceByPort = new Map<number, DiscoveredWorktreeInstance>();
  for (const instance of instances) {
    instanceByPort.set(instance.port, instance);
  }

  let idleCount = 0;
  for (const port of activeDaemonPorts) {
    if (passOnePorts.has(port)) continue;

    // #2915: exempt an instance actively serving an operator during an open
    // approval gate. A verification instance has 0 tmux sessions on its OWN
    // socket by construction (the driving Claude session runs under the PROD
    // daemon), so it always reads as idle below — the awaiting-approval sentinel
    // is the only authoritative "operator verification pending" signal. Pass 1's
    // 24h age reap still collects a stale gate, so any leak stays bounded (R3).
    const instance = instanceByPort.get(port);
    if (hasOpenApprovalGate(instance?.worktreePath)) {
      logCron(
        `Pass 2 (idle): skipping hapimatic-wt-${port} — open approval gate ` +
          `(awaiting-approval sentinel present).`
      );
      continue;
    }

    // #3202: exempt an instance with a browser attached (SSE presence). The
    // sidecar lives in the per-port DATA DIR (not the worktree — the server has
    // no worktree cwd); absent/unreadable ⇒ null ⇒ fall through to the reap.
    // Reuse idleThresholdSeconds as the recency window (KD-2, load-bearing): a
    // stale sidecar from a PREVIOUS instance on this port was written before the
    // new instance's uptime window opened, so it can never wrongly exempt.
    const lastReq = getLastRequestEpoch(
      port,
      seams?.sidecarPathForPort ?? sidecarPathForPort
    );
    if (lastReq !== null && nowEpoch - lastReq <= idleThresholdSeconds) {
      logCron(
        `Pass 2 (idle): skipping hapimatic-wt-${port} — recent browser presence ` +
          `(last SSE presence ${nowEpoch - lastReq}s ago ≤ ${idleHours}h idle window).`
      );
      continue;
    }

    const sessionCount = seams?.tmuxSessionCounts
      ? (seams.tmuxSessionCounts.get(port) ?? 0)
      : await getTmuxSessionCount(port);
    if (sessionCount > 0) continue;

    const uptime = seams?.daemonUptimeSeconds
      ? (seams.daemonUptimeSeconds.get(port) ?? null)
      : await getDaemonUptimeSeconds(port, nowEpoch);
    if (uptime === null) continue;
    if (uptime <= idleThresholdSeconds) continue;

    const uptimeHours = Math.floor(uptime / 3600);
    logCron(
      `Idle daemon detected: hapimatic-wt-${port} ` +
        `(uptime: ${uptimeHours}h, 0 tmux sessions)`
    );
    candidates.push({
      port,
      reason: `ttl-idle (${uptimeHours}h, 0 tmux sessions)`,
      // Pass 2 in bash uses direct systemctl stop (no --clean).
      clean: false,
      worktreePath: instance?.worktreePath,
      sessionId: instance?.sessionId,
    });
    idleCount++;
  }
  if (idleCount === 0) {
    logCron(`Pass 2 (idle): no idle daemons found.`);
  } else {
    logCron(
      `Pass 2 (idle): found ${idleCount} idle daemon(s) ` +
        `(threshold: ${idleHours}h).`
    );
  }

  return { candidates, systemctlFailed: false };
}

/**
 * Find worktrees that hold a port claim but have no live owning session and
 * no bound/active instance — the leak shape this reclaim targets (#1683,
 * R4/R5/R7).
 *
 * Gating order (D3 — liveness FIRST, then listening/active):
 *   1. SKIP a worktree whose dir has a live process cwd (R3) — protects a
 *      session still deploying (alive during the #1471 claim-before-bind
 *      window even before the port is listening).
 *   2. SKIP a worktree whose claimed port is currently listening OR whose
 *      daemon unit is active — that is a deployed/running instance; leave it
 *      to --mode=failed / --mode=ttl (which now also null the meta via Task 7).
 *   3. Otherwise it is an orphaned claim → candidate (port-only release).
 *
 * Seams (`liveCwds`, `listeningPorts`, `activePorts`) are injectable so the
 * candidate-selection logic is unit-testable without /proc, `ss`, or systemd;
 * when omitted they are resolved live. A failed `systemctl` active-unit
 * enumeration is surfaced via `systemctlFailed` (preserves the #1390
 * invariant) but does NOT block the reclaim — the /proc-liveness + listening
 * gates remain the safety net and the release is port-only (recoverable).
 */
export async function findOrphanedClaimCandidates(
  instances: DiscoveredWorktreeInstance[],
  seams?: {
    liveCwds?: string[];
    listeningPorts?: Set<number>;
    activePorts?: Set<number>;
  }
): Promise<FindCandidatesResult> {
  if (instances.length === 0) {
    return { candidates: [], systemctlFailed: false };
  }

  const liveCwds = seams?.liveCwds ?? (await listLiveCwds());
  const listeningPorts = seams?.listeningPorts ?? (await getListeningPorts());

  let activePorts: Set<number>;
  let systemctlFailed = false;
  if (seams?.activePorts) {
    activePorts = seams.activePorts;
  } else {
    const activeResult = await listDaemonPortsByState("active");
    if (activeResult.failed) {
      logCron(
        `WARNING: systemctl --user list-units (active) errored — ` +
          `orphaned-claims active-unit gate degraded to listening-only. ` +
          `Reason: ${activeResult.reason ?? "unknown"}`
      );
      systemctlFailed = true;
      activePorts = new Set();
    } else {
      activePorts = new Set(activeResult.ports);
    }
  }

  const candidates: CleanupCandidate[] = [];
  for (const instance of instances) {
    if (isWorktreeLive(instance.worktreePath, liveCwds)) continue; // R3
    if (listeningPorts.has(instance.port) || activePorts.has(instance.port)) {
      continue; // deployed/active instance — leave to failed/ttl
    }
    logCron(
      `Orphaned claim: ${basename(instance.worktreePath)} ` +
        `(port: ${instance.port}, no live owner, not bound)`
    );
    candidates.push({
      port: instance.port,
      reason: "orphaned-claim",
      clean: false,
      worktreePath: instance.worktreePath,
      sessionId: instance.sessionId,
    });
  }

  if (candidates.length === 0) {
    logCron("No orphaned port claims found.");
  } else {
    logCron(`Found ${candidates.length} orphaned port claim(s).`);
  }

  return { candidates, systemctlFailed };
}

/**
 * Entry point for the `hapi daemon cleanup-worktrees` subcommand.
 * Returns the process exit code (0=success, 1=partial failure, 2=usage error).
 */
export async function runCleanupWorktreesCli(args: string[]): Promise<number> {
  let options: CleanupOptions;
  try {
    options = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "__HELP__") {
      console.log(USAGE);
      return 0;
    }
    console.error(`Error: ${message}`);
    console.error(USAGE);
    return 2;
  }

  let repoRoot: string;
  try {
    repoRoot = await resolveCleanupRepoRoot(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const source = options.repoRoot ? "--repo-root" : "cwd";
    console.error(
      `Error: cannot resolve repo root from ${options.repoRoot ?? process.cwd()} (${source}): ${message}`
    );
    return 2;
  }

  const instances = await discoverWorktreeInstances(repoRoot);
  logCron(
    `Discovered ${instances.length} worktree instance(s) under ${repoRoot}/.worktrees/`
  );
  // Issue #3592 (step 4): 0 instances + a MISSING .worktrees/ dir under the
  // resolved host base is the fingerprint of a wrong cwd/--repo-root. Warn only
  // (do NOT exit) — a fresh node legitimately has no .worktrees/ yet, so this is
  // deliberately NOT coupled to the #1390 exit-1 path. Compute the base with the
  // same resolver discovery uses (worktreeMeta.ts) so a relocated node
  // (HAPI_WORKTREE_HOST_ROOT) does not warn falsely.
  if (instances.length === 0) {
    const hostBase = resolveWorktreeHostBase(repoRoot);
    if (!existsSync(join(hostBase, ".worktrees"))) {
      logCron(
        `WARNING: no .worktrees/ directory under ${hostBase} — check cwd/--repo-root`
      );
    }
  }

  const candidates: CleanupCandidate[] = [];
  // Issue #1390: aggregate the systemctlFailed flag across both modes so the
  // runner can return a non-zero exit when list-units errored. Without this,
  // a broken cron env (no dbus, missing systemctl) returns the same exit 0 as
  // a healthy "nothing to clean up" run — the exact silent-failure bug that
  // silent-failure-hunter #2a (PR #1344) was meant to surface.
  let systemctlFailed = false;
  if (options.mode === "failed" || options.mode === "both") {
    const r = await findFailedCandidates(instances);
    candidates.push(...r.candidates);
    systemctlFailed = systemctlFailed || r.systemctlFailed;
  }
  if (options.mode === "ttl" || options.mode === "both") {
    const r = await findTtlCandidates(
      instances,
      options.ttlHours,
      options.idleHours
    );
    candidates.push(...r.candidates);
    systemctlFailed = systemctlFailed || r.systemctlFailed;
  }
  if (options.mode === "orphaned-claims" || options.mode === "both") {
    const r = await findOrphanedClaimCandidates(instances);
    candidates.push(...r.candidates);
    systemctlFailed = systemctlFailed || r.systemctlFailed;
  }

  if (candidates.length === 0) {
    if (systemctlFailed) {
      // CRITICAL: distinguish "no candidates" (everything quiet) from
      // "no visibility" (systemctl broken). The latter MUST exit non-zero so
      // cron mail-on-failure fires. This is the #1390 invariant.
      logCron(
        "Exiting with HARD_FAIL — systemctl errors prevented full enumeration. " +
          "Cron mail will fire."
      );
      return 1;
    }
    logCron("No teardown candidates — exiting clean.");
    return 0;
  }

  let cleanedCount = 0;
  let failedCount = 0;
  for (const candidate of candidates) {
    // #1683 (Task 6): an orphaned-claim has no bound instance to tear down —
    // it is a port-only, work-preserving release of the meta claim. Never call
    // tearDownWorktreeInstance and never delete the worktree dir/branch.
    if (candidate.reason === "orphaned-claim") {
      const label = options.dryRun
        ? "[DRY-RUN] would-release-claim"
        : "Releasing claim";
      logCron(`  ${label}: port=${candidate.port} reason=${candidate.reason}`);
      if (options.dryRun) continue;
      if (!candidate.worktreePath) continue;
      const released = await releaseWorktreePortClaim(candidate.worktreePath);
      if (released) {
        logCron(`    Port claim released — port ${candidate.port} freed.`);
        cleanedCount++;
      } else {
        logCron(
          `    Port claim already null/missing — port ${candidate.port} (no-op).`
        );
      }
      continue;
    }

    const actionLabel = options.dryRun
      ? "[DRY-RUN] would-tear-down"
      : "Tearing down";
    logCron(
      `  ${actionLabel}: port=${candidate.port} reason=${candidate.reason} ` +
        `clean=${candidate.clean}`
    );
    if (options.dryRun) continue;

    const result = await tearDownWorktreeInstance({
      port: candidate.port,
      sessionId: candidate.sessionId,
      clean: candidate.clean,
    });
    if (result.ok) {
      logCron(`    Teardown succeeded — port ${candidate.port} released.`);
      // #1683 (Task 7): tearDownWorktreeInstance stops units + (optionally)
      // removes data dir/binary but NEVER nulls the meta claim, so a
      // crash-recovery/ttl teardown would otherwise leave a stale meta claim
      // that still blocks allocation (#1619 treats a meta claim as ownership).
      // Null it here so the torn-down instance leaves no stale claim. Guard on
      // worktreePath — crash-orphans have no worktree dir to update.
      if (candidate.worktreePath) {
        await releaseWorktreePortClaim(candidate.worktreePath);
      }
      cleanedCount++;
    } else {
      const detail = result.details?.stillBoundPids
        ? ` (still-bound PIDs: ${result.details.stillBoundPids.join(", ")})`
        : "";
      logCron(
        `    Teardown failed — port=${candidate.port}: ${result.error}${detail}`
      );
      failedCount++;
    }
  }

  if (options.dryRun) {
    logCron(
      `Done (dry-run): ${candidates.length} candidate(s) identified, ` +
        `${failedCount} pre-flight failures.`
    );
  } else {
    logCron(`Done: ${cleanedCount} cleaned, ${failedCount} failed.`);
  }
  // Issue #1390: systemctlFailed propagates to non-zero exit even when some
  // teardowns succeeded — partial visibility still means cron mail should fire.
  return failedCount > 0 || systemctlFailed ? 1 : 0;
}
