// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Memory-aware spawn admission (issue #6156, S4).
 *
 * The session cap (`effectiveCount >= max`, #4417) counts sessions; it was sized at
 * startup from the machine's memory and an idle-session coefficient. It does not see
 * how much memory is free right now, so a burst of spawns could pass on a node already
 * at its limit (ms1, 2026-11-02: seven spawns on top of five live sessions, then three
 * runaway jobs kept the sessions slice at `MemoryHigh` for 55 minutes).
 *
 * This gate refuses a FRESH spawn (`code: "insufficient_memory"`) when the memory left
 * for one more session is below a headroom. "Left" is the smaller of:
 * - `MemAvailable` from `/proc/meminfo` (the kernel's estimate, reclaimable cache included);
 * - the NODE sessions slice's effective limit minus its non-reclaimable use
 *   (`anon + shmem` from `memory.stat`). The node slice, not this instance's child,
 *   because prod, dev and the worktree instances share it. `memory.current` is not
 *   used: it includes page cache, which keeps a healthy slice near `MemoryHigh` and
 *   would refuse spawns that fit. `memory.swap.current` is added only while the slice
 *   is stalling on memory (`memory.pressure` `some avg10` at or above
 *   {@link SWAP_COUNTS_AT_STALL_PCT}): then swapped pages are demand being paged back
 *   in, but pages left in swap after an episode are cold, and `memory.high`/`max`
 *   bound RAM only, so counting them would refuse spawns that fit.
 *
 * Spawns this daemon accepted in the last 60 s reserve one open-session cost each
 * (`CAPACITY_COEFFICIENTS.pOpenBytes`), because a new session takes a minute to grow;
 * a spawn that then fails gives its reservation back (the spawner releases it).
 * Respawns and resumes are exempt (the caller decides). An input that cannot be read
 * is left out, with one warning per cause, and the gate decides on the other; with
 * neither readable it admits (fail-open): the gate must never block spawning on a
 * node whose files it cannot read.
 *
 * `HAPI_SPAWN_MEMORY_HEADROOM_MIB`: unset → 1024; `0` / `off` / `false` / `no` / `none`
 * → the gate is off; a positive integer → that many MiB.
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { trimTrailingChars } from "@hapi/protocol/trimChars";
import { logger } from "@/ui/logger";
import {
  DISABLE_TOKENS,
  nodeSliceCgroupDir,
  resolveSessionSliceConfig,
  resolveUid,
} from "@/tmux/sessionSlice";
import {
  CAPACITY_COEFFICIENTS,
  parseCgroupMemoryLimit,
} from "./sessionCapacity";

export const SPAWN_MEMORY_HEADROOM_ENV = "HAPI_SPAWN_MEMORY_HEADROOM_MIB";
export const DEFAULT_SPAWN_MEMORY_HEADROOM_MIB = 1024;
/** How long an accepted spawn keeps its memory reservation. */
export const RECENT_SPAWN_WINDOW_MS = 60_000;
/** The refusal code every hop forwards (#1262 field-by-field) and maps to HTTP 409. */
export const INSUFFICIENT_MEMORY_CODE = "insufficient_memory";
/** The node slice's `some avg10` stall (%) from which its swap counts as used memory. */
export const SWAP_COUNTS_AT_STALL_PCT = 10;

const MiB = 1024 * 1024;
/** One open session's memory — the #4417 coefficient, falling back to 512 MiB. */
const PER_SPAWN_BYTES = CAPACITY_COEFFICIENTS?.pOpenBytes ?? 512 * MiB;

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(message);
}

/** Test seam: forget logged warnings. */
export function resetMemoryAdmissionWarningsForTest(): void {
  warned.clear();
}

/** The headroom in bytes, or `null` when the gate is turned off. */
export function resolveSpawnMemoryHeadroomBytes(
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const raw = env[SPAWN_MEMORY_HEADROOM_ENV]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_SPAWN_MEMORY_HEADROOM_MIB * MiB;
  }
  if (DISABLE_TOKENS.has(raw.toLowerCase())) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * MiB;
  warnOnce(
    `bad-env:${raw}`,
    `[MemoryAdmission] ${SPAWN_MEMORY_HEADROOM_ENV}=${raw} is not a number of MiB or off; using ${DEFAULT_SPAWN_MEMORY_HEADROOM_MIB}`
  );
  return DEFAULT_SPAWN_MEMORY_HEADROOM_MIB * MiB;
}

/** `MemAvailable` from `/proc/meminfo` text, in bytes; `null` when absent. */
export function parseMemAvailable(text: string | null): number | null {
  if (text === null) return null;
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

/** `some avg10` (%) from a cgroup `memory.pressure`; `null` when absent. */
export function parsePsiSomeAvg10(text: string | null): number | null {
  if (text === null) return null;
  const m = /^some avg10=(\d+(?:\.\d+)?)/m.exec(text);
  return m ? Number(m[1]) : null;
}

/** Named counters from a cgroup `memory.stat`; a missing key is `null`. */
export function parseMemoryStat(
  text: string | null,
  keys: readonly string[]
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const key of keys) out[key] = null;
  if (text === null) return out;
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key in out && /^\d+$/.test(value ?? "")) out[key] = Number(value);
  }
  return out;
}

export interface MemoryAdmissionInputs {
  /** `MemAvailable`, or `null` when unreadable. */
  memAvailableBytes: number | null;
  /** The node slice's effective limit and non-reclaimable use, or `null` when absent. */
  slice: { limitBytes: number; usedBytes: number } | null;
}

export interface MemoryAdmissionDeps {
  env?: NodeJS.ProcessEnv;
  uid?: number | null;
  cgroupRoot?: string;
  meminfoPath?: string;
  readText?: (path: string) => string | null;
}

