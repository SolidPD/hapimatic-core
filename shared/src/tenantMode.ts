// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  VM_CLASS_ENV,
  VM_CLASS_MARKER_REL,
  VM_TIER_ENV,
  VM_TIER_MARKER_REL,
  isTenantVmFromMarkers,
} from "./vmClass";

/**
 * Tenant-VM detection for `cli` and `server` — the Node-side reader of the markers (issue #4349,
 * E6 Sub A, contract K13). The rule itself, the marker paths and the env override names live in
 * `./vmClass` (#4373), the single predicate every reader shares; this module only reads the files
 * and the env and hands them to it. Node-only: import it as `@hapi/protocol/tenantMode`, never from
 * the package root, so the web bundle never pulls in `node:fs`.
 *
 * A TENANT VM is a customer's cloud VM. On one, Hapimatic must not run its own provider OAuth flow,
 * copy a provider credential into its account store, seed or inject one, or refresh one: the
 * customer signs in inside the VM through each harness's own flow (Anthropic's hosting terms).
 *
 *   isTenantVm() = the vm-tier marker is present AND the vm-class marker is not `operator`
 *
 * provision.sh Phase 9.7 writes both markers under `~/.config/hapimatic/`. The tier marker alone is
 * NOT a tenant signal: it is written on EVERY cloud VM, operator VMs such as ms1 included. The class
 * marker is `operator` only for a subdomain on scripts/lib/operator-subdomains.txt, so an absent or
 * unreadable class marker on a tier-marked VM reads as a tenant (fail closed). A host with no tier
 * marker — RP1, a dev host, a worktree instance, an admin-registered local instance (#3990/#3991) —
 * is never a tenant.
 *
 * A customer with sudo can rewrite their own markers. That only changes Hapimatic's behaviour on
 * their own machine: what SPD's gateway accepts is decided by the gateway's own registry
 * (gateway/src/lib/instanceClass.ts), never by these markers.
 */

/** `~/.config/hapimatic/vm-tier` — the VM size tier (provision.sh Phase 9.7). */
export function vmTierMarkerPath(): string {
  return join(homedir(), VM_TIER_MARKER_REL);
}

/** `~/.config/hapimatic/vm-class` — `operator` | `tenant` (provision.sh Phase 9.7, #4349). */
export function vmClassMarkerPath(): string {
  return join(homedir(), VM_CLASS_MARKER_REL);
}

/** A marker file's whole contents, trimmed and lowercased; undefined when absent or empty. */
function readMarker(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim().toLowerCase();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the VM's persisted tier. Env `HAPI_VM_TIER` overrides (tests / dev). A missing marker →
 * undefined: dev and worktree instances and non-cloud hosts have no VM tier. `markerPath` is a
 * test seam; production callers pass nothing.
 */
export function readVmTier(
  markerPath: string = vmTierMarkerPath()
): string | undefined {
  const env = process.env[VM_TIER_ENV]?.trim().toLowerCase();
  if (env) return env;
  return readMarker(markerPath);
}

/**
 * Read the VM's persisted class (`operator` | `tenant` as written); undefined when absent. Env
 * `HAPI_VM_CLASS` overrides, exactly as `HAPI_VM_TIER` overrides the tier (tests / dev): the test
 * runners set `HAPI_VM_CLASS=operator` so a suite never depends on the markers of the host that
 * runs it. It grants nothing new — a customer with sudo can already rewrite their own markers,
 * which changes only Hapimatic's behaviour on their own machine; the gateway never consults it.
 */
export function readVmClass(
  markerPath: string = vmClassMarkerPath()
): string | undefined {
  const env = process.env[VM_CLASS_ENV]?.trim().toLowerCase();
  if (env) return env;
  return readMarker(markerPath);
}

/** Marker-path seams for {@link isTenantVm} (tests only). */
export interface TenantMarkerPaths {
  tierMarkerPath?: string;
  classMarkerPath?: string;
}

/**
 * True on a TENANT VM: the tier marker is present (or `HAPI_VM_TIER` is set) and the class marker
 * is not `operator` — the K13 rule in `isTenantVmFromMarkers` (`./vmClass`). Reads the markers on
 * every call (two small files), so a backfilled class marker takes effect without a restart
 * wherever the predicate is evaluated per use.
 */
export function isTenantVm(paths: TenantMarkerPaths = {}): boolean {
  return isTenantVmFromMarkers(
    readVmTier(paths.tierMarkerPath),
    readVmClass(paths.classMarkerPath)
  );
}

/**
 * The live Anthropic usage endpoint. On a tenant VM every usage/pacing reader is PINNED to it
 * (ruling D10): `HAPI_UTILIZATION_ENDPOINT` and any other override are ignored there, so an
 * account's credential is never sent anywhere but `api.anthropic.com`.
 */
export const ANTHROPIC_OAUTH_USAGE_URL =
  "https://api.anthropic.com/api/oauth/usage";

/**
 * Ruling D10 (#4349, OPERATOR-ATTENTION — #4003 counsel may reverse it): whether Hapimatic may use
 * an account's credential read-only and VM-locally for usage/pacing and the model catalog. Always
 * true off a tenant. On a tenant it is true unless `HAPI_TENANT_USAGE_READ=0`, the tenant kill
 * switch that turns every such reader off (the usage panel, the model-catalog read and the #3023
 * spawn-veto sampler — so the un-pinned spawn veto has no data on that VM).
 */
export function providerUsageReadAllowed(
  env: Record<string, string | undefined> = process.env,
  tenant: boolean = isTenantVm()
): boolean {
  if (!tenant) return true;
  return env.HAPI_TENANT_USAGE_READ?.trim() !== "0";
}
