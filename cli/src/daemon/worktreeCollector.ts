// SPDX-License-Identifier: MIT
/**
 * `worktreeCollector` — the daily 05:00-local expired-worktree trash collector
 * (issue #3451). Before this, `purgeExpiredWorktrees` ran ONLY at worktree-spawn
 * time (via `kickExpiredWorktreePurge`), so a repo that stopped spawning never
 * purged its `.trash` — the 2026-09-01 audit found 8 idle repos carrying expired
 * entries (e.g. `/mnt/netshare/git/nfv-review/.worktrees/.trash`).
 *
 * This module reuses the daemon's `SupervisedLoop` primitive (mirrors
 * `createHealthScheduler`), NOT a new timer: its `getIntervalMs` dynamic-interval
 * returns "ms until the next 05:00 local", so the loop re-arms daily. It gets the
 * stall watchdog + registry telemetry for free.
 *
 * DARK SHIP (B-D11 = A): the collector ships OPT-IN. `enabled` requires
 * `HAPI_WORKTREE_COLLECTOR === "1"` AND that the daemon is not itself a
 * `hapimatic-wt-<port>-daemon`. Exactly ONE daemon per node is expected to carry
 * the env (the prod unit) — because prod (3008), dev (3009) and every worktree
 * daemon run the SAME binary with no role gate, and `expiredWorktreePurgeInFlight`
 * (worktree.ts) is module-scoped (process-local), so an ungated fleet would wake
 * N daemons at 05:00 and run N overlapping `git worktree remove` / `branch -D`
 * against one shared `.git/`. The enablement gate — not the single-flight map — is
 * the cross-process correctness fix; the 0–30 min jitter is load-spreading only.
 *
 * Watchdog horizon: with `intervalMs = 24h`, `SupervisedLoop`'s watchdog checks
 * every `max(1000, intervalMs)` and flags a stall at `stallFactor × max(intervalMs,
 * lastDelayMs)` = 3 × 24h (`supervisedLoop.ts`). A hung tick is therefore only
 * detected after ~72h, and restarted only after the hang ceiling
 * (`hangFactor` 6 × 24h ≈ 144h, #4060) — which is why EVERY filesystem call and per-root kick in
 * this module carries its own short timeout (a hard `cache=none` CIFS mount can
 * block a bare `fs.readdir`/`stat` in uninterruptible D state with no error path).
 */
import { readFileSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { SupervisedLoop } from "@hapi/protocol";

import { logger } from "@/ui/logger";
import type { ClockSeams, DaemonContext } from "./daemonContext";
import { detectSelfUnitName } from "./systemdInvariants";
import { kickExpiredWorktreePurge } from "./worktree";
import { resolveWorktreeHostBase } from "./worktreeHostBase";

/** Trash holding dir name — mirrors the module-private const in worktree.ts. */
const TRASH_DIR_NAME = ".trash";
/** Parent of every CIFS-mounted repo root the daemon may own. */
const NETSHARE_GIT_PARENT = "/mnt/netshare/git";
/** Default per-op filesystem/kick timeout (see the watchdog-horizon note above). */
const DEFAULT_FS_TIMEOUT_MS = 30_000;
/** Suppress a `getIntervalMs`-early double tick within this window (1B #3451-15). */
const RETICK_GUARD_MS = 60 * 60 * 1000;
/** Daily target: 05:00 local wall-clock. */
const COLLECTOR_HOUR = 5;
const COLLECTOR_MINUTE = 0;
/** Max jitter added to the daily delay (load-spreading only, not correctness). */
const MAX_JITTER_MS = 30 * 60 * 1000;

/**
 * Test seams for hermetic collector tests. Every field is optional; production
 * passes none and the real fs / global timers / `kickExpiredWorktreePurge` /
 * `/proc/self/cgroup` are used.
 */
export interface CollectorSeams {
  /** Directory listing (defaults to `fs/promises.readdir`). */
  readdirFn?: (path: string) => Promise<string[]>;
  /** Existence probe (defaults to `fs/promises.stat`; only resolve/throw matters). */
  statFn?: (path: string) => Promise<unknown>;
  /** Per-root purge kick (defaults to `kickExpiredWorktreePurge`). */
  kickFn?: (repoRoot: string) => Promise<number>;
  /**
   * `/proc/self/cgroup` text for the wt-daemon self-skip. `undefined` ⇒ read
   * `/proc` (production); an explicit string/`null` overrides it (tests never
   * touch `/proc`).
   */
  cgroupText?: string | null;
  /** Per-op timeout in ms (defaults to {@link DEFAULT_FS_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Injectable `setTimeout` for the timeout race (defaults to the global). */
  setTimeoutFn?: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>;
  /** Injectable `clearTimeout` for the timeout race (defaults to the global). */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/** Distinguishable timeout so callers can report a HANG but stay silent on ENOENT. */
class CollectorTimeoutError extends Error {
  constructor(op: string) {
    super(`collector op timed out: ${op}`);
    this.name = "CollectorTimeoutError";
  }
}

function reportCollectorWarn(message: string): void {
  logger.reportError({
    message: `[worktree-collector] ${message}`,
    category: "daemon-worktree-collector",
    severity: "warn",
  });
}

/**
 * Race `work` against a timeout. On timeout, reject with a
 * {@link CollectorTimeoutError} (so a caller can distinguish a HANG, which is
 * reported, from a plain ENOENT, which is the normal filter path and stays
 * silent). The underlying work's own error propagates unchanged.
 */
async function raceTimeout<T>(
  work: Promise<T>,
  op: string,
  timeoutMs: number,
  setTimeoutFn: (
    handler: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout>,
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeoutFn(
      () => reject(new CollectorTimeoutError(op)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== null) clearTimeoutFn(timer);
  }
}

/**
 * Milliseconds from `nowMs` until the next `hour:minute` in LOCAL wall-clock.
 * DST-safe: builds a local `Date` and advances by one calendar day (via
 * `setDate`) rather than adding a fixed 86_400_000 ms, so a spring-forward /
 * fall-back day does not drift the target hour. When `nowMs` is exactly at the
 * target, returns ~24h (tomorrow) — never 0 — so the loop does not re-fire at the
 * same instant. Exported for direct unit testing.
 */
export function msUntilNextLocal(
  hour: number,
  minute: number,
  nowMs: number
): number {
  const next = new Date(nowMs);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= nowMs) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - nowMs;
}

/**
 * True iff this process is a `hapimatic-wt-<port>-daemon` systemd unit. Mirrors
 * the read posture of `runSystemdInvariantsCheck`: non-linux or an unreadable
 * cgroup ⇒ `false` (not a wt daemon). A test injects `cgroupText` via the seam so
 * it never touches `/proc`. Exported for the machine-rotator role (#4423), which
 * keeps every worktree daemon out of proactive credential rotation.
 */
export function runningInsideWorktreeInstanceDaemon(
  cgroupTextSeam?: string | null
): boolean {
  let cgroupText: string | null;
  if (cgroupTextSeam !== undefined) {
    cgroupText = cgroupTextSeam;
  } else if (process.platform !== "linux") {
    return false;
  } else {
    try {
      cgroupText = readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return false;
    }
  }
  if (!cgroupText) return false;
  const unit = detectSelfUnitName(cgroupText);
  return unit !== null && /^hapimatic-wt-\d+-daemon\.service$/.test(unit);
}

/**
 * Discover the deduped set of repo **ROOTS** (directories containing `.git`)
 * whose `.worktrees/.trash` should be swept.
 *
 * 🔴 Contract: this returns REPO ROOTS, never host bases. `purgeExpiredWorktrees`
 * and `kickExpiredWorktreePurge` (worktree.ts) take a repo root and map it through
 * `resolveWorktreeHostBase` THEMSELVES; pre-mapping here would either double-map
 * to `<hostBase>/.worktrees/.worktrees/.trash` (readdir throws → silent skip) or
 * make git walk UP from a plain host-base dir and kick the WRONG repo. This is the
 * exact bug behind all 12 historical prod `daemon-worktree-purge` "fatal: not a
 * git repository" rows (issue body). `resolveWorktreeHostBase` appears in this
 * file ONLY in the `.trash`-existence filter below — the returned value is always
 * the unmapped candidate.
 *
 * Candidates: `HAPI_WORKTREE_COLLECTOR_ROOTS` (colon-separated, B-D12 = A) ∪
 * `homedir()` (owns `~/.worktrees/.trash`) ∪ each `~/projects/*` ∪ each
 * `/mnt/netshare/git/*`. A candidate is KEPT iff BOTH `<root>/.git` exists AND
 * `resolveWorktreeHostBase(root)/.worktrees/.trash` exists — that filter is what
 * keeps non-repo directories out (each would otherwise reproduce the "not a git
 * repository" failure once per day). Dedupe by realpath (the kick re-dedupes on
 * the resolved repo root, so a residual collision merely double-counts telemetry).
 * Never throws: a missing parent ⇒ silent skip; a genuine CIFS timeout ⇒ skip +
 * one `daemon-worktree-collector` report.
 */
export async function discoverWorktreeRoots(
  seams: CollectorSeams = {}
): Promise<string[]> {
  const readdirFn = seams.readdirFn ?? (path => readdir(path));
  const statFn = seams.statFn ?? (path => stat(path));
  const timeoutMs = seams.timeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
  const setTimeoutFn =
    seams.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn =
    seams.clearTimeoutFn ?? (handle => clearTimeout(handle));

  const raceStat = (path: string): Promise<unknown> =>
    raceTimeout(
      Promise.resolve().then(() => statFn(path)),
      `stat ${path}`,
      timeoutMs,
      setTimeoutFn,
      clearTimeoutFn
    );
  const raceReaddir = (path: string): Promise<string[]> =>
    raceTimeout(
      Promise.resolve().then(() => readdirFn(path)),
      `readdir ${path}`,
      timeoutMs,
      setTimeoutFn,
      clearTimeoutFn
    );

  // List a parent's direct children as absolute paths. Missing parent (ENOENT) ⇒
  // silent []; a hang ⇒ [] + one report.
  const childDirs = async (parent: string): Promise<string[]> => {
    try {
      const entries = await raceReaddir(parent);
      return entries.map(name => join(parent, name));
    } catch (err) {
      if (err instanceof CollectorTimeoutError) {
        reportCollectorWarn(
          `readdir ${parent} timed out — skipping its children`
        );
      }
      return [];
    }
  };

  // 1. Raw candidate list.
  const candidates: string[] = [];
  const envRoots = (process.env.HAPI_WORKTREE_COLLECTOR_ROOTS ?? "")
    .split(":")
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => resolve(s));
  candidates.push(...envRoots);
  candidates.push(homedir());
  candidates.push(...(await childDirs(join(homedir(), "projects"))));
  candidates.push(...(await childDirs(NETSHARE_GIT_PARENT)));

  // 2. Filter: keep iff `<root>/.git` exists (a .git FILE is fine — a linked
  //    worktree; the kick's resolveRepoRoot maps it to the main repo) AND the
  //    (possibly relocated) host base has a `.worktrees/.trash`.
  const kept: string[] = [];
  for (const cand of candidates) {
    try {
      await raceStat(join(cand, ".git"));
    } catch (err) {
      if (err instanceof CollectorTimeoutError) {
        reportCollectorWarn(`stat ${join(cand, ".git")} timed out — skipping`);
      }
      continue; // no .git (ENOENT) is the normal filter path — stay silent
    }
    const trashPath = join(
      resolveWorktreeHostBase(cand),
      ".worktrees",
      TRASH_DIR_NAME
    );
    try {
      await raceStat(trashPath);
    } catch (err) {
      if (err instanceof CollectorTimeoutError) {
        reportCollectorWarn(`stat ${trashPath} timed out — skipping`);
      }
      continue; // no .trash (ENOENT) ⇒ nothing to sweep here — stay silent
    }
    kept.push(cand);
  }

  // 3. Dedupe by realpath (fall back to resolve); return the UNMAPPED candidate.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const root of kept) {
    let key: string;
    try {
      key = await realpath(root);
    } catch {
      key = resolve(root);
    }
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(root);
    }
  }
  return deduped;
}

