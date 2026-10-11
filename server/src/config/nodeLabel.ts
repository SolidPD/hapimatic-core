// SPDX-License-Identifier: AGPL-3.0-only
import { displayNodeLabel, isCloudNodeUrl } from "@hapi/protocol";

/**
 * Node-label casing for THIS node (epic #3285 round 11, 2026-09-07):
 * local machines UPPER CASE, cloud VMs lower case — `displayNodeLabel` with the
 * server-side knowledge of whether the host is a cloud VM.
 *
 * A federated cloud VM is recognizable by its `selfUrl` (provision.sh seeds
 * `https://<subdomain>.hapimatic.com`). A STANDALONE cloud VM (federation
 * disabled — every freshly-provisioned customer VM) has no URL to classify by,
 * but every gateway-managed VM runs with `HAPI_GOOGLE_HANDOFF_AUD` in its
 * service env (provision.sh Phase 7; read by `configuration.ts` as
 * `handoffAudience`), and no local machine does — so its presence is the
 * cloud signal for the standalone case.
 */
export function isCloudHostEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HAPI_GOOGLE_HANDOFF_AUD?.trim());
}

export function localNodeDisplayLabel(
  label: string,
  selfUrl?: string | null,
  env: NodeJS.ProcessEnv = process.env
): string {
  return displayNodeLabel(label, {
    cloud: isCloudNodeUrl(selfUrl) || isCloudHostEnv(env),
  });
}
