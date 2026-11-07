// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Session memory containment (issue #4743).
 *
 * Claude sessions run as panes of the daemon's tmux server, and a pane lands
 * wherever that server lives:
 * - tmux 3.3a (RP1) does not move panes, so they stay in the server's cgroup.
 * - tmux 3.4 (Ubuntu 24.04) moves only the pane's top pid into its own
 *   `tmux-spawn-<uuid>.scope`, in the server's user slice, AFTER fork — so the
 *   session tree lands in the server's cgroup or in that scope (a race).
 * - tmux >=3.6 moves every pane deterministically, again into the server's slice;
 *   tmux >=3.7 also makes each pane scope `PartOf=` the unit that started the
 *   server.
 *
 * So the server's location decides containment. This module places each
 * instance's tmux server in its own scope inside the node's sessions slice
 * (`hapimatic-sessions.slice`, which carries the memory limits): a new server
 * is started there through `systemd-run --scope`, and a server found elsewhere
 * (started before this change, or by another process such as RP1's desktop
 * launcher) is adopted there with `StartTransientUnit`. Every race outcome then
 * lands under the slice, and a daemon restart cannot reach the panes on tmux
 * >=3.7 because their `PartOf=` names the server's scope, not the daemon unit.
 *
 * The feature is ON only when the slice's unit file is installed (provisioning
 * ships it) and `HAPI_SESSION_SLICE` does not disable it. Every failure falls
 * back to the plain start — the caller's existing path — and never throws.
 * The server scope MUST carry `OOMPolicy=continue`: with the default `stop`, one
 * kernel OOM kill inside the scope would stop it and kill every session in it.
 * `StartTransientUnit` is atomic, so a rejected property creates no scope.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";

export const DEFAULT_SESSION_SLICE = "hapimatic-sessions.slice";
export const SESSION_SLICE_ENV = "HAPI_SESSION_SLICE";

/**
 * The words that turn a switch off — `HAPI_SESSION_SLICE`, the #6156 session ceiling,
 * the spawn-memory headroom and the slice-pressure watchdog all read this one set.
 */
export const DISABLE_TOKENS: ReadonlySet<string> = new Set([
  "off",
  "0",
  "false",
  "no",
  "none",
]);

/**
 * Values of `HAPI_SESSION_SLICE` that mean "on, with the default slice" — the
 * repo's usual enable words, so re-enabling with `on` or `1` never reads as an
 * invalid slice name (which would turn containment off).
 */
const ENABLE_TOKENS = new Set(["on", "1", "true", "yes"]);

/** A slice name systemd accepts and that is safe to pass as an argv element. */
const SLICE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.slice$/;

/** Bound for `systemctl --user show` and `busctl` calls. */
export const SYSTEMD_CALL_TIMEOUT_MS = 5000;

/**
 * Bound for the `systemd-run --scope … tmux new-session` call: a D-Bus round
 * trip, the scope job wait, then tmux starting its server.
 */
export const SERVER_SCOPE_START_TIMEOUT_MS = 10_000;

/** How long to wait for an adopted server to show up in the slice. */
export const ADOPT_POLL_TIMEOUT_MS = 2000;
const ADOPT_POLL_INTERVAL_MS = 100;

export interface SessionSliceConfig {
  enabled: boolean;
  /** The node slice that carries the limits. */
  slice: string;
  /** Why containment is off, when it is. */
  reason?: string;
}

/**
 * Read `HAPI_SESSION_SLICE`: unset or an on token → the default slice; an off
 * token → disabled; a value that is not a valid slice name → disabled (never
 * pass an unvalidated name to systemd).
 */
