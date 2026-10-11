// SPDX-License-Identifier: AGPL-3.0-only
/**
 * VM tier menu — the web-side reader of `scripts/lib/vm-tiers.json`, the SINGLE
 * SOURCE OF TRUTH shared with `resolve_vm_tier()` in
 * `scripts/lib/provision-helpers.sh` (bash/jq).
 *
 * Issue #2470 (epic #2467 Sub C), expert review R23: the panel consumes the tier
 * data via a BUILD-TIME relative import — deliberately NOT a #2469 fetch endpoint
 * — so the tier specs + `est_monthly_usd` values freeze at build until the next
 * deploy. This module is the ONE place the cross-package path is spelled; every
 * consumer imports the typed, camelCased exports below rather than re-reaching
 * into `scripts/`.
 */
import rawTiers from "../../../scripts/lib/vm-tiers.json";

/** Tier ids in menu order (mirrors `VM_TIERS` in server jobModel.ts + JSON key order). */
export const VM_TIER_IDS = ["ultra", "pro", "standard", "lite"] as const;
export type VmTierId = (typeof VM_TIER_IDS)[number];

/** A tier's resolved compute shape + monthly ballpark, camelCased from the JSON. */
export interface VmTierSpec {
  id: VmTierId;
  label: string;
  ocpus: number;
  memoryGb: number;
  bootVolumeGb: number;
  estMonthlyUsd: number;
  // #4417: per-tier recommended (warn-at) / maximum (refuse-at) open-session counts,
  // measured by the phase-2 load test
  // (docs/internal/research/issue-4417-machine-spec-load-test.md).
  recommendedSessions: number;
  maxSessions: number;
}

/**
 * #4417: the published machine minimum / recommended, ONE machine-readable copy that the
 * installer doctor's drift test, the install guide (#3987) and the capability matrix
 * (#4353) all check against. Values come from the phase-2 load-test record.
 */
export interface MachineSpec {
  cpus: number;
  memoryGb: number;
  diskGb: number;
  openSessions: number;
}

type RawTierSpec = {
  label: string;
  ocpus: number;
  memory_gb: number;
  boot_volume_gb: number;
  est_monthly_usd: number;
  recommended_sessions: number;
  max_sessions: number;
};

type RawMachineSpec = {
  cpus: number;
  memory_gb: number;
  disk_gb: number;
  open_sessions: number;
};

const rawTierMap = rawTiers.tiers as Record<VmTierId, RawTierSpec>;

function toMachineSpec(raw: RawMachineSpec): MachineSpec {
  return {
    cpus: raw.cpus,
    memoryGb: raw.memory_gb,
    diskGb: raw.disk_gb,
    openSessions: raw.open_sessions,
  };
}

/** The published machine minimum (#4417). */
export const MACHINE_MINIMUM: MachineSpec = toMachineSpec(
  rawTiers.machine_minimum as RawMachineSpec
);

/** The published machine recommendation (#4417). */
export const MACHINE_RECOMMENDED: MachineSpec = toMachineSpec(
  rawTiers.machine_recommended as RawMachineSpec
);

/** Typed, camelCased tier specs, in menu order. */
export const VM_TIERS: VmTierSpec[] = VM_TIER_IDS.map(id => {
  const t = rawTierMap[id];
  return {
    id,
    label: t.label,
    ocpus: t.ocpus,
    memoryGb: t.memory_gb,
    bootVolumeGb: t.boot_volume_gb,
    estMonthlyUsd: t.est_monthly_usd,
    recommendedSessions: t.recommended_sessions,
    maxSessions: t.max_sessions,
  };
});

/** The provisioner's default tier (`pro`) — pre-selected in the form. */
export const DEFAULT_TIER_ID = rawTiers.default_tier as VmTierId;

export function getTier(id: VmTierId): VmTierSpec {
  const spec = VM_TIERS.find(t => t.id === id);
  if (!spec) throw new Error(`unknown VM tier: ${id}`);
  return spec;
}

/**
 * Absolute OCI Always-Free A1 caps. Budget guard v1 is caps-only (issue #2470,
 * expert review R07) — there is no fleet-usage math because no fleet-shape data
 * source exists (inventory records carry no shape fields). A future fleet-aware
 * guard would relax these against live tenancy capacity.
 */
export const OCI_FREE_TIER_CAPS = {
  ocpus: 4,
  memoryGb: 24,
  bootVolumeGb: 200,
} as const;

export interface VmShape {
  ocpus: number;
  memoryGb: number;
  bootVolumeGb: number;
}

export interface BudgetCheck {
  ok: boolean;
  violations: string[];
}

/**
 * Pure budget guard: does a REQUESTED shape exceed the absolute free-tier caps?
 * Returns every violated dimension so the form can render an explicit hint.
 * Kept pure + exported so it is unit-testable in isolation (AC-5).
 *
 * Note: the `ultra` tier's 256 GB boot volume EXCEEDS the 200 GB free-tier
 * block-storage cap, so selecting it trips this guard by design — Ultra is a
 * paid shape the caps-only v1 cannot green-light.
 */
export function checkBudget(shape: VmShape): BudgetCheck {
  const violations: string[] = [];
  if (shape.ocpus > OCI_FREE_TIER_CAPS.ocpus) {
    violations.push(
      `${shape.ocpus} OCPUs exceeds the free-tier cap of ${OCI_FREE_TIER_CAPS.ocpus}`
    );
  }
  if (shape.memoryGb > OCI_FREE_TIER_CAPS.memoryGb) {
    violations.push(
      `${shape.memoryGb} GB memory exceeds the free-tier cap of ${OCI_FREE_TIER_CAPS.memoryGb} GB`
    );
  }
  if (shape.bootVolumeGb > OCI_FREE_TIER_CAPS.bootVolumeGb) {
    violations.push(
      `${shape.bootVolumeGb} GB boot volume exceeds the free-tier block-storage cap of ${OCI_FREE_TIER_CAPS.bootVolumeGb} GB`
    );
  }
  return { ok: violations.length === 0, violations };
}