/**
 * Build + start the daily worktree-trash collector `SupervisedLoop` bound to
 * `ctx`. Mirrors `createHealthScheduler`: constructs the loop, `start()`s it, and
 * returns the handle so `run.ts` wires it into the `onReady` handles and stops it
 * in `cleanupAndShutdown`. Inert unless enabled (see the module docstring's DARK
 * SHIP note) — a disabled loop still REGISTERS as `"stopped"` and is visible in
 * the job registry.
 *
 * NOTE for #3210: this is the epic's ONLY periodic scheduler. #3210 registers no
 * loop of its own; if it later wants a periodic orphaned-unit sweep it may add a
 * `kickOrphanedUnitSweep(root)` call inside this tick's per-root loop. Do NOT add
 * that call here today, and do NOT make this module depend on #3210.
 */
export function createWorktreeCollector(
  ctx: DaemonContext,
  clockSeams: ClockSeams,
  seams: CollectorSeams = {}
): { collectorLoop: SupervisedLoop } {
  const now = clockSeams.now ?? (() => Date.now());

  // Enablement gate (B-D11 = A). The env is the primary gate; the wt-daemon
  // self-skip is belt-and-suspenders (a wt daemon inherits neither
  // HAPI_WORKTREE_COLLECTOR nor the #1558 relocation knobs through
  // `systemd-run --setenv`, so it would compute non-relocated trash paths).
  const enabled =
    process.env.HAPI_WORKTREE_COLLECTOR === "1" &&
    !runningInsideWorktreeInstanceDaemon(seams.cgroupText);

  // Jitter computed ONCE (per-process constant). Load-spreading only if a second
  // daemon is ever wrongly enabled — NOT correctness (a CIFS purge can outlast the
  // gap; the enablement gate is the correctness fix).
  const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);

  const kickFn = seams.kickFn ?? kickExpiredWorktreePurge;
  const timeoutMs = seams.timeoutMs ?? DEFAULT_FS_TIMEOUT_MS;
  const setTimeoutFn =
    seams.setTimeoutFn ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimeoutFn =
    seams.clearTimeoutFn ?? (handle => clearTimeout(handle));

  let lastTickStartedAt: number | null = null;

  const tick = async (): Promise<void> => {
    // Re-tick guard (1B #3451-15): `scheduleNext` re-arms with
    // `Math.max(1, getIntervalMs())`, so a timer firing microseconds early yields
    // a ~1ms re-arm and a second sweep. Harmless (purge is idempotent +
    // single-flighted) but it doubles telemetry — suppress it.
    const startedAt = now();
    if (
      lastTickStartedAt !== null &&
      startedAt - lastTickStartedAt < RETICK_GUARD_MS
    ) {
      return;
    }
    lastTickStartedAt = startedAt;

    const roots = await discoverWorktreeRoots(seams);
    for (const root of roots) {
      // Sequential (never Promise.all) — one slow CIFS root must not multiply
      // concurrent git work. Timeout-raced so a hung kick cannot approach the
      // 3×24h watchdog horizon. `kickExpiredWorktreePurge` coalesces with any
      // concurrent spawn kick via `expiredWorktreePurgeInFlight` (#2450) and never
      // rejects, so the race guards only against a hang. One bad root never aborts
      // the sweep.
      try {
        await raceTimeout(
          Promise.resolve().then(() => kickFn(root)),
          `kick ${root}`,
          timeoutMs,
          setTimeoutFn,
          clearTimeoutFn
        );
      } catch (err) {
        reportCollectorWarn(
          `kick ${root} failed or timed out: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  };

  const collectorLoop = new SupervisedLoop({
    name: "worktree-trash-collector",
    node: ctx.daemonJobNode,
    // Nominal cadence for the registry + watchdog lower bound; the real delay is
    // the dynamic daily-05:00 interval below.
    intervalMs: 24 * 60 * 60 * 1000,
    getIntervalMs: () =>
      msUntilNextLocal(COLLECTOR_HOUR, COLLECTOR_MINUTE, now()) + jitterMs,
    registry: ctx.daemonJobRegistry,
    // #2079 clock seams — undefined in production ⇒ SupervisedLoop uses globals.
    now: clockSeams.now,
    setTimeoutFn: clockSeams.setTimeoutFn,
    clearTimeoutFn: clockSeams.clearTimeoutFn,
    enabled,
    immediate: false,
    tick,
  });
  collectorLoop.start();

  return { collectorLoop };
}