export function resolveSessionSliceConfig(
  env: NodeJS.ProcessEnv = process.env
): SessionSliceConfig {
  const raw = env[SESSION_SLICE_ENV];
  if (raw === undefined || raw.trim() === "") {
    return { enabled: true, slice: DEFAULT_SESSION_SLICE };
  }
  const value = raw.trim();
  if (ENABLE_TOKENS.has(value.toLowerCase())) {
    return { enabled: true, slice: DEFAULT_SESSION_SLICE };
  }
  if (DISABLE_TOKENS.has(value.toLowerCase())) {
    return {
      enabled: false,
      slice: DEFAULT_SESSION_SLICE,
      reason: `${SESSION_SLICE_ENV}=${value}`,
    };
  }
  if (!SLICE_NAME_RE.test(value) || /--|-\.slice$/.test(value)) {
    return {
      enabled: false,
      slice: DEFAULT_SESSION_SLICE,
      reason: `${SESSION_SLICE_ENV} is not a valid slice name`,
    };
  }
  return { enabled: true, slice: value };
}

/**
 * The cgroup path segment of a slice, by systemd's dash rule:
 * `a-b-c.slice` lives at `a.slice/a-b.slice/a-b-c.slice`.
 */
export function sliceCgroupSegment(slice: string): string {
  const base = slice.replace(/\.slice$/, "");
  const parts = base.split("-");
  const segments: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    segments.push(`${parts.slice(0, i).join("-")}.slice`);
  }
  return segments.join("/");
}

/**
 * The node sessions slice's cgroup directory for `uid` under `cgroupRoot` (no trailing
 * slash). One formula, because the spawn-admission gate and the slice-pressure watchdog
 * must read the same slice (#6156).
 */
export function nodeSliceCgroupDir(
  cgroupRoot: string,
  uid: number,
  slice: string
): string {
  return `${cgroupRoot}/user.slice/user-${uid}.slice/user@${uid}.service/${sliceCgroupSegment(slice)}`;
}

