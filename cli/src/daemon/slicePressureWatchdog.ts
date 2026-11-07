// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Slice-pressure watchdog (issue #6156, S2).
 *
 * `MemoryHigh` throttles and reclaims but never kills. A tool job that needs more than
 * the sessions slice can give (three concurrent `shellcheck` runs, each over 6 GiB)
 * therefore crawls at the limit for as long as it lives, and its page-cache refaults
 * saturate the disk the Hapimatic server reads from: ms1 stalled for 55 minutes on
 * 2026-11-02, and again for 5.5 hours on 2026-11-05 under a single runaway allocator.
 * systemd-oomd cannot help: it is not installed on the VMs, and it kills every process
 * in a leaf cgroup, which is a whole session (its own scope, #6156 S3) or, for a
 * session started before S3 or whose scope failed, the tmux server scope holding all
 * of them.
 *
 * This watchdog kills one process instead:
 * - **Trigger**, per watched cgroup (the node slice, plus each per-session scope from
 *   #6156 S3), over a sliding window (`HAPI_SLICE_PRESSURE_WINDOW_S`, 120 s): the
 *   cumulative `some` memory-stall time grew by at least `HAPI_SLICE_PRESSURE_STALL_PCT`
 *   (50) percent of the wall time, AND the cgroup pressed its own limit (`memory.events`
 *   `high` grew on the node slice, `max` on a session scope). Cumulative counters, not
 *   `avg10`, so an oscillating thrash still fires.
 * - **Victim**: a process in that cgroup whose environment carries `CLAUDECODE=1` and a
 *   `HAPI_SESSION_ID` — a process the agent ran (a tool, a hook, an MCP server). `claude`,
 *   the hapimatic wrapper, pane shells and tmux never carry `CLAUDECODE`: Claude Code
 *   sets it only for its own children, and the daemon deletes it from its own env at
 *   start (`run.ts` Defense #1) and from every pane's env and the tmux server's global
 *   table, so a daemon or tmux server started from inside a session cannot hand it to
 *   every pane. The victim is the largest such process whose `RssAnon + RssShmem +
 *   VmSwap` grew by at least 1 MiB since pressure began (an idle MCP server carries
 *   `CLAUDECODE` too, but does not grow). Growth is not the rank: at `MemoryHigh` the
 *   kernel throttles every allocator, so the runaway grows no faster than a compile
 *   beside it. If nothing grew (a job thrashing in place at its limit), the largest
 *   process in the scope stalling most on its own `memory.pressure` (`some avg10`);
 *   with no readable scope stall, the largest overall.
 * - **Kill**: `SIGKILL` (as the kernel OOM killer does) to the victim's process group
 *   when every member is eligible and inside the node slice, else to the victim alone.
 *   A start-time check guards against pid reuse. Then a 30 s cooldown (also after a
 *   failed kill), every watched window starts over, and at most 3 kills per 15 minutes
 *   per node.
 * - **One actor per node**: prod, dev and the worktree instances share the node slice,
 *   so the daemons hold a lease (`$XDG_RUNTIME_DIR/hapimatic/slice-pressure-watchdog.lease`)
 *   and only its holder evaluates and kills, with authority over every instance slice.
 *   A daemon that cannot see the node slice never holds it. An `observe` daemon does
 *   hold it, so a node whose lease holder observes is a dry run.
 *   A dead holder's lease is taken over on the next tick.
 *
 * `HAPI_SLICE_PRESSURE_WATCHDOG`: `enforce` (default) kills, `observe` logs what it
 * would kill, `off` (or `0` / `false` / `no` / `none`) disables the loop.
 * Docs: docs/internal/architecture/sessions.md § "Slice-pressure watchdog (#6156)".
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SupervisedLoop } from "@hapi/protocol";
import { trimTrailingChars } from "@hapi/protocol/trimChars";
import { logger } from "@/ui/logger";
import {
  DISABLE_TOKENS,
  SESSION_SCOPE_PREFIX,
  nodeSliceCgroupDir,
  resolveSessionSliceConfig,
  resolveUid,
} from "@/tmux/sessionSlice";
import type { ClockSeams, DaemonContext } from "./daemonContext";
import { parsePsiSomeAvg10 } from "./memoryAdmission";

export type WatchdogMode = "off" | "observe" | "enforce";
export const WATCHDOG_MODE_ENV = "HAPI_SLICE_PRESSURE_WATCHDOG";
export const WATCHDOG_WINDOW_ENV = "HAPI_SLICE_PRESSURE_WINDOW_S";
export const WATCHDOG_STALL_PCT_ENV = "HAPI_SLICE_PRESSURE_STALL_PCT";
export const DEFAULT_WATCHDOG_MODE: WatchdogMode = "enforce";
export const DEFAULT_WINDOW_S = 120;
export const DEFAULT_STALL_PCT = 50;
export const WATCHDOG_INTERVAL_MS = 10_000;
export const KILL_COOLDOWN_MS = 30_000;
export const KILL_BUDGET = 3;
export const KILL_BUDGET_WINDOW_MS = 15 * 60_000;
/** Processes smaller than this are not even read for their environment. */
export const MIN_CANDIDATE_BYTES = 64 * 1024 * 1024;
/** The victim must hold at least this much; killing a small process frees nothing. */
export const MIN_VICTIM_BYTES = 256 * 1024 * 1024;
/** A victim must have grown this much since pressure began; idle processes are spared. */
export const MIN_VICTIM_GROWTH_BYTES = 1024 * 1024;

const LEASE_FILE = "slice-pressure-watchdog.lease";
const BUDGET_FILE = "slice-pressure-watchdog.budget.json";

export interface WatchdogConfig {
  mode: WatchdogMode;
  windowMs: number;
  stallFraction: number;
}

/** Read the mode and tunables; junk falls back to the default with a warning. */
export function resolveWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env
): WatchdogConfig {
  const rawMode = env[WATCHDOG_MODE_ENV]?.trim().toLowerCase();
  let mode: WatchdogMode = DEFAULT_WATCHDOG_MODE;
  if (rawMode && DISABLE_TOKENS.has(rawMode)) mode = "off";
  else if (rawMode === "observe") mode = "observe";
  else if (rawMode === "enforce" || rawMode === "on" || rawMode === "1")
    mode = "enforce";
  else if (rawMode) {
    logger.warn(
      `[SlicePressure] ${WATCHDOG_MODE_ENV}=${rawMode} is not off|observe|enforce; using ${DEFAULT_WATCHDOG_MODE}`
    );
  }
  const num = (
    name: string,
    fallback: number,
    min: number,
    max: number
  ): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      logger.warn(
        `[SlicePressure] ${name}=${raw} is outside ${min}-${max}; using ${fallback}`
      );
      return fallback;
    }
    return n;
  };
  return {
    mode,
    windowMs: num(WATCHDOG_WINDOW_ENV, DEFAULT_WINDOW_S, 30, 3600) * 1000,
    stallFraction:
      num(WATCHDOG_STALL_PCT_ENV, DEFAULT_STALL_PCT, 10, 100) / 100,
  };
}

