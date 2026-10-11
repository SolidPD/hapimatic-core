// SPDX-License-Identifier: MIT
/**
 * sessionCapacity — the pure RAM/CPU → session-count capacity module (#4417, Task 3).
 *
 * Produces a node's `{ recommended, max }` open-session counts from either a per-tier
 * JSON entry (the `~/.config/hapimatic/vm-tier` marker) or, failing that, a formula over
 * the machine's usable RAM and CPU. Core v1 runs on any OS, so a tier name alone is not
 * enough — the derived formula is the OS-independent fallback.
 *
 * Phase 1 shipped this module inert (`CAPACITY_COEFFICIENTS` null, no tier session fields).
 * Phase 2 filled the ONE coefficient constant from the measured load-test record
 * (docs/internal/research/issue-4417-machine-spec-load-test.md) and the per-tier
 * `recommended_sessions` / `max_sessions` fields, so a node with no env or Preferences cap
 * now resolves from its tier marker (capped at the formula on its real inputs, #4754) or,
 * without one, from the formula below.
 *
 * This module does only cheap process-stable reads (os.totalmem / constrainedMemory /
 * availableParallelism, cached) plus a tiny marker file read; it holds no daemon state.
 */
import * as os from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MAX_CONCURRENCY_DEFAULT } from "@hapi/protocol/schemas";
// Build-time import of the tier menu (cli tsconfig `rootDir: ".."` + resolveJsonModule).
// `shared/` cannot import it (rootDir), which is why this lives in cli/daemon.
import vmTiersJson from "../../../scripts/lib/vm-tiers.json";

/**
 * A tier row from scripts/lib/vm-tiers.json. `recommended_sessions` / `max_sessions`
 * are OPTIONAL until Task 2 (phase 2) fills them from the measured record — so in phase
 * 1 every tier yields `null` from {@link tierSessionCounts}.
 */
export interface VmTierShape {
  label?: string;
  ocpus: number;
  memory_gb: number;
  boot_volume_gb?: number;
  est_monthly_usd?: number;
  recommended_sessions?: number;
  max_sessions?: number;
}

/** Which resolver layer decided the live cap (wire vocabulary, shared with the server). */
export type CapSource = "env" | "settings" | "tier" | "derived" | "default";

/** A node's recommended (warn-at) and max (refuse-at) open-session counts. */
export interface SessionCounts {
  recommended: number;
  max: number;
}

/**
 * The fitted formula coefficients. Two `R0` constants because
 * `process.constrainedMemory()` returns the cgroup limit on a limited host:
 * - `r0CgroupBytes` — when the memory input IS the daemon's cgroup limit, only the
 *   daemon + its MCP servers + the tmux server share that budget (the Hapimatic server
 *   is a separate unit and is NOT in it).
 * - `r0MachineBytes` — when the input is whole-machine memory, `R0` covers the server,
 *   the daemon, MCP servers and the OS baseline.
 */
export interface CapacityCoefficients {
  r0CgroupBytes: number;
  r0MachineBytes: number;
  /** Bytes per open session at the hard max (`P_open`). */
  pOpenBytes: number;
  /** Bytes per session at the recommended mix (`P_mix`). */
  pMixBytes: number;
  /** Recommended sessions per CPU (`k_rec`). */
  kRec: number;
  /** Max sessions per CPU (`k_max`). */
  kMax: number;
}

const MiB = 1024 * 1024;

/**
 * The measured coefficients (#4417 phase 2; the record is
 * docs/internal/research/issue-4417-machine-spec-load-test.md). This is the SINGLE place a
 * coefficient lives; nothing else hardcodes one.
 *
 * - `pOpenBytes` 190 MiB: memory (MemTotal - MemAvailable) per open idle session — 180 MiB on
 *   the standard VM, 187 MiB on the pro VM (least-squares slopes, R² ≥ 0.995), rounded up.
 *   A bare session (no MCP or LSP children); a real session measured about 556 MiB (research
 *   record §10, #4754).
 * - `pMixBytes` 432 MiB: the same slope when sessions rotate idle / tool work / builds.
 * - `r0MachineBytes` 1.5 GiB: the fixed cost before any session (OS, server, daemon). With it
 *   the formula reproduces the measured maxima (lite 12, standard 33).
 * - `r0CgroupBytes` 512 MiB: the daemon and its tmux server inside the daemon unit's limit.
 * - `kRec` 3: the pro VM held 12 sessions on 4 CPUs under that mix before step latency doubled.
 * - `kMax` 17: no idle ramp was CPU-bound (standard held 33 idle sessions on 2 CPUs).
 */