/** `uid` when the caller passed one (`null` included), else this process's uid. */
export function resolveUid(uid?: number | null): number | null {
  if (uid !== undefined) return uid;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

/**
 * The per-instance child slice under the node slice:
 * `hapimatic-private` → `hapimatic-sessions-private.slice`,
 * `hapimatic-wt-3010` → `hapimatic-sessions-wt-3010.slice`. It needs no unit
 * file — systemd creates it on demand and the node slice's limits bind it as an
 * ancestor. tmux 3.4 puts pane scopes in this, the deepest, slice.
 */
export function instanceSliceFor(
  socketName: string,
  nodeSlice: string
): string {
  const nodeBase = nodeSlice.replace(/\.slice$/, "");
  const instance = socketName
    .replace(/^hapimatic-/, "")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return instance ? `${nodeBase}-${instance}.slice` : nodeSlice;
}

/** The cgroup v2 path from `/proc/<pid>/cgroup` (`0::<path>`); null on v1/hybrid. */
export function parseCgroupV2Path(procCgroupText: string): string | null {
  for (const line of procCgroupText.split("\n")) {
    if (line.startsWith("0::")) return line.slice(3).trim() || null;
  }
  return null;
}

/** True when a cgroup path is at or under the slice. */
export function isCgroupPathInSlice(path: string, slice: string): boolean {
  return `${path}/`.includes(`/${sliceCgroupSegment(slice)}/`);
}

/** The server scope's unit name: fixed per socket so operators can find it. */
export function serverScopeUnitName(
  socketName: string,
  suffix?: string
): string {
  const safe = /^[A-Za-z0-9_-]+$/.test(socketName)
    ? socketName
    : createHash("sha256").update(socketName).digest("hex").slice(0, 12);
  return `hapimatic-tmux-${safe}${suffix ? `-${suffix}` : ""}.scope`;
}

/**
 * `systemd-run --scope` argv that starts a tmux server inside the instance's
 * child slice. `systemd-run` moves itself into the scope, waits for the scope
 * job, then execs tmux — so the server is born in the scope. An argv array,
 * never a shell string.
 */
export function buildServerScopeArgv(opts: {
  nodeSlice: string;
  socketName: string;
  tmuxArgs: string[];
  unitSuffix?: string;
}): string[] {
  return [
    "systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--slice=${instanceSliceFor(opts.socketName, opts.nodeSlice)}`,
    `--unit=${serverScopeUnitName(opts.socketName, opts.unitSuffix)}`,
    "--property=OOMPolicy=continue",
    `--description=Hapimatic tmux server (-L ${opts.socketName})`,
    "--",
    "tmux",
    "-L",
    opts.socketName,
    ...opts.tmuxArgs,
  ];
}

/**
 * `busctl` argv that moves a running tmux server into a new scope in the
 * instance's child slice. A user manager that may not move the pid itself (a
 * login-session scope) retries through PID 1's `AttachProcessesToUnit`.
 */
export function buildAdoptServerArgv(opts: {
  nodeSlice: string;
  socketName: string;
  pid: number;
  unitSuffix?: string;
}): string[] {
  return [
    "busctl",
    "--user",
    "call",
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "StartTransientUnit",
    "ssa(sv)a(sa(sv))",
    serverScopeUnitName(opts.socketName, opts.unitSuffix),
    "fail",
    "5",
    "PIDs",
    "au",
    "1",
    String(opts.pid),
    "Slice",
    "s",
    instanceSliceFor(opts.socketName, opts.nodeSlice),
    "OOMPolicy",
    "s",
    "continue",
    "CollectMode",
    "s",
    "inactive-or-failed",
    "Description",
    "s",
    `Hapimatic tmux server (-L ${opts.socketName}, adopted)`,
    "0",
  ];
}

/** `systemctl show` output (`Key=Value` lines) → a map. */
export function parseSystemctlShow(output: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) map[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return map;
}

/** A scope name that is already taken by a unit that has not been collected. */
export function isUnitExistsError(stderr: string): boolean {
  return /already exists|already loaded|already active/i.test(stderr);
}

/** Why a command failed, for a log line. */
function describeFailure(result: CommandResult): string {
  if (result.timedOut) return "timed out";
  return result.stderr.trim() || `exit ${result.code}`;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type CommandRunner = (
  argv: string[],
  opts: { timeoutMs: number; env?: Record<string, string> }
) => Promise<CommandResult>;

/** Async argv runner with a hard timeout; never rejects. */
export const runCommand: CommandRunner = (argv, opts) =>
  new Promise(resolve => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), {
        env: opts.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs);
    child.stdout?.on("data", data => {
      stdout += data.toString();
    });
    child.stderr?.on("data", data => {
      stderr += data.toString();
    });
    child.on("error", error => {
      finish({ code: null, stdout, stderr: error.message, timedOut: false });
    });
    child.on("close", code => {
      finish({ code, stdout, stderr, timedOut: false });
    });
  });

export interface SliceProbe {
  ok: boolean;
  memoryMax?: string;
  reason?: string;
}

/**
 * The slice is usable only when its unit FILE is installed (`LoadState=loaded`
 * with a `FragmentPath`). Never let `--slice=` create an implicit, unlimited
 * slice — that would just move the escape under a new name.
 */
export async function probeSliceProvisioned(
  slice: string,
  run: CommandRunner = runCommand
): Promise<SliceProbe> {
  const result = await run(
    [
      "systemctl",
      "--user",
      "show",
      slice,
      "-p",
      "LoadState",
      "-p",
      "FragmentPath",
      "-p",
      "MemoryMax",
    ],
    { timeoutMs: SYSTEMD_CALL_TIMEOUT_MS }
  );
  if (result.code !== 0) {
    return {
      ok: false,
      reason: result.timedOut
        ? "systemctl --user show timed out"
        : `systemctl --user show failed: ${describeFailure(result)}`,
    };
  }
  const props = parseSystemctlShow(result.stdout);
  if (props.LoadState !== "loaded") {
    return {
      ok: false,
      reason: `${slice} is not installed (LoadState=${props.LoadState ?? "?"})`,
    };
  }
  if (!props.FragmentPath) {
    // systemd reports LoadState=loaded for any slice name, so name the missing file.
    return {
      ok: false,
      reason: `${slice} has no unit file (LoadState=loaded, FragmentPath empty) — install it and run daemon-reload`,
    };
  }
  return { ok: true, memoryMax: props.MemoryMax };
}