/** `total=` of the `some` line of a PSI file, in microseconds. */
export function parsePsiSomeTotal(text: string | null): number | null {
  const m = text === null ? null : /^some\b.*\btotal=(\d+)/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** The `high` and `max` counters of `memory.events`. */
export function parseMemoryEvents(
  text: string | null
): { high: number; max: number } | null {
  if (text === null) return null;
  const high = /^high (\d+)$/m.exec(text);
  const max = /^max (\d+)$/m.exec(text);
  return { high: high ? Number(high[1]) : 0, max: max ? Number(max[1]) : 0 };
}

export interface PressureSample {
  at: number;
  someTotalUs: number;
  high: number;
  max: number;
}

/**
 * Whether a window of samples shows sustained pressure on the cgroup's own limit.
 * `samples` is oldest first; the window starts at the newest sample that is at least
 * `windowMs` older than the latest one.
 */
export function isSustainedPressure(
  samples: readonly PressureSample[],
  windowMs: number,
  stallFraction: number,
  limitEvent: "high" | "max"
): boolean {
  if (samples.length < 2) return false;
  const latest = samples[samples.length - 1];
  let start: PressureSample | undefined;
  for (let i = samples.length - 2; i >= 0; i--) {
    if (latest.at - samples[i].at >= windowMs) {
      start = samples[i];
      break;
    }
  }
  if (!start) return false;
  const wallUs = (latest.at - start.at) * 1000;
  const stallUs = latest.someTotalUs - start.someTotalUs;
  const limitHits = latest[limitEvent] - start[limitEvent];
  return wallUs > 0 && stallUs / wallUs >= stallFraction && limitHits > 0;
}

/** Whether the latest step alone stalled at the threshold (pressure is on now). */
export function isPressureNow(
  samples: readonly PressureSample[],
  stallFraction: number
): boolean {
  if (samples.length < 2) return false;
  const a = samples[samples.length - 2];
  const b = samples[samples.length - 1];
  const wallUs = (b.at - a.at) * 1000;
  return (
    wallUs > 0 && (b.someTotalUs - a.someTotalUs) / wallUs >= stallFraction
  );
}

export interface ProcInfo {
  pid: number;
  comm: string;
  /** Field 22 of `/proc/<pid>/stat` (clock ticks since boot) — the pid-reuse guard. */
  startTime: string;
  pgrp: number;
  ppid: number;
  /** `RssAnon + RssShmem + VmSwap` in bytes: memory that reclaim cannot just drop. */
  memBytes: number;
}

/** Parse `/proc/<pid>/stat` (the comm field may contain spaces and parentheses). */
export function parseProcStat(
  text: string
): { comm: string; ppid: number; pgrp: number; startTime: string } | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).split(" ");
  // rest[0] is field 3 (state); ppid = field 4, pgrp = field 5, starttime = field 22.
  if (rest.length < 20) return null;
  return {
    comm: text.slice(open + 1, close),
    ppid: Number(rest[1]),
    pgrp: Number(rest[2]),
    startTime: rest[19],
  };
}