export const CAPACITY_COEFFICIENTS: CapacityCoefficients | null = {
  r0CgroupBytes: 512 * MiB,
  r0MachineBytes: 1536 * MiB,
  pOpenBytes: 190 * MiB,
  pMixBytes: 432 * MiB,
  kRec: 3,
  kMax: 17,
};

/**
 * Marker-sanity tolerance: ignore the vm-tier marker (fall through to the derived layer)
 * when the tier's `memory_gb` exceeds the MACHINE's total memory by more than this. A
 * marker one tier too high always differs by far more (8 vs 4, 16 vs 8, 24 vs 16 GB), so
 * 25% cleanly rejects a stale/wrong marker while trusting a correct one. Re-checked in
 * phase 2 against each shape's recorded `MemTotal`.
 */
export const MARKER_MEMORY_TOLERANCE_PCT = 25;

/**
 * Tier-guard memory tolerance (#4754): a trusted marker's counts are capped at the formula
 * on the machine's real inputs, with the memory input raised by this percentage. MemTotal
 * drifts by megabytes across boots and images (lite read 3,991,068 kB before its reboot
 * and 3,988,960 kB after), while the fit leaves lite's 12 and standard's 33 only 81.5 and
 * 109 MiB above the point where the formula drops a session — and those maxima were
 * I/O-limited, not memory-limited (research record §4.2, §5). With 5%, lite keeps 12 down
 * to 3,635 MiB and standard keeps 33 down to 7,435 MiB.
 */
export const TIER_GUARD_MEMORY_TOLERANCE_PCT = 5;

const VM_TIER_MARKER = join(homedir(), ".config", "hapimatic", "vm-tier");
const BYTES_PER_GIB = 1024 * 1024 * 1024;

/** Hard ceiling for any resolved count — mirrors the daemon clamp (#1805 KD-3). */
export function resolveCeiling(): number {
  const n = parseInt(process.env.HAPI_MAX_CONCURRENT_CEILING || "50", 10);
  return Number.isFinite(n) && n >= 1 ? n : 50;
}

/** Clamp a count to `[1, ceiling]`; a non-finite value falls back to the default. */
export function clampCount(
  n: number,
  ceiling: number = resolveCeiling()
): number {
  if (!Number.isFinite(n)) return MAX_CONCURRENCY_DEFAULT;
  return Math.min(Math.max(1, ceiling), Math.max(1, Math.floor(n)));
}

/**
 * Resolve the CPU count the formula keys on. ALWAYS `os.availableParallelism()`, never
 * `os.cpus().length` (Node docs: `cpus()` may be empty and must not be used for
 * parallelism — https://nodejs.org/api/os.html). Never returns < 1.
 */
export function resolveCpus(): number {
  const fn = (os as { availableParallelism?: () => number })
    .availableParallelism;
  const n = typeof fn === "function" ? fn() : 0;
  return n >= 1 ? n : 1;
}

/** Machine inputs for the formula — process-stable, so computed once and cached. */
export interface MachineInputs {
  /** The memory the formula keys on: `min(totalmem, constrainedMemory || ∞)`. */
  memBytes: number;
  /** `os.availableParallelism()`. */
  cpus: number;
  /** `os.totalmem()` — used by the marker-sanity check (NOT the cgroup-limited value). */
  machineMemBytes: number;
  /** True when `memBytes` is a cgroup limit (`constrainedMemory < totalmem`). */
  memInputIsCgroupLimited: boolean;
}

let machineInputsCache: MachineInputs | null = null;

/**
 * Read + cache the machine's formula inputs. `process.constrainedMemory()` returns
 * `min(memory.high, memory.max)` under a systemd scope on Bun (verified 1.4.0), or
 * `os.totalmem()` with no limit — so `memBytes = min(totalmem, constrainedMemory || ∞)`
 * and the input is cgroup-limited exactly when it comes in below `totalmem`.
 */
export function computeMachineInputs(): MachineInputs {
  if (machineInputsCache) return machineInputsCache;
  const totalmem = os.totalmem();
  const constrainedFn = (process as { constrainedMemory?: () => number })
    .constrainedMemory;
  const constrained = typeof constrainedFn === "function" ? constrainedFn() : 0;
  const memInputIsCgroupLimited = constrained > 0 && constrained < totalmem;
  const memBytes = memInputIsCgroupLimited ? constrained : totalmem;
  machineInputsCache = {
    memBytes,
    cpus: resolveCpus(),
    machineMemBytes: totalmem,
    memInputIsCgroupLimited,
  };
  return machineInputsCache;
}

/** Test-only: drop the cached machine inputs so a test can re-stub `os`/`process`. */
export function resetMachineInputsCache(): void {
  machineInputsCache = null;
}

/** The parsed tier menu (`{ tiers: { <name>: VmTierShape } }`). */
const VM_TIERS = vmTiersJson as unknown as {
  tiers: Record<string, VmTierShape>;
};