/** How long a probe result is reused: a newly installed slice is picked up within this window. */
export const SLICE_PROBE_CACHE_MS = 60_000;
const probeCache = new Map<string, { at: number; result: SliceProbe }>();

/** {@link probeSliceProvisioned}, reused for {@link SLICE_PROBE_CACHE_MS} so spawns stay cheap. */
async function cachedProbe(
  slice: string,
  run: CommandRunner
): Promise<SliceProbe> {
  const hit = probeCache.get(slice);
  if (hit && Date.now() - hit.at < SLICE_PROBE_CACHE_MS) return hit.result;
  const result = await probeSliceProvisioned(slice, run);
  probeCache.set(slice, { at: Date.now(), result });
  return result;
}

const warnedOnce = new Set<string>();

/** Log a containment problem once per process per key (spawns repeat often). */
function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  logger.warn(message);
}

/**
 * One warning per reason when containment is off, from whichever path sees it
 * first: a node whose tmux server is already running only ever reaches
 * `ensureTmuxServerContained`, so an off or invalid value must warn there too.
 */
function warnContainmentOff(reason: string | undefined): void {
  warnOnce(
    `disabled:${reason}`,
    `[SessionSlice] containment off (${reason}) — tmux servers start, and running ones stay, in the caller's cgroup`
  );
}

/** Test seam: forget logged warnings and cached probe results. */
export function resetSessionSliceStateForTest(): void {
  warnedOnce.clear();
  probeCache.clear();
}

/**
 * Run a scope-creating systemd call under the fixed unit name, retrying once
 * under a fresh name only when that name is still taken (a scope whose last
 * process has not exited yet). Any other failure is returned as is.
 */
async function runWithFreshNameRetry(
  buildArgv: (unitSuffix?: string) => string[],
  run: CommandRunner,
  opts: { timeoutMs: number; env?: Record<string, string> }
): Promise<CommandResult> {
  const result = await run(buildArgv(), opts);
  if (result.code === 0 || !isUnitExistsError(result.stderr)) return result;
  return run(buildArgv(randomBytes(4).toString("hex")), opts);
}

export type StartServerOutcome = "started" | "skipped" | "failed";

/**
 * Start a tmux server (with its first session) inside the instance's slice.
 * `skipped` = containment is off, the slice is not installed, or a server is
 * already running (only the session is missing — a scope would then hold just
 * a short-lived tmux client; the caller's plain start adds the session and
 * `ensureTmuxServerContained` moves the server); `failed` = the systemd/tmux
 * call failed. On either, the caller runs its plain `new-session`. After
 * `failed` it first re-checks that the session is still missing: the scoped
 * call may have created it before failing (a timeout), and a concurrent
 * creator makes `tmux new-session` fail with "duplicate session".
 */
export async function startTmuxServerInSlice(opts: {
  socketName: string;
  tmuxArgs: string[];
  env: Record<string, string>;
  run?: CommandRunner;
  probe?: (slice: string) => Promise<SliceProbe>;
  processEnv?: NodeJS.ProcessEnv;
  /** True when this socket already has a running server. */
  serverRunning?: () => Promise<boolean>;
}): Promise<StartServerOutcome> {
  const run = opts.run ?? runCommand;
  const config = resolveSessionSliceConfig(opts.processEnv);
  if (!config.enabled) {
    warnContainmentOff(config.reason);
    return "skipped";
  }
  if (opts.serverRunning && (await opts.serverRunning())) {
    logger.debug(
      `[SessionSlice] tmux server -L ${opts.socketName} is already running — no scope start`
    );
    return "skipped";
  }
  const probe = await (opts.probe ?? (s => cachedProbe(s, run)))(config.slice);
  if (!probe.ok) {
    warnOnce(
      `unprovisioned:${config.slice}`,
      `[SessionSlice] ${probe.reason} — tmux server for -L ${opts.socketName} starts without session memory containment (#4743)`
    );
    return "skipped";
  }

  const result = await runWithFreshNameRetry(
    unitSuffix =>
      buildServerScopeArgv({
        nodeSlice: config.slice,
        socketName: opts.socketName,
        tmuxArgs: opts.tmuxArgs,
        unitSuffix,
      }),
    run,
    { timeoutMs: SERVER_SCOPE_START_TIMEOUT_MS, env: opts.env }
  );
  if (result.code === 0) {
    logger.info(
      `[SessionSlice] started tmux server -L ${opts.socketName} in ${instanceSliceFor(opts.socketName, config.slice)} (OOMPolicy=continue)`
    );
    return "started";
  }
  warnOnce(
    `start-failed:${opts.socketName}`,
    `[SessionSlice] could not start tmux server -L ${opts.socketName} in ${config.slice} (${describeFailure(result)}) — falling back to a plain start`
  );
  return "failed";
}