/** `RssAnon + RssShmem + VmSwap` from `/proc/<pid>/status`, in bytes. */
export function parseNonReclaimableBytes(text: string): number {
  let kb = 0;
  for (const re of [
    /^RssAnon:\s+(\d+) kB/m,
    /^RssShmem:\s+(\d+) kB/m,
    /^VmSwap:\s+(\d+) kB/m,
  ]) {
    const m = re.exec(text);
    if (m) kb += Number(m[1]);
  }
  return kb * 1024;
}

/** The session id when the environment marks an agent-run process, else null. */
export function agentSessionFromEnviron(environ: string): string | null {
  const vars = environ.split("\0");
  if (!vars.includes("CLAUDECODE=1")) return null;
  const sid = vars.find(v => v.startsWith("HAPI_SESSION_ID="));
  const value = sid?.slice("HAPI_SESSION_ID=".length);
  return value ? value : null;
}

export interface Candidate extends ProcInfo {
  sessionId: string;
  growthBytes: number;
  /** The cgroup whose `cgroup.procs` lists it (a session's scope, or the server scope). */
  cgroup: string;
  /** Set on the chosen victim: which rule picked it, for the kill log. */
  pickedBy?: string;
}

/** The largest of `list` (then the faster grower); null for an empty list. */
function largestOf(list: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const c of list) {
    if (
      !best ||
      c.memBytes > best.memBytes ||
      (c.memBytes === best.memBytes && c.growthBytes > best.growthBytes)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Pick the victim among processes of at least `MIN_VICTIM_BYTES`:
 * 1. the largest that grew by at least `MIN_VICTIM_GROWTH_BYTES` since pressure began;
 * 2. if none grew (a job thrashing in place at its limit), the largest in the cgroup
 *    whose own `memory.pressure` `some avg10` (`stallOf`) is highest — never a calm
 *    one (avg10 0): when every readable candidate cgroup is calm, the stall is in a
 *    process the watchdog may not kill (claude itself), and an idle process in a calm
 *    scope stays out of reach, so there is no victim;
 * 3. if no candidate's cgroup has a readable stall, the largest overall.
 */
export function pickVictim(
  candidates: readonly Candidate[],
  stallOf: (cgroup: string) => number | null = () => null
): Candidate | null {
  const big = candidates.filter(c => c.memBytes >= MIN_VICTIM_BYTES);
  const picked = (c: Candidate | null, by: string): Candidate | null =>
    c ? { ...c, pickedBy: by } : null;
  const grew = big.filter(c => c.growthBytes >= MIN_VICTIM_GROWTH_BYTES);
  if (grew.length > 0) {
    return picked(largestOf(grew), "the largest that grew while stalled");
  }
  let readable = false;
  let worst: { cgroup: string; stall: number } | null = null;
  for (const cgroup of new Set(big.map(c => c.cgroup))) {
    const stall = stallOf(cgroup);
    if (stall === null) continue;
    readable = true;
    if (stall > 0 && (!worst || stall > worst.stall)) {
      worst = { cgroup, stall };
    }
  }
  if (worst) {
    const { cgroup, stall } = worst;
    return picked(
      largestOf(big.filter(c => c.cgroup === cgroup)),
      `nothing grew; the largest in the scope stalling most (some avg10 ${stall})`
    );
  }
  if (readable) return null;
  return picked(
    largestOf(big),
    "nothing grew; the largest (no scope stall readable)"
  );
}

export interface WatchdogIo {
  readText(path: string): string | null;
  listDir(path: string): string[];
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Create a file only if absent; false when it exists. */
  createExclusive(path: string, body: string): boolean;
  writeText(path: string, body: string): void;
  remove(path: string): void;
  ensureDir(path: string): void;
}

export const realWatchdogIo: WatchdogIo = {
  readText(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  listDir(path) {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  kill(pid, signal) {
    process.kill(pid, signal);
  },
  createExclusive(path, body) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
    try {
      writeFileSync(fd, body);
    } catch (err) {
      // A full tmpfs: never leave an empty lease behind, or leak the fd each tick.
      closeSync(fd);
      unlinkSync(path);
      throw err;
    }
    closeSync(fd);
    return true;
  },
  writeText(path, body) {
    writeFileSync(path, body, { mode: 0o600 });
  },
  remove(path) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  },
  ensureDir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
};

export interface WatchdogDeps {
  io?: WatchdogIo;
  env?: NodeJS.ProcessEnv;
  uid?: number | null;
  procRoot?: string;
  cgroupRoot?: string;
  selfPid?: number;
  now?: () => number;
}

/** What one tick did, for tests and the log. */
export type TickResult =
  | { kind: "not-holder" }
  | { kind: "no-slice" }
  | { kind: "quiet" }
  | { kind: "cooldown" }
  | { kind: "budget-exhausted"; cgroup: string }
  /** Sustained pressure first seen this tick: growth is measured from now, ranked next tick. */
  | { kind: "measuring"; cgroup: string }
  | { kind: "no-victim"; cgroup: string }
  | {
      kind: "would-kill" | "killed";
      cgroup: string;
      victim: Candidate;
      group: boolean;
    }
  | { kind: "kill-failed"; cgroup: string; victim: Candidate; error: string };

/**
 * The watchdog state machine. One instance per daemon; only the lease holder acts.
 */
export function createSlicePressureWatchdog(deps: WatchdogDeps = {}) {
  const io = deps.io ?? realWatchdogIo;
  const env = deps.env ?? process.env;
  const config = resolveWatchdogConfig(env);
  const now = deps.now ?? Date.now;
  const procRoot = deps.procRoot ?? "/proc";
  const cgroupRoot = trimTrailingChars(
    deps.cgroupRoot ?? "/sys/fs/cgroup",
    "/"
  );
  const selfPid = deps.selfPid ?? process.pid;
  const uid = resolveUid(deps.uid);
  const runtimeDir = env.XDG_RUNTIME_DIR
    ? join(env.XDG_RUNTIME_DIR, "hapimatic")
    : null;
  const leasePath = runtimeDir ? join(runtimeDir, LEASE_FILE) : null;
  const budgetPath = runtimeDir ? join(runtimeDir, BUDGET_FILE) : null;

  const samples = new Map<string, PressureSample[]>();
  /** Per watched cgroup: each candidate's memory when pressure began (pid:startTime → bytes). */
  const baselines = new Map<string, Map<string, number>>();
  let cooldownUntil = 0;
  let lastBudgetAlarm = 0;
  /** A no-victim episode is reported once, until pressure clears. */
  let noVictimReported = false;
  /** Kills this daemon made, kept beside the budget file in case a write fails. */
  let localKills: number[] = [];
  let warnedNoRuntimeDir = false;

  const statOf = (pid: number) => {
    const text = io.readText(`${procRoot}/${pid}/stat`);
    return text === null ? null : parseProcStat(text);
  };

  /**
   * Lease I/O failures, reported once per cause (a full tmpfs fails every tick) until
   * this daemon next holds the lease, when a later failure is reported again.
   */
  const leaseWarned = new Set<string>();
  const warnLeaseOnce = (code: string, message: string): void => {
    if (leaseWarned.has(code)) return;
    leaseWarned.add(code);
    const line = `[SlicePressure] ${message} — this daemon cannot act as the slice-pressure watchdog (#6156)`;
    logger.warn(line);
    logger.reportCaught(new Error(line), {
      category: "slice-pressure-watchdog",
      severity: "warn",
    });
  };
  const errCode = (err: unknown): string =>
    (err as NodeJS.ErrnoException)?.code ?? String(err);

  const readHolder = (): {
    pid?: number;
    startTime?: string;
    mode?: string;
  } => {
    try {
      return JSON.parse(io.readText(leasePath ?? "") ?? "{}") as {
        pid?: number;
        startTime?: string;
        mode?: string;
      };
    } catch {
      return {};
    }
  };

  /** Whether this daemon held the lease last tick; null before the first tick. */
  let wasHolder: boolean | null = null;
  /** `why` null: the node slice is visible, so the lease file tells who acts. */
  const noteLeaseState = (holder: boolean, why: string | null): void => {
    if (holder === wasHolder) return;
    wasHolder = holder;
    if (holder) {
      logger.info(
        `[SlicePressure] this daemon now acts as the slice-pressure watchdog, mode ${config.mode} (#6156)`
      );
      return;
    }
    const h = why === null ? readHolder() : {};
    const reason =
      why ??
      (h.pid && h.pid !== selfPid
        ? `pid ${h.pid} holds the lease, mode ${h.mode ?? "unknown"}`
        : "it could not take the lease");
    logger.info(
      `[SlicePressure] this daemon does not act as the slice-pressure watchdog: ${reason} (#6156)`
    );
  };

  /** Hold or take the node lease; true when this daemon is the actor. */
  const holdLease = (): boolean => {
    if (!leasePath || !runtimeDir) {
      if (!warnedNoRuntimeDir) {
        warnedNoRuntimeDir = true;
        logger.warn(
          "[SlicePressure] XDG_RUNTIME_DIR is unset — this daemon will not act as the slice-pressure watchdog (#6156)"
        );
      }
      return false;
    }
    const mine = statOf(selfPid);
    if (!mine) {
      warnLeaseOnce("self-stat", `cannot read ${procRoot}/${selfPid}/stat`);
      return false;
    }
    const body = JSON.stringify({
      pid: selfPid,
      startTime: mine.startTime,
      mode: config.mode,
    });
    try {
      io.ensureDir(runtimeDir);
      if (io.createExclusive(leasePath, body)) return true;
    } catch (err) {
      warnLeaseOnce(errCode(err), `lease create failed: ${err}`);
      return false;
    }
    const holder = readHolder();
    if (holder.pid === selfPid && holder.startTime === mine.startTime)
      return true;
    const alive = typeof holder.pid === "number" ? statOf(holder.pid) : null;
    if (alive && alive.startTime === holder.startTime) return false;
    // A dead or garbled holder: take over. The loser of a race stays a non-holder.
    try {
      io.remove(leasePath);
      return io.createExclusive(leasePath, body);
    } catch (err) {
      warnLeaseOnce(errCode(err), `lease takeover failed: ${err}`);
      return false;
    }
  };

  const releaseLease = (): void => {
    if (!leasePath) return;
    const mine = statOf(selfPid);
    try {
      const holder = JSON.parse(io.readText(leasePath) ?? "{}") as {
        pid?: number;
        startTime?: string;
      };
      if (mine && holder.pid === selfPid && holder.startTime === mine.startTime)
        io.remove(leasePath);
    } catch {
      // not ours or unreadable — leave it
    }
  };

  const readBudget = (): number[] => {
    if (!budgetPath) return [];
    try {
      const parsed = JSON.parse(io.readText(budgetPath) ?? "{}") as {
        kills?: unknown;
      };
      return Array.isArray(parsed.kills)
        ? parsed.kills.filter((t): t is number => typeof t === "number")
        : [];
    } catch {
      return [];
    }
  };

  const nodeSlicePath = (): string | null => {
    const sliceConfig = resolveSessionSliceConfig(env);
    if (!sliceConfig.enabled || uid === null) return null;
    const path = nodeSliceCgroupDir(cgroupRoot, uid, sliceConfig.slice);
    return io.readText(`${path}/memory.pressure`) === null ? null : path;
  };

  /** Every cgroup directory under `root` (root included), depth-first. */
  const walk = (root: string): string[] => {
    const out = [root];
    for (let i = 0; i < out.length; i++) {
      for (const name of io.listDir(out[i])) {
        if (name.endsWith(".slice") || name.endsWith(".scope"))
          out.push(`${out[i]}/${name}`);
      }
    }
    return out;
  };

  const sample = (cgroup: string): PressureSample | null => {
    const some = parsePsiSomeTotal(io.readText(`${cgroup}/memory.pressure`));
    const events = parseMemoryEvents(io.readText(`${cgroup}/memory.events`));
    if (some === null || events === null) return null;
    return { at: now(), someTotalUs: some, ...events };
  };

  /** The daemon itself and its ancestors are never candidates. */
  const protectedPids = (): Set<number> => {
    const out = new Set<number>([selfPid]);
    let pid = selfPid;
    for (let hops = 0; hops < 64 && pid > 1; hops++) {
      const st = statOf(pid);
      if (!st) break;
      pid = st.ppid;
      out.add(pid);
    }
    return out;
  };

  const candidatesIn = (cgroup: string): Candidate[] => {
    const skip = protectedPids();
    const out: Candidate[] = [];
    const base = baselines.get(cgroup);
    for (const dir of walk(cgroup)) {
      for (const line of (io.readText(`${dir}/cgroup.procs`) ?? "").split(
        "\n"
      )) {
        const pid = Number(line.trim());
        if (!Number.isInteger(pid) || pid <= 1 || skip.has(pid)) continue;
        const status = io.readText(`${procRoot}/${pid}/status`);
        if (status === null) continue;
        const memBytes = parseNonReclaimableBytes(status);
        if (memBytes < MIN_CANDIDATE_BYTES) continue;
        const sessionId = agentSessionFromEnviron(
          io.readText(`${procRoot}/${pid}/environ`) ?? ""
        );
        if (!sessionId) continue;
        const st = statOf(pid);
        if (!st) continue;
        const key = `${pid}:${st.startTime}`;
        const before = base?.get(key);
        out.push({
          pid,
          ...st,
          memBytes,
          sessionId,
          growthBytes: before === undefined ? memBytes : memBytes - before,
          cgroup: dir,
        });
      }
    }
    return out;
  };

  /** Record candidates' memory the first tick pressure is seen, for growth ranking. */
  const noteBaseline = (cgroup: string): void => {
    let base = baselines.get(cgroup);
    if (!base) {
      base = new Map();
      baselines.set(cgroup, base);
    }
    for (const c of candidatesIn(cgroup)) {
      const key = `${c.pid}:${c.startTime}`;
      if (!base.has(key)) base.set(key, c.memBytes);
    }
  };

  /** True when `pid`'s cgroup is `node` or below it (unreadable → false). */
  const insideNode = (pid: number, node: string): boolean => {
    const rel = node.slice(cgroupRoot.length);
    const line = (io.readText(`${procRoot}/${pid}/cgroup`) ?? "")
      .split("\n")
      .find(l => l.startsWith("0::"));
    const path = line?.slice(3).trim();
    return !!path && (path === rel || path.startsWith(`${rel}/`));
  };

  /**
   * The victim's whole process group when every member is an agent-run process
   * inside the node slice — a member moved out (e.g. a capped `systemd-run --scope`
   * run) is outside the watchdog's authority, so then only the victim is signalled.
   */
  const groupIsAllEligible = (pgrp: number, node: string): boolean => {
    if (pgrp <= 1) return false;
    let members = 0;
    for (const name of io.listDir(procRoot)) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const st = statOf(pid);
      if (!st || st.pgrp !== pgrp) continue;
      members++;
      if (
        !agentSessionFromEnviron(
          io.readText(`${procRoot}/${pid}/environ`) ?? ""
        ) ||
        !insideNode(pid, node)
      )
        return false;
    }
    return members > 0;
  };

  const describe = (
    cgroup: string,
    v: Candidate,
    verb: string,
    group: boolean,
    stallPct: number
  ): string =>
    `[SlicePressure] ${verb} pid ${v.pid} (${v.comm}${group ? `, process group ${v.pgrp}` : ""}) holding ${Math.round(v.memBytes / 1048576)} MiB (+${Math.round(v.growthBytes / 1048576)} MiB while stalled) in session ${v.sessionId}, ${v.pickedBy ?? "the chosen candidate"} — ${cgroup.split("/").pop()} stalled ${stallPct}% of the last ${config.windowMs / 1000} s at its memory limit (#6156)`;

  const tick = (): TickResult => {
    if (config.mode === "off") return { kind: "quiet" };
    const node = nodeSlicePath();
    if (!node || !holdLease()) {
      // A daemon that cannot see the node slice (containment off, another slice
      // name, no PSI) gives the lease up, so a daemon that can act takes it.
      if (!node) releaseLease();
      noteLeaseState(
        false,
        node ? null : "the node slice or its memory.pressure is not visible"
      );
      samples.clear();
      baselines.clear();
      return { kind: node ? "not-holder" : "no-slice" };
    }
    noteLeaseState(true, null);
    leaseWarned.clear();

    const watched = [
      node,
      ...walk(node).filter(d =>
        d.split("/").pop()?.startsWith(SESSION_SCOPE_PREFIX)
      ),
    ];
    const live = new Set(watched);
    for (const key of [...samples.keys()])
      if (!live.has(key)) samples.delete(key);
    for (const key of [...baselines.keys()])
      if (!live.has(key)) baselines.delete(key);

    let fired: { cgroup: string; stallPct: number } | null = null;
    const pressured: string[] = [];
    for (const cgroup of watched) {
      const s = sample(cgroup);
      if (!s) continue;
      const list = samples.get(cgroup) ?? [];
      list.push(s);
      // Keep just over one window of samples.
      while (list.length > 2 && s.at - list[1].at >= config.windowMs)
        list.shift();
      samples.set(cgroup, list);
      const event = cgroup === node ? "high" : "max";
      const sustained = isSustainedPressure(
        list,
        config.windowMs,
        config.stallFraction,
        event
      );
      // Track growth from the first tick pressure appears; forget it once pressure is gone.
      if (isPressureNow(list, config.stallFraction)) pressured.push(cgroup);
      else if (!sustained) baselines.delete(cgroup);
      if (!fired && sustained) {
        const first = list[0];
        fired = {
          cgroup,
          stallPct: Math.round(
            ((s.someTotalUs - first.someTotalUs) / ((s.at - first.at) * 1000)) *
              100
          ),
        };
      }
    }
    // Rank before this tick's baselines are recorded: a process first seen now has no
    // baseline yet, so it counts as having grown by its whole size, not by nothing.
    // That holds only where pressure was already being tracked; on the tick pressure
    // is first seen nothing has a baseline, so nothing is ranked until the next tick.
    // One clock read: the baseline reads below are slow under the very stall this
    // handles, and a deadline passing between two reads would rank nobody yet act.
    const coolingDown = now() < cooldownUntil;
    const firedCgroup = fired?.cgroup ?? null;
    const tracked = firedCgroup !== null && baselines.has(firedCgroup);
    const ranked = tracked && !coolingDown ? candidatesIn(firedCgroup) : [];
    for (const cgroup of pressured) noteBaseline(cgroup);
    if (!fired) {
      noVictimReported = false;
      return { kind: "quiet" };
    }
    if (coolingDown) return { kind: "cooldown" };
    if (!tracked) return { kind: "measuring", cgroup: fired.cgroup };

    const victim = pickVictim(ranked, cg =>
      parsePsiSomeAvg10(io.readText(`${cg}/memory.pressure`))
    );
    if (!victim) {
      cooldownUntil = now() + KILL_COOLDOWN_MS;
      const line = `[SlicePressure] ${fired.cgroup.split("/").pop()} is under sustained memory pressure but has no process to stop: no agent-run process of ${MIN_VICTIM_BYTES / 1048576} MiB or more grew while it stalled or sits in a scope that is stalling (#6156)`;
      logger.warn(line);
      if (!noVictimReported) {
        noVictimReported = true;
        logger.reportCaught(new Error(line), {
          category: "slice-pressure-watchdog",
          severity: "error",
        });
      }
      return { kind: "no-victim", cgroup: fired.cgroup };
    }
    const group = groupIsAllEligible(victim.pgrp, node);

    if (config.mode === "observe") {
      cooldownUntil = now() + KILL_COOLDOWN_MS;
      logger.warn(
        describe(
          fired.cgroup,
          victim,
          "would kill (observe mode)",
          group,
          fired.stallPct
        )
      );
      return { kind: "would-kill", cgroup: fired.cgroup, victim, group };
    }

    // The file's kills, plus any of this daemon's the file lacks (a failed write).
    const fileKills = readBudget();
    const missing = [...localKills];
    for (const t of fileKills) {
      const i = missing.indexOf(t);
      if (i >= 0) missing.splice(i, 1);
    }
    const kills = [...fileKills, ...missing].filter(
      t => now() - t < KILL_BUDGET_WINDOW_MS
    );
    if (kills.length >= KILL_BUDGET) {
      if (now() - lastBudgetAlarm >= KILL_BUDGET_WINDOW_MS) {
        lastBudgetAlarm = now();
        const line = `[SlicePressure] kill budget spent (${KILL_BUDGET} in ${KILL_BUDGET_WINDOW_MS / 60000} min); ${fired.cgroup.split("/").pop()} is still under sustained memory pressure and nothing more will be killed until the window rolls (#6156)`;
        logger.warn(line);
        logger.reportCaught(new Error(line), {
          category: "slice-pressure-watchdog",
          severity: "error",
        });
      }
      return { kind: "budget-exhausted", cgroup: fired.cgroup };
    }

    // Pid-reuse guard: the pid must still be the process we ranked.
    const again = statOf(victim.pid);
    if (!again || again.startTime !== victim.startTime) {
      return { kind: "no-victim", cgroup: fired.cgroup };
    }
    try {
      io.kill(group ? -victim.pgrp : victim.pid, "SIGKILL");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      cooldownUntil = now() + KILL_COOLDOWN_MS;
      const line = `[SlicePressure] could not kill pid ${victim.pid}: ${error} (#6156)`;
      logger.warn(line);
      logger.reportCaught(new Error(line), {
        category: "slice-pressure-watchdog",
        severity: "error",
        sessionId: victim.sessionId,
      });
      return { kind: "kill-failed", cgroup: fired.cgroup, victim, error };
    }
    cooldownUntil = now() + KILL_COOLDOWN_MS;
    // Every watched window starts over: the node slice and the session scopes
    // overlap, so a window that still held pre-kill stall would fire again after
    // the cooldown and kill a second process although the pressure is gone.
    samples.clear();
    baselines.clear();
    localKills = [...kills, now()];
    if (budgetPath) {
      try {
        io.writeText(budgetPath, JSON.stringify({ kills: localKills }));
      } catch (err) {
        // The in-memory copy still caps this daemon; another daemon cannot see it.
        logger.warn(`[SlicePressure] kill budget write failed: ${err}`);
      }
    }
    const line = describe(
      fired.cgroup,
      victim,
      "killed",
      group,
      fired.stallPct
    );
    logger.warn(line);
    logger.reportCaught(new Error(line), {
      category: "slice-pressure-watchdog",
      severity: "warn",
      sessionId: victim.sessionId,
    });
    return { kind: "killed", cgroup: fired.cgroup, victim, group };
  };

  return { config, tick, releaseLease };
}

/** Build and start the watchdog loop for this daemon (mirrors `createWorktreeCollector`). */
export function startSlicePressureWatchdog(
  ctx: DaemonContext,
  clockSeams: ClockSeams,
  deps: WatchdogDeps = {}
): { watchdogLoop: SupervisedLoop; stop: () => void } {
  const watchdog = createSlicePressureWatchdog({
    now: clockSeams.now,
    ...deps,
  });
  logger.info(
    `[SlicePressure] watchdog mode ${watchdog.config.mode} (window ${watchdog.config.windowMs / 1000} s, stall ${Math.round(watchdog.config.stallFraction * 100)}%) (#6156)`
  );
  const watchdogLoop = new SupervisedLoop({
    name: "slice-pressure-watchdog",
    node: ctx.daemonJobNode,
    intervalMs: WATCHDOG_INTERVAL_MS,
    registry: ctx.daemonJobRegistry,
    now: clockSeams.now,
    setTimeoutFn: clockSeams.setTimeoutFn,
    clearTimeoutFn: clockSeams.clearTimeoutFn,
    enabled: watchdog.config.mode !== "off",
    immediate: false,
    tick: () => {
      watchdog.tick();
    },
  });
  watchdogLoop.start();
  return {
    watchdogLoop,
    stop: () => {
      watchdogLoop.stop();
      watchdog.releaseLease();
    },
  };
}