/** Read the VM tier name: `HAPI_VM_TIER` env wins, else the marker file, else undefined.
 *  Mirrors `server/src/web/desktopProxy.ts` `readVmTier()` exactly. */
export function readVmTierName(): string | undefined {
  const env = process.env.HAPI_VM_TIER?.trim().toLowerCase();
  if (env) return env;
  try {
    const t = readFileSync(VM_TIER_MARKER, "utf8").trim().toLowerCase();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Look up a tier row by name from the build-time menu; `null` when unknown/absent. */
export function lookupVmTier(name: string | undefined): VmTierShape | null {
  if (!name) return null;
  return VM_TIERS.tiers[name] ?? null;
}

/**
 * The TIER layer: a tier's own `recommended_sessions` / `max_sessions`, when BOTH are
 * present (`null` for a tier row without them). Clamped, with `recommended ≤ max` enforced.
 */
export function tierSessionCounts(
  tier: VmTierShape | null | undefined,
  ceiling: number = resolveCeiling()
): SessionCounts | null {
  if (!tier) return null;
  const rec = tier.recommended_sessions;
  const max = tier.max_sessions;
  if (typeof rec !== "number" || typeof max !== "number") return null;
  const clampedMax = clampCount(max, ceiling);
  const clampedRec = Math.min(clampCount(rec, ceiling), clampedMax);
  return { recommended: clampedRec, max: clampedMax };
}

/**
 * True when the tier marker is sane to trust: its `memory_gb` does not exceed the
 * MACHINE's total memory beyond the tolerance. When `machineMemBytes` is unknown
 * (`≤ 0`) the check is skipped (trust — defensive; a machine with unknown memory should
 * not silently discard its marker).
 */
export function markerTierIsSane(
  tier: VmTierShape | null | undefined,
  machineMemBytes: number,
  tolerancePct: number = MARKER_MEMORY_TOLERANCE_PCT
): boolean {
  if (!tier || typeof tier.memory_gb !== "number") return false;
  if (!(machineMemBytes > 0)) return true;
  const tierBytes = tier.memory_gb * BYTES_PER_GIB;
  return tierBytes <= machineMemBytes * (1 + tolerancePct / 100);
}

/**
 * The DERIVED layer: the pure RAM/CPU formula. `null` only when the formula cannot be
 * evaluated: no or broken coefficients, an unknown memory input (`memBytes ≤ 0` or not
 * finite) or no CPU — the resolver then falls back to the default. A known machine whose
 * memory is at or below the reserve `R0` yields one session, never `null` (#4754 S2): the
 * cap must not rise as memory falls, and a 2 GiB machine already resolves to a max of 2.
 */
export function deriveFromFormula(
  memBytes: number,
  cpus: number,
  memInputIsCgroupLimited: boolean,
  coeffs: CapacityCoefficients | null,
  ceiling: number = resolveCeiling()
): SessionCounts | null {
  if (!coeffs) return null;
  if (
    !(memBytes > 0) ||
    !Number.isFinite(memBytes) ||
    !(cpus >= 1) ||
    !(coeffs.pOpenBytes > 0) ||
    !(coeffs.pMixBytes > 0)
  ) {
    return null;
  }
  const r0 = memInputIsCgroupLimited
    ? coeffs.r0CgroupBytes
    : coeffs.r0MachineBytes;
  const usable = memBytes - r0;
  if (usable <= 0) {
    // Below the reserve one session fits — never the flat default (#4754 S2).
    const one = clampCount(1, ceiling);
    return { recommended: one, max: one };
  }
  const maxMem = Math.floor(usable / coeffs.pOpenBytes);
  const recMem = Math.floor(usable / coeffs.pMixBytes);
  const recCpu = Math.floor(cpus * coeffs.kRec);
  const maxCpu = Math.floor(cpus * coeffs.kMax);
  const recommended = clampCount(Math.min(recMem, recCpu), ceiling);
  const max = clampCount(
    Math.max(Math.min(maxMem, maxCpu), recommended),
    ceiling
  );
  return { recommended, max };
}

/** Inputs to {@link deriveCapacity} / {@link resolveTierOrDerived}. */
export interface DeriveCapacityInput {
  memBytes: number;
  cpus: number;
  /** The resolved tier row (from the marker), if any. */
  tier?: VmTierShape | null;
  /** `os.totalmem()` — for the marker-sanity check. Omit to skip the check (trust). */
  machineMemBytes?: number;
  /** True when `memBytes` is a cgroup limit → selects `r0CgroupBytes`. */
  memInputIsCgroupLimited?: boolean;
  ceiling?: number;
  tolerancePct?: number;
}

/**
 * Resolve the tier-or-derived capacity AND report which layer produced it. A sane tier
 * with session fields wins, capped field by field at the formula on the machine's real
 * inputs (#4754); otherwise the formula; otherwise `null`. Source `"derived"` therefore
 * means the formula decided at least one count — either no trusted marker, or a marker
 * lowered by the real inputs. This is what the daemon resolver (Task 4) composes between
 * `settings` and `default`.
 */
export function resolveTierOrDerived(
  input: DeriveCapacityInput,
  coeffs: CapacityCoefficients | null = CAPACITY_COEFFICIENTS
): { counts: SessionCounts; source: "tier" | "derived" } | null {
  const ceiling = input.ceiling ?? resolveCeiling();
  const memInputIsCgroupLimited = !!input.memInputIsCgroupLimited;
  const tierTrusted =
    input.tier != null &&
    markerTierIsSane(
      input.tier,
      input.machineMemBytes ?? 0,
      input.tolerancePct ?? MARKER_MEMORY_TOLERANCE_PCT
    );
  const tierCounts = tierTrusted
    ? tierSessionCounts(input.tier, ceiling)
    : null;
  if (tierCounts) {
    // The drift invariant (tier max ≤ formula), enforced at runtime on the real inputs: a
    // VM provisioned with fewer CPUs or a lower unit limit than its tier cannot advertise
    // the tier's counts. Same ceiling on both sides, so a lowered ceiling clamps both alike.
    const guard = deriveFromFormula(
      input.memBytes * (1 + TIER_GUARD_MEMORY_TOLERANCE_PCT / 100),
      input.cpus,
      memInputIsCgroupLimited,
      coeffs,
      ceiling
    );
    if (!guard) return { counts: tierCounts, source: "tier" };
    const counts: SessionCounts = {
      recommended: Math.min(tierCounts.recommended, guard.recommended),
      max: Math.min(tierCounts.max, guard.max),
    };
    const lowered =
      counts.recommended < tierCounts.recommended ||
      counts.max < tierCounts.max;
    return { counts, source: lowered ? "derived" : "tier" };
  }
  const derived = deriveFromFormula(
    input.memBytes,
    input.cpus,
    memInputIsCgroupLimited,
    coeffs,
    ceiling
  );
  if (derived) return { counts: derived, source: "derived" };
  return null;
}

/**
 * Directive-named convenience entry: the tier-or-derived counts only (no source).
 * `null` only when neither a sane tier row nor the formula yields.
 */
export function deriveCapacity(
  input: DeriveCapacityInput,
  coeffs: CapacityCoefficients | null = CAPACITY_COEFFICIENTS
): SessionCounts | null {
  return resolveTierOrDerived(input, coeffs)?.counts ?? null;
}

/**
 * The daemon-facing resolver step: read the live marker + cached machine inputs and
 * return the tier-or-derived capacity with its source. When it returns `null` (no
 * coefficients, or an unknown memory input — a machine below the reserve yields one
 * session, #4754), the Task 4 resolver falls through to `MAX_CONCURRENCY_DEFAULT`. The
 * marker is sanity-checked against `os.totalmem()`.
 */
export function resolveDerivedCapacity(
  coeffs: CapacityCoefficients | null = CAPACITY_COEFFICIENTS
): { counts: SessionCounts; source: "tier" | "derived" } | null {
  const inputs = computeMachineInputs();
  const tier = lookupVmTier(readVmTierName());
  return resolveTierOrDerived(
    {
      memBytes: inputs.memBytes,
      cpus: inputs.cpus,
      tier,
      machineMemBytes: inputs.machineMemBytes,
      memInputIsCgroupLimited: inputs.memInputIsCgroupLimited,
    },
    coeffs
  );
}

/** Parse a systemd byte value (`10G`, `512M`, `1073741824`) to bytes; `null` if unparseable.
 *  Used by the Task 3 drift test to read the shipped daemon unit's `MemoryHigh`. */
export function parseSystemdBytes(value: string): number | null {
  const m = value.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?)i?B?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toUpperCase();
  const mult: Record<string, number> = {
    "": 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
  };
  return n * (mult[unit] ?? 1);
}

/** Read the shipped daemon unit's `MemoryHigh` (bytes) from a systemd unit file; `null`
 *  when the file or key is absent. The drift test clamps a tier's `max` against
 *  `formula(min(tier memory, this))` because a provisioned Pro/Ultra VM's daemon reads
 *  this limit via `constrainedMemory()`, not its 16/24 GB shape. */
export function readDaemonUnitMemoryHigh(unitFilePath: string): number | null {
  try {
    const text = readFileSync(unitFilePath, "utf8");
    const m = text.match(/^\s*MemoryHigh\s*=\s*(\S+)\s*$/m);
    return m ? parseSystemdBytes(m[1]) : null;
  } catch {
    return null;
  }
}