export type ContainmentOutcome =
  | "disabled"
  | "no-server"
  | "contained"
  | "unprovisioned"
  | "unreadable"
  | "adopted"
  | "failed";

async function readProcText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null; // ENOENT/ESRCH: the process is gone
  }
}

/**
 * Ensure the running tmux server for a socket is inside the sessions slice,
 * adopting it there if not. Never starts a server and never throws.
 */
export async function ensureTmuxServerContained(opts: {
  socketName: string;
  readServerPid: () => Promise<number | null>;
  run?: CommandRunner;
  probe?: (slice: string) => Promise<SliceProbe>;
  readProc?: (path: string) => Promise<string | null>;
  processEnv?: NodeJS.ProcessEnv;
}): Promise<ContainmentOutcome> {
  try {
    const config = resolveSessionSliceConfig(opts.processEnv);
    if (!config.enabled) {
      // A running server reaches only this path, so it must warn too.
      warnContainmentOff(config.reason);
      return "disabled";
    }
    const run = opts.run ?? runCommand;
    const readProc = opts.readProc ?? readProcText;

    const pid = await opts.readServerPid();
    if (pid === null) return "no-server";
    const cgroupText = await readProc(`/proc/${pid}/cgroup`);
    const path = cgroupText ? parseCgroupV2Path(cgroupText) : null;
    if (path === null) {
      warnOnce(
        `unreadable:${opts.socketName}`,
        `[SessionSlice] cannot read the cgroup of tmux server -L ${opts.socketName} (pid ${pid}) — containment not checked`
      );
      return "unreadable";
    }
    if (isCgroupPathInSlice(path, config.slice)) return "contained";

    const probe = await (opts.probe ?? (s => cachedProbe(s, run)))(
      config.slice
    );
    if (!probe.ok) {
      warnOnce(
        `unprovisioned:${config.slice}`,
        `[SessionSlice] ${probe.reason} — tmux server -L ${opts.socketName} stays in ${path} without session memory containment (#4743)`
      );
      return "unprovisioned";
    }

    // PID-reuse guard: the pid must still be this socket's tmux server.
    const pidAgain = await opts.readServerPid();
    const comm = (await readProc(`/proc/${pid}/comm`))?.trim() ?? "";
    if (pidAgain !== pid || !comm.startsWith("tmux")) {
      warnOnce(
        `pid-changed:${opts.socketName}`,
        `[SessionSlice] tmux server -L ${opts.socketName} changed while adopting (pid ${pid} → ${pidAgain ?? "none"}, comm "${comm}") — skipped`
      );
      return "failed";
    }

    const result = await runWithFreshNameRetry(
      unitSuffix =>
        buildAdoptServerArgv({
          nodeSlice: config.slice,
          socketName: opts.socketName,
          pid,
          unitSuffix,
        }),
      run,
      { timeoutMs: SYSTEMD_CALL_TIMEOUT_MS }
    );
    if (result.code !== 0) {
      warnOnce(
        `adopt-failed:${opts.socketName}`,
        `[SessionSlice] could not adopt tmux server -L ${opts.socketName} (pid ${pid}) from ${path} (${describeFailure(result)})`
      );
      return "failed";
    }

    // The scope job runs asynchronously; wait for the move to show.
    const deadline = Date.now() + ADOPT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const now = await readProc(`/proc/${pid}/cgroup`);
      const nowPath = now ? parseCgroupV2Path(now) : null;
      if (nowPath && isCgroupPathInSlice(nowPath, config.slice)) {
        logger.info(
          `[SessionSlice] adopted tmux server -L ${opts.socketName} (pid ${pid}) from ${path} into ${instanceSliceFor(opts.socketName, config.slice)}; sessions already running stay where they are until respawned`
        );
        return "adopted";
      }
      await new Promise(r => setTimeout(r, ADOPT_POLL_INTERVAL_MS));
    }
    warnOnce(
      `adopt-unconfirmed:${opts.socketName}`,
      `[SessionSlice] adopted tmux server -L ${opts.socketName} (pid ${pid}) but it is not in ${config.slice} after ${ADOPT_POLL_TIMEOUT_MS}ms`
    );
    return "failed";
  } catch (error) {
    logger.debug(`[SessionSlice] containment check failed: ${error}`);
    return "failed";
  }
}