function readTextOrWarn(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warnOnce(
        `read:${path}`,
        `[MemoryAdmission] could not read ${path} (${code ?? String(err)}); spawns are admitted without it (#6156)`
      );
    }
    return null;
  }
}

/** Read the gate's inputs. Sync, cheap (a few small files), never throws. */
export function readMemoryAdmissionInputs(
  deps: MemoryAdmissionDeps = {}
): MemoryAdmissionInputs {
  const read = deps.readText ?? readTextOrWarn;
  const memAvailableBytes = parseMemAvailable(
    read(deps.meminfoPath ?? "/proc/meminfo")
  );

  const env = deps.env ?? process.env;
  const config = resolveSessionSliceConfig(env);
  const uid = resolveUid(deps.uid);
  if (!config.enabled || uid === null)
    return { memAvailableBytes, slice: null };

  const root = trimTrailingChars(deps.cgroupRoot ?? "/sys/fs/cgroup", "/");
  const node = nodeSliceCgroupDir(root, uid, config.slice);
  const stat = parseMemoryStat(read(`${node}/memory.stat`), ["anon", "shmem"]);
  if (stat.anon === null) return { memAvailableBytes, slice: null };

  // Smallest memory.high / memory.max on the node slice and its ancestors.
  let limitBytes: number | null = null;
  for (
    let dir = node;
    dir.startsWith(`${root}/`) && dirname(dir) !== dir;
    dir = dirname(dir)
  ) {
    for (const key of ["memory.high", "memory.max"]) {
      const v = parseCgroupMemoryLimit(read(`${dir}/${key}`));
      if (v !== null && (limitBytes === null || v < limitBytes)) limitBytes = v;
    }
  }
  if (limitBytes === null) return { memAvailableBytes, slice: null };

  // Swap counts only while the slice stalls (unreadable PSI: not counted, fail-open).
  const stallPct = parsePsiSomeAvg10(read(`${node}/memory.pressure`)) ?? 0;
  const swapText =
    stallPct >= SWAP_COUNTS_AT_STALL_PCT
      ? (read(`${node}/memory.swap.current`)?.trim() ?? "")
      : "";
  const swapBytes = /^\d+$/.test(swapText) ? Number(swapText) : 0;
  return {
    memAvailableBytes,
    slice: {
      limitBytes,
      usedBytes: (stat.anon ?? 0) + (stat.shmem ?? 0) + swapBytes,
    },
  };
}

export interface MemoryAdmissionDecision {
  admit: boolean;
  /** Memory left for one more session after reservations; `null` when unknown. */
  availableBytes: number | null;
  /** The headroom a spawn needs. */
  requiredBytes: number;
  /** Bytes reserved for spawns accepted in the last 60 s. */
  reservedBytes: number;
}

/** Pure decision: admit unless the memory left after reservations is below the headroom. */
export function evaluateMemoryAdmission(
  inputs: MemoryAdmissionInputs,
  opts: {
    headroomBytes: number;
    recentAccepted: number;
    perSpawnBytes?: number;
  }
): MemoryAdmissionDecision {
  const reservedBytes =
    Math.max(0, opts.recentAccepted) * (opts.perSpawnBytes ?? PER_SPAWN_BYTES);
  const candidates: number[] = [];
  if (inputs.memAvailableBytes !== null) {
    candidates.push(inputs.memAvailableBytes);
  }
  if (inputs.slice !== null) {
    candidates.push(inputs.slice.limitBytes - inputs.slice.usedBytes);
  }
  if (candidates.length === 0) {
    return {
      admit: true,
      availableBytes: null,
      requiredBytes: opts.headroomBytes,
      reservedBytes,
    };
  }
  const availableBytes = Math.min(...candidates) - reservedBytes;
  return {
    admit: availableBytes >= opts.headroomBytes,
    availableBytes,
    requiredBytes: opts.headroomBytes,
    reservedBytes,
  };
}

/** The refusal message every hop carries. */
export function formatInsufficientMemoryMessage(
  decision: MemoryAdmissionDecision
): string {
  const available = Math.max(
    0,
    Math.floor((decision.availableBytes ?? 0) / MiB)
  );
  const required = Math.ceil(decision.requiredBytes / MiB);
  return `Not enough free memory to start a session (${available} MiB available, ${required} MiB required). Stop an idle session or wait for a running job to finish.`;
}

/** Accepted fresh spawns within the reservation window. */
export function createSpawnReservations(now: () => number = Date.now) {
  let accepted: number[] = [];
  const prune = (): void => {
    const cutoff = now() - RECENT_SPAWN_WINDOW_MS;
    accepted = accepted.filter(t => t > cutoff);
  };
  return {
    /** Reserve for one admitted spawn; the returned function drops it again. */
    record(): () => void {
      prune();
      const at = now();
      accepted.push(at);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const i = accepted.indexOf(at);
        if (i >= 0) accepted.splice(i, 1);
      };
    },
    count(): number {
      prune();
      return accepted.length;
    },
  };
}

/**
 * The gate as the spawner calls it: `null` when the spawn is admitted (or the gate is
 * off), else the refusal decision.
 */
export function checkSpawnMemoryAdmission(opts: {
  recentAccepted: number;
  deps?: MemoryAdmissionDeps;
}): MemoryAdmissionDecision | null {
  const headroomBytes = resolveSpawnMemoryHeadroomBytes(opts.deps?.env);
  if (headroomBytes === null) return null;
  const decision = evaluateMemoryAdmission(
    readMemoryAdmissionInputs(opts.deps),
    { headroomBytes, recentAccepted: opts.recentAccepted }
  );
  return decision.admit ? null : decision;
}
