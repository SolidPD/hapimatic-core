// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The cloud-VM class markers and the ONE tenant rule (K13), shared by every
 * reader so there is a single notion of "tenant" (epic #4348 I1).
 *
 * `scripts/provision.sh` Phase 9.7 writes `~/.config/hapimatic/vm-tier` on
 * EVERY provisioned VM (operator and customer alike, #2693), so the size-tier
 * marker alone is not a tenant signal. #4349 Task 3 adds the class marker
 * `~/.config/hapimatic/vm-class` (`operator` | `tenant`) beside it. A VM is a
 * tenant when the tier marker is present AND its class is not `operator`: a
 * missing or unreadable class fails closed to tenant. A marker-less host (RP1,
 * a dev host, a self-hosted Core, an SPD-registered local instance) is never a
 * tenant.
 *
 * The paths are relative to the account's home folder so a shell reader can
 * join them to `$HOME`. #4373's generated export scripts render them from here.
 * The Node reader #4349 adds (`isTenantVm()`, which reads the files) applies the
 * same rule: values compared without regard to case, and `HAPI_VM_TIER` /
 * `HAPI_VM_CLASS` override the markers (tests and dev hosts), so one notion of
 * "tenant" holds in both places.
 *
 * A customer with sudo can delete or rewrite their own markers. That changes
 * only Hapimatic's behavior on their own machine, never what the gateway
 * decides (#4349).
 *
 * NODE-FREE: imported into the browser bundle through the barrel, so no
 * `node:*` import here.
 */

/** The size-tier marker, relative to the home folder (#2693, written on every VM). */
export const VM_TIER_MARKER_REL = ".config/hapimatic/vm-tier";

/** The class marker, relative to the home folder (#4349 Task 3(a)). */
export const VM_CLASS_MARKER_REL = ".config/hapimatic/vm-class";

/** The class marker value of an operator-owned VM. Any other value, or none, is a tenant. */
export const VM_CLASS_OPERATOR = "operator";

/** Env overrides of the two markers (tests and dev hosts), read before the files. */
export const VM_TIER_ENV = "HAPI_VM_TIER";
export const VM_CLASS_ENV = "HAPI_VM_CLASS";

/**
 * K13: is this a tenant VM, given the two markers' contents (`undefined` when a
 * marker is absent)? Whitespace around a value and its case are ignored, and a
 * tier marker that is present but empty counts as absent.
 */
export function isTenantVmFromMarkers(
  tier: string | undefined,
  vmClass: string | undefined
): boolean {
  if (tier === undefined || tier.trim() === "") return false;
  return (vmClass ?? "").trim().toLowerCase() !== VM_CLASS_OPERATOR;
}