/** {@link probeSliceProvisioned}, reused for {@link SLICE_PROBE_CACHE_MS} (the spawn path's probe). */
export function probeSliceProvisionedCached(
  slice: string,
  run: CommandRunner = runCommand
): Promise<SliceProbe> {
  return cachedProbe(slice, run);
}

// --- Per-session memory ceiling (issue #6156, S3) -------------------------------------
//
// Every session's processes used to share the tmux server's scope, so one session's
// tool job could take the whole slice. Each new daemon-spawned session now moves itself
// into its own transient scope under the instance slice before it starts the wrapper:
// the pane runs `bash <script>`, and that script's shell forks the wrapper, so moving
// the shell's own pid (`$$`) puts the whole session tree in the scope. tmux 3.4 moves
// only the pane's top pid, which is a different process, so there is no race with it.
// The scope carries a hard MemoryMax and a small MemorySwapMax but no MemoryHigh: a
// MemoryHigh only throttles, which is the crawl #6156 is about. The move fails open —
// the session starts as before, with a warning on the pane's stderr.

export const SESSION_MEMORY_CEILING_ENV = "HAPI_SESSION_MEMORY_CEILING_PCT";
export const DEFAULT_SESSION_MEMORY_CEILING_PCT = 60;
/** The ceiling never goes below this (or the slice limit, if smaller). */
export const SESSION_CEILING_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;
/** Swap a session may use beyond its ceiling before the kernel OOM-kills in its scope. */
export const SESSION_SWAP_CAP_BYTES = 512 * 1024 * 1024;
export const SESSION_SCOPE_PREFIX = "hapimatic-session-";

/** The ceiling as a percentage of the slice limit, or `null` when turned off. */
export function resolveSessionMemoryCeilingPct(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const raw = env[SESSION_MEMORY_CEILING_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "")
    return DEFAULT_SESSION_MEMORY_CEILING_PCT;
  if (DISABLE_TOKENS.has(raw)) return null;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 100) return n;
  warnOnce(
    `ceiling-env:${raw}`,
    `[SessionSlice] ${SESSION_MEMORY_CEILING_ENV}=${raw} is not 1-100 or off; using ${DEFAULT_SESSION_MEMORY_CEILING_PCT}`
  );
  return DEFAULT_SESSION_MEMORY_CEILING_PCT;
}

/** A session's MemoryMax and MemorySwapMax for a slice whose effective limit is `limitBytes`. */
export function sessionMemoryCeiling(
  limitBytes: number,
  pct: number
): { memoryMaxBytes: number; swapMaxBytes: number } {
  const floor = Math.min(SESSION_CEILING_FLOOR_BYTES, limitBytes);
  const memoryMaxBytes = Math.min(
    limitBytes,
    Math.max(floor, Math.floor((limitBytes * pct) / 100))
  );
  return {
    memoryMaxBytes,
    swapMaxBytes: Math.min(
      SESSION_SWAP_CAP_BYTES,
      Math.floor(memoryMaxBytes / 4)
    ),
  };
}

