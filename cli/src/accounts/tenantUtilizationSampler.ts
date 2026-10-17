// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The #3023 utilization sampler, re-hosted for a TENANT VM (issue #4349, Task 4(d)/(f), ruling D10).
 *
 * Off a tenant, the sampler rides the `TokenRefreshService` tick and reads each account's token
 * from the account store. A tenant runs no Hapimatic refresh service (native Claude Code rotates the
 * credential in its own dir) and its accounts are token-less `native` records, so here the sampler
 * runs on its OWN timer and reads each account's credential from its isolated `CLAUDE_CONFIG_DIR`
 * — read-only and VM-local, sent only to `api.anthropic.com` (the endpoint is pinned on a tenant,
 * utilizationSampler.ts). The daemon starts it only while `HAPI_TENANT_USAGE_READ` is not `0`; with
 * the kill switch at `0` the un-pinned spawn veto has no utilization data on that VM.
 */

import { SupervisedLoop, type JobRegistry } from "@hapi/protocol";
import type { AccountIndexEntry } from "@hapi/protocol/accounts";
import { readIsolatedCredentials } from "@/accounts/accountConfigDir";
import type { UtilizationSnapshot } from "@/accounts/selectHealthyAccount";
import {
  createUtilizationSampler,
  type FetchLike,
} from "@/accounts/utilizationSampler";

export const TENANT_SAMPLER_JOB_NAME = "tenant-utilization-sampler";
/** The re-hosted cadence; the sampler's own per-account throttle (90s) still bounds the fetches. */
export const TENANT_SAMPLER_INTERVAL_MS = 60_000;

export interface TenantSamplerDeps {
  accountStore: {
    list(): Promise<AccountIndexEntry[]>;
    setUtilizationSnapshot(uuid: string, snapshot: UtilizationSnapshot): void;
    getUtilizationSnapshot(uuid: string): UtilizationSnapshot | undefined;
  };
  registry?: JobRegistry;
  node: string;
  /** Test seams. */
  readToken?: (accountUuid: string) => Promise<string | null>;
  fetchImpl?: FetchLike;
  intervalMs?: number;
}

/** Build (not start) the tenant sampler loop. */
export function createTenantUtilizationSampler(
  deps: TenantSamplerDeps
): SupervisedLoop {
  const sample = createUtilizationSampler({
    // A tenant account's credential lives ONLY in its own isolated dir — never the store.
    readAccessToken:
      deps.readToken ??
      (async uuid =>
        (await readIsolatedCredentials(uuid).catch(() => null))?.accessToken ??
        null),
    writeSnapshot: (uuid, snapshot) =>
      deps.accountStore.setUtilizationSnapshot(uuid, snapshot),
    readSnapshot: uuid => deps.accountStore.getUtilizationSnapshot(uuid),
    fetchImpl: deps.fetchImpl,
  });
  return new SupervisedLoop({
    name: TENANT_SAMPLER_JOB_NAME,
    node: deps.node,
    intervalMs: deps.intervalMs ?? TENANT_SAMPLER_INTERVAL_MS,
    registry: deps.registry,
    tick: async () => {
      const entries = (await deps.accountStore.list()).filter(
        e => (e.provider ?? "anthropic") === "anthropic"
      );
      await sample(entries);
    },
  });
}