/** `hapimatic-session-<tag>-<nonce>.scope`; a tag outside `[A-Za-z0-9_-]` is hashed. */
export function sessionScopeUnitName(
  sessionTag: string,
  nonce: string
): string {
  const safe = /^[A-Za-z0-9_-]+$/.test(sessionTag)
    ? sessionTag
    : createHash("sha256").update(sessionTag).digest("hex").slice(0, 12);
  const safeNonce = nonce.replace(/[^A-Za-z0-9]/g, "");
  return `${SESSION_SCOPE_PREFIX}${safe}-${safeNonce}.scope`;
}

/** How long the pane waits for the user manager to answer `StartTransientUnit`. */
export const SESSION_SCOPE_BUSCTL_TIMEOUT_S = 3;

/**
 * The bash block a pane's launch script runs before the wrapper: it moves the script's
 * own shell into a new scope, waits up to 2 s for the move to show in `/proc/$$/cgroup`,
 * and always ends with status 0. busctl gets a short timeout (its default is 25 s, inside
 * the spawn's 60 s webhook budget), and when the step fails the pane's warning carries
 * busctl's own error. Every interpolated name is validated to a shell-safe charset; the
 * byte counts are integers.
 */
export function buildSessionScopeSnippet(opts: {
  nodeSlice: string;
  socketName: string;
  sessionTag: string;
  memoryMaxBytes: number;
  swapMaxBytes: number;
  nonce: string;
}): string {
  const unit = sessionScopeUnitName(opts.sessionTag, opts.nonce);
  const slice = instanceSliceFor(opts.socketName, opts.nodeSlice);
  if (!/^[A-Za-z0-9_.-]+$/.test(slice)) {
    throw new Error(`session scope: unsafe slice name ${slice}`);
  }
  // [name, D-Bus type, value]; the count passed to busctl is derived from this list,
  // never written by hand (a hand-written count that was off by one let a 2026-11-05
  // research fixture run uncapped for 5.5 h on ms1).
  const props: Array<[string, string, string]> = [
    ["PIDs", "au", '1 "$$"'],
    ["Slice", "s", `'${slice}'`],
    ["OOMPolicy", "s", "continue"],
    ["CollectMode", "s", "inactive-or-failed"],
    ["MemoryMax", "t", String(Math.floor(opts.memoryMaxBytes))],
    ["MemorySwapMax", "t", String(Math.floor(opts.swapMaxBytes))],
  ];
  const propArgs = props
    .map(([name, type, value]) => `${name} ${type} ${value}`)
    .join(" ");
  const warn = (why: string): string =>
    `echo "[hapi] per-session memory ceiling not applied (#6156): ${why}" >&2`;
  const inScope = `command grep -qF '${unit}' /proc/$$/cgroup 2>/dev/null`;
  return (
    `{ if command -v busctl >/dev/null 2>&1 && [ -n "\${XDG_RUNTIME_DIR:-}" ]; then ` +
    `if __hapi_e=$(command busctl --user --timeout=${SESSION_SCOPE_BUSCTL_TIMEOUT_S} call ` +
    `org.freedesktop.systemd1 /org/freedesktop/systemd1 ` +
    `org.freedesktop.systemd1.Manager StartTransientUnit 'ssa(sv)a(sa(sv))' ` +
    `'${unit}' fail ${props.length} ${propArgs} 0 2>&1 >/dev/null); then ` +
    `__hapi_n=0; while [ "$__hapi_n" -lt 40 ] && ! ${inScope}; do command sleep 0.05; __hapi_n=$((__hapi_n + 1)); done; ` +
    `${inScope} || ${warn("busctl accepted the scope but this shell did not move into it")}; ` +
    `else ${warn("busctl: ${__hapi_e:-no error text}")}; fi; ` +
    `else ${warn("busctl or XDG_RUNTIME_DIR is missing")}; fi; }`
  );
}
